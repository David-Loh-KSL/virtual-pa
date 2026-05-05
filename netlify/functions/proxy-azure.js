// netlify/functions/proxy-azure.js
// Proxies requests to Azure OpenAI GPT-5.4

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  const AZURE_KEY = process.env.AZURE_OPENAI_KEY;
  const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "https://kaiva-dev-az-openai.openai.azure.com";
  const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-5.4";
  const AZURE_API_VERSION = "2025-01-01-preview";

  if (!AZURE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "AZURE_OPENAI_KEY not set" }) };
  }

  const url = `${AZURE_ENDPOINT}/openai/deployments/${AZURE_DEPLOYMENT}/chat/completions?api-version=${AZURE_API_VERSION}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_KEY
      },
      body: event.body
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
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
