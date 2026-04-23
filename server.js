// server.js - Coolify/self-hosted proxy for Notion API
// Run: node server.js
// Set environment variable: NOTION_TOKEN=your_token

import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

if (!NOTION_TOKEN) {
  console.error("❌ NOTION_TOKEN environment variable is required");
  process.exit(1);
}

// Serve the built React app
app.use(express.static(path.join(__dirname, "dist")));

// Proxy /api/notion/* → https://api.notion.com/v1/*
app.use("/api/notion", createProxyMiddleware({
  target: "https://api.notion.com",
  changeOrigin: true,
  pathRewrite: { "^/api/notion": "/v1" },
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.setHeader("Authorization", `Bearer ${NOTION_TOKEN}`);
      proxyReq.setHeader("Notion-Version", "2022-06-28");
    }
  }
}));

// Fallback to React app for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ Virtual PA server running on port ${PORT}`);
});
