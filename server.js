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

// Fallback to React app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Virtual PA running on port ${PORT}`);
});
