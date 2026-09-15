import { getApiKey, hasApiKey } from './env.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 90_000;

function authHeaders() {
  const key = getApiKey();
  if (!key) {
    const err = new Error('Falta OPENROUTER_API_KEY');
    err.status = 400;
    throw err;
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:3847',
    'X-Title': 'Sophistaí',
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function requireApiKey() {
  if (!hasApiKey()) {
    const err = new Error('Configura la API key de OpenRouter primero');
    err.status = 400;
    throw err;
  }
}

export async function listModels(query = '') {
  requireApiKey();
  const res = await fetchWithTimeout(`${OPENROUTER_BASE}/models`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`OpenRouter models: ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  let models = Array.isArray(data.data) ? data.data : [];
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    models = models.filter((m) => {
      const id = String(m.id || '').toLowerCase();
      const name = String(m.name || '').toLowerCase();
      return id.includes(q) || name.includes(q);
    });
  }
  return models.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    context_length: m.context_length ?? null,
    pricing: m.pricing ?? null,
  }));
}

export function buildSystemPrompt({ mentorName, language }) {
  const respondIn =
    language === 'en' ? 'Respond in English.' : 'Respond in Spanish.';
  return [
    `You are ${mentorName}, a participant in a mentorship room.`,
    'Several people are conversing in the same room. Reply in the first person as yourself.',
    'Do not say you are an AI model, a language model, or software.',
    'Do not mention competing AI companies, or model brands.',
    'Treat everyone in the transcript as people in the room.',
    'Be concise, thoughtful, and helpful. Offer one clear opinion or piece of advice.',
    respondIn,
  ].join(' ');
}

/**
 * Build a shared room transcript so every mentor sees the same conversation.
 */
export function buildRoomTranscript(messages) {
  const lines = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`User: ${msg.content}`);
    } else {
      const name = msg.mentor_name || 'Mentor';
      lines.push(`${name}: ${msg.content}`);
    }
  }
  return lines.join('\n\n');
}

export async function chatCompletion({
  model,
  mentorName,
  language,
  messages,
}) {
  requireApiKey();
  const system = buildSystemPrompt({ mentorName, language });
  const transcript = buildRoomTranscript(messages);
  const userContent = transcript
    ? `Here is the conversation so far in the mentorship room:\n\n${transcript}\n\nNow reply as ${mentorName} with your next contribution.`
    : `The mentorship room is just starting. Reply as ${mentorName} with your opening contribution.`;

  const res = await fetchWithTimeout(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`OpenRouter chat (${model}): ${res.status} ${text}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') {
    throw new Error(`Respuesta vacía de ${model}`);
  }
  return content.trim();
}
