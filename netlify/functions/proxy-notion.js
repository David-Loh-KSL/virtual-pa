// netlify/functions/proxy-notion.js
// Proxies all Notion API requests to bypass CORS

export const handler = async (event) => {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;

  if (!NOTION_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "NOTION_TOKEN not set" }) };
  }

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
      },
      body: ""
    };
  }

  // Strip all known prefixes to get just the Notion API path
  // event.path could be:
  //   /.netlify/functions/proxy-notion/databases/xxx
  //   /api/proxy-notion/databases/xxx
  let apiPath = event.path
    .replace(/^\/.netlify\/functions\/proxy-notion/, "")
    .replace(/^\/api\/proxy-notion/, "");

  // Ensure it starts with /
  if (!apiPath.startsWith("/")) apiPath = "/" + apiPath;
  if (apiPath === "") apiPath = "/";

  const notionUrl = `https://api.notion.com/v1${apiPath}${event.rawQuery ? "?" + event.rawQuery : ""}`;

  console.log("Proxying to:", notionUrl);

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
