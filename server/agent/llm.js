// Minimal OpenAI-compatible chat-completions client using plain fetch.
// Configure with env vars so any provider works:
//   OPENAI_API_KEY   — API key
//   OPENAI_BASE_URL  — default https://api.openai.com/v1 (works with OpenAI,
//                      Azure OpenAI gateways, OpenRouter, Groq, LM Studio, Ollama, …)
//   OPENAI_MODEL     — default gpt-4o-mini

export function llmConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function llmInfo() {
  return {
    configured: llmConfigured(),
    base_url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  };
}

export async function chatCompletion({ messages, tools }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const body = { model, messages, temperature: 0.2 };
  if (tools && tools.length) body.tools = tools;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM API error ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('LLM API returned no choices');
  return {
    content: choice.message?.content || null,
    tool_calls: choice.message?.tool_calls || null,
    finish_reason: choice.finish_reason,
    usage: data.usage,
  };
}
