// netlify/functions/proxy-azure.js
// Proxies requests to Azure OpenAI GPT-5.4 via Responses API

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
  const AZURE_API_VERSION = "2025-04-01-preview";  // ← correct version for Responses API

  if (!AZURE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "AZURE_OPENAI_KEY not set" }) };
  }

  // Responses API endpoint (not /chat/completions)
  const url = `${AZURE_ENDPOINT}/openai/responses?api-version=${AZURE_API_VERSION}`;

  try {
    // Convert Chat Completions format → Responses API format
    const incoming = JSON.parse(event.body);
    const systemMsg = incoming.messages?.find(m => m.role === "system");
    const userMsgs = incoming.messages?.filter(m => m.role !== "system") || [];

    const requestBody = {
      model: AZURE_DEPLOYMENT,
      instructions: systemMsg?.content || "",
      input: userMsgs,
      max_output_tokens: incoming.max_tokens || 4096
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_KEY
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    // Convert Responses API format → Chat Completions format for the frontend
    if (data.output) {
      const textContent = data.output
        .filter(o => o.type === "message")
        .flatMap(o => o.content)
        .filter(c => c.type === "output_text")
        .map(c => c.text)
        .join("");

      const converted = {
        choices: [{
          message: { role: "assistant", content: textContent },
          finish_reason: "stop"
        }],
        usage: data.usage
      };

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(converted)
      };
    }

    // Pass through as-is if unexpected format
    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
