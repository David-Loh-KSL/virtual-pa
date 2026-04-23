// netlify/functions/notion.js
// Proxies all Notion API requests to bypass CORS
// Environment variable required: NOTION_TOKEN

export const handler = async (event) => {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;

  if (!NOTION_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "NOTION_TOKEN not set" }) };
  }

  // Extract the Notion API path from the request
  // e.g. /api/notion/databases/xxx -> /v1/databases/xxx
  const path = event.path.replace("/.netlify/functions/notion", "").replace("/api/notion", "") || "/";
  const notionUrl = `https://api.notion.com/v1${path}${event.rawQuery ? "?" + event.rawQuery : ""}`;

  const headers = {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };

  try {
    const response = await fetch(notionUrl, {
      method: event.httpMethod,
      headers,
      body: event.body && event.httpMethod !== "GET" ? event.body : undefined
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
