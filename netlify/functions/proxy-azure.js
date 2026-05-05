// netlify/functions/proxy-azure.js
// Proxies requests to Azure OpenAI GPT-5.4 using Responses API

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
  const AZURE_API_VERSION = "2025-04-01-preview";

  if (!AZURE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "AZURE_OPENAI_KEY not set" }) };
  }

  try {
    const body = JSON.parse(event.body);

    // GPT-5.4 uses the Responses API - convert from chat completions format
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

    // Use Responses API endpoint
    const url = `${AZURE_ENDPOINT}/openai/responses?api-version=${AZURE_API_VERSION}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": AZURE_KEY
      },
      body: JSON.stringify(responsesBody)
    });

    const data = await response.json();

    // Convert Responses API format back to Chat Completions format for the app
    let content = "";
    if (data.output) {
      // Extract text from output array
      const textItems = data.output.filter(o => o.type === "message" || o.type === "text");
      for (const item of textItems) {
        if (item.content) {
          for (const c of item.content) {
            if (c.type === "output_text" || c.type === "text") content += c.text || "";
          }
        } else if (item.text) {
          content += item.text;
        }
      }
    } else if (data.choices) {
      // Already in chat completions format
      content = data.choices[0]?.message?.content || "";
    }

    // Return in chat completions format so app code doesn't need to change
    return {
      statusCode: response.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        choices: [{ message: { content: content || data.error?.message || "No response" } }],
        _raw: data // include raw for debugging
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
