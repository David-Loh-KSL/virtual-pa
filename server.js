// server.js - Express proxy for Coolify deployment
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

if (!NOTION_TOKEN) { console.error("❌ NOTION_TOKEN required"); process.exit(1); }
if (!ANTHROPIC_KEY) { console.error("❌ ANTHROPIC_API_KEY required"); process.exit(1); }

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "dist")));

// CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Notion proxy — /api/proxy-notion/* → https://api.notion.com/v1/*
app.all("/api/proxy-notion/*", async (req, res) => {
  const apiPath = req.path.replace("/api/proxy-notion", "");
  const notionUrl = `https://api.notion.com/v1${apiPath}${req.url.includes("?") ? "?" + req.url.split("?")[1] : ""}`;
  console.log(`Notion: ${req.method} ${notionUrl}`);
  try {
    const response = await fetch(notionUrl, {
      method: req.method,
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: req.method !== "GET" ? JSON.stringify(req.body) : undefined
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Claude proxy — /api/proxy-claude → https://api.anthropic.com/v1/messages
app.post("/api/proxy-claude", async (req, res) => {
  console.log("Claude API call");
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Azure OpenAI proxy — /api/proxy-azure (uses Responses API for GPT-5.4)
app.post("/api/proxy-azure", async (req, res) => {
  const AZURE_KEY = process.env.AZURE_OPENAI_KEY;
  const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "https://kaiva-dev-az-openai.openai.azure.com";
  const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.4";
  const AZURE_API_VERSION = "2025-04-01-preview";

  if (!AZURE_KEY) { res.status(500).json({ error: "AZURE_OPENAI_KEY not set" }); return; }

  console.log("Azure GPT-5.4 Responses API call");
  try {
    const body = req.body;
    const systemMsg = body.messages?.find(m => m.role === "system");
    const userMsgs = body.messages?.filter(m => m.role !== "system") || [];

    const responsesBody = {
      model: AZURE_DEPLOYMENT,
      input: userMsgs.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.find(c => c.type === "text")?.text || "" : "")
      })),
      ...(systemMsg ? { instructions: systemMsg.content } : {}),
      max_output_tokens: body.max_tokens || 2000,
    };

    const url = `${AZURE_ENDPOINT}/openai/responses?api-version=${AZURE_API_VERSION}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": AZURE_KEY },
      body: JSON.stringify(responsesBody)
    });
    const data = await response.json();
    console.log("Azure response status:", response.status);

    // Extract text content from Responses API output
    let content = "";
    if (data.output) {
      for (const item of data.output) {
        if (item.content) {
          for (const c of item.content) {
            if (c.type === "output_text" || c.type === "text") content += c.text || "";
          }
        } else if (item.text) content += item.text;
      }
    } else if (data.choices) {
      content = data.choices[0]?.message?.content || "";
    }

    res.status(response.status).json({
      choices: [{ message: { content: content || data.error?.message || "No response" } }]
    });
  } catch(e) {
    console.error("Azure proxy error:", e);
    res.status(500).json({ error: e.message });
  }
});

// Fallback to React app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Virtual PA running on port ${PORT}`);
});
