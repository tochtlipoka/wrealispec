// Wrealispec · servidor intermedio para la IA (Cloudflare Worker)
// Guarda la llave de la API de Claude en secreto (ANTHROPIC_API_KEY) y solo acepta
// las tareas de Wrealispec que vienen de wrealispec.com.

const ALLOWED_ORIGINS = [
  "https://wrealispec.com",
  "https://www.wrealispec.com",
  "https://tochtlipoka.github.io",
  // Mientras se activa HTTPS en GitHub Pages:
  "http://wrealispec.com",
  "http://www.wrealispec.com",
];

// Solo se aceptan las instrucciones fijas de Wrealispec (corrección, lectura, ejercicios, retell).
const ALLOWED_PROMPT_STARTS = [
  "You are the writing corrector of Wrealispec",
  "You are a pronunciation coach for Wrealispec",
  "Create 5 short listening exercises about this story",
  "You are an English tutor for Wrealispec",
];

const MODEL = "claude-haiku-5-5";
const MAX_TOKENS = 6000;
const MAX_PROMPT_CHARS = 15000;
const MAX_IMAGE_BASE64 = 7000000; // ~5 MB
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST" || !allowed) return reply({ error: "forbidden" }, 403, cors);
    if (!env.ANTHROPIC_API_KEY) return reply({ error: "not_configured" }, 500, cors);

    let body;
    try { body = await request.json(); } catch (e) { return reply({ error: "bad_request" }, 400, cors); }

    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt || prompt.length > MAX_PROMPT_CHARS || !ALLOWED_PROMPT_STARTS.some((s) => prompt.startsWith(s))) {
      return reply({ error: "bad_request" }, 400, cors);
    }

    const content = [];
    if (body.image) {
      const { media_type, data } = body.image;
      if (!IMAGE_TYPES.includes(media_type) || typeof data !== "string" || data.length > MAX_IMAGE_BASE64) {
        return reply({ error: "image_rejected" }, 400, cors);
      }
      content.push({ type: "image", source: { type: "base64", media_type, data } });
    }
    content.push({ type: "text", text: prompt });

    // Con json: true, la respuesta llega como un objeto ya estructurado (herramienta "respond"),
    // así no depende de que la IA escriba bien las comillas.
    const wantJson = body.json === true;
    const payload = { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: "user", content }] };
    if (wantJson) {
      payload.tools = [{
        name: "respond",
        description: "Send your answer as a JSON object with exactly the fields requested in the instructions.",
        input_schema: { type: "object", additionalProperties: true },
      }];
      payload.tool_choice = { type: "tool", name: "respond" };
    }

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return reply({ error: "upstream_error" }, 502, cors);
    }

    if (upstream.status === 429 || upstream.status === 529) return reply({ error: "rate_limited" }, 429, cors);
    if (!upstream.ok) return reply({ error: "upstream_error" }, 502, cors);

    const data = await upstream.json();
    const tool = (data.content || []).find((c) => c.type === "tool_use");
    if (wantJson && tool && tool.input && typeof tool.input === "object") {
      return reply({ json: tool.input, stop: data.stop_reason || "" }, 200, cors);
    }
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    return reply({ text, stop: data.stop_reason || "" }, 200, cors);
  },
};

function reply(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
