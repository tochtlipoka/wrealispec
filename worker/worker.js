// Wrealispec · servidor intermedio para la IA (Cloudflare Worker)
// Guarda en secreto la llave de Claude (ANTHROPIC_API_KEY) y la de Google para la voz (GOOGLE_TTS_KEY),
// y solo acepta las tareas de Wrealispec que vienen de wrealispec.com.

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

// Voz natural de Google (Text-to-Speech). La llave va en el secreto GOOGLE_TTS_KEY.
const TTS_VOICES = {
  "us-f": { languageCode: "en-US", name: "en-US-Neural2-F" },
  "us-m": { languageCode: "en-US", name: "en-US-Neural2-D" },
  "uk-f": { languageCode: "en-GB", name: "en-GB-Neural2-A" },
  "uk-m": { languageCode: "en-GB", name: "en-GB-Neural2-B" },
};
const TTS_MAX_CHARS = 9000;   // historia completa (se parte en pedazos para Google)
const TTS_CHUNK_CHARS = 2500; // tamaño de cada pedazo

// ---------- Límite diario de uso (protege el gasto de IA y voz) ----------
// Se cuenta por persona (dirección IP convertida en un código irreversible; la IP no se guarda)
// y en total para todo el sitio. Los contadores viven en la base D1 enlazada como "DB" y se
// reinician cada día a medianoche de la Ciudad de México. Se pueden cambiar sin tocar el código
// con variables del Worker (Settings → Variables): DAILY_AI_PER_PERSON, DAILY_TTS_PER_PERSON,
// DAILY_AI_TOTAL y DAILY_TTS_TOTAL.
const LIMIT_DEFAULTS = {
  DAILY_AI_PER_PERSON: 40,   // una clase completa usa ~10-15 llamadas
  DAILY_TTS_PER_PERSON: 30,  // audios con voz natural de Google
  DAILY_AI_TOTAL: 1500,      // tope de todo el sitio por día (red de seguridad)
  DAILY_TTS_TOTAL: 1000,
};
const KEEP_DAYS = 2; // los contadores viejos se borran solos

export default {
  async fetch(request, env, ctx) {
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
    let body;
    try { body = await request.json(); } catch (e) { return reply({ error: "bad_request" }, 400, cors); }

    if (body.tts) {
      const q = await useQuota(request, env, ctx, "tts");
      if (q) return reply({ error: q }, 429, cors);
      return tts(body.tts, env, cors);
    }
    if (!env.ANTHROPIC_API_KEY) return reply({ error: "not_configured" }, 500, cors);

    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt || prompt.length > MAX_PROMPT_CHARS || !ALLOWED_PROMPT_STARTS.some((s) => prompt.startsWith(s))) {
      return reply({ error: "bad_request" }, 400, cors);
    }

    // Se cuenta antes de llamar a la IA: si ya se llegó al límite, no se gasta nada.
    const q = await useQuota(request, env, ctx, "ai");
    if (q) return reply({ error: q }, 429, cors);

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

// Convierte la historia en MP3 con una voz natural de Google. Devuelve el audio en base64.
async function tts(req, env, cors) {
  if (!env.GOOGLE_TTS_KEY) return reply({ error: "tts_not_configured" }, 500, cors);
  const text = typeof req.text === "string" ? req.text.trim() : "";
  const voice = TTS_VOICES[req.voice] || TTS_VOICES["us-f"];
  const rate = Math.min(1.2, Math.max(0.6, Number(req.rate) || 0.9));
  if (!text) return reply({ error: "tts_empty" }, 400, cors);
  if (text.length > TTS_MAX_CHARS) return reply({ error: "tts_too_long" }, 400, cors);

  // Google acepta hasta ~5,000 bytes por solicitud. Las historias largas se parten por oraciones,
  // se convierten por partes y los MP3 se unen en uno solo.
  let mp3 = "";
  for (const part of chunkText(text, TTS_CHUNK_CHARS)) {
    let r;
    try {
      r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { text: part }, voice, audioConfig: { audioEncoding: "MP3", speakingRate: rate } }),
      });
    } catch (e) {
      return reply({ error: "upstream_error" }, 502, cors);
    }
    if (r.status === 429) return reply({ error: "rate_limited" }, 429, cors);
    if (!r.ok) return reply({ error: "tts_error", status: r.status }, 502, cors);
    const data = await r.json();
    mp3 += atob(data.audioContent || "");
  }
  return reply({ audio: btoa(mp3) }, 200, cors);
}

function chunkText(text, max) {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const out = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > max) { // oración larguísima: se corta por espacios
      const cut = s.lastIndexOf(" ", max) > 0 ? s.lastIndexOf(" ", max) : max;
      if (cur) { out.push(cur); cur = ""; }
      out.push(s.slice(0, cut));
      s = s.slice(cut);
    }
    if ((cur + s).length > max) { out.push(cur); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out.map((c) => c.trim()).filter(Boolean);
}

// Suma 1 al contador de la persona y al total del día. Devuelve null si puede seguir,
// o el código de error si ya llegó al límite. Sin base de datos enlazada, no deja pasar
// (así nunca queda la IA abierta sin protección).
async function useQuota(request, env, ctx, kind) {
  if (!env.DB) return "limit_not_configured";
  const lim = (name) => {
    const v = parseInt(env[name], 10);
    return Number.isFinite(v) && v >= 0 ? v : LIMIT_DEFAULTS[name];
  };
  const perPerson = lim(kind === "tts" ? "DAILY_TTS_PER_PERSON" : "DAILY_AI_PER_PERSON");
  const total = lim(kind === "tts" ? "DAILY_TTS_TOTAL" : "DAILY_AI_TOTAL");

  const day = mxDay(0);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const who = await hash(`${ip}|${day}|${env.HASH_SALT || "wrealispec"}`);

  const sql = `INSERT INTO usage (day, who, kind, n) VALUES (?1, ?2, ?3, 1)
               ON CONFLICT(day, who, kind) DO UPDATE SET n = n + 1 RETURNING n`;
  let mine, all;
  try {
    const [a, b] = await env.DB.batch([
      env.DB.prepare(sql).bind(day, who, kind),
      env.DB.prepare(sql).bind(day, "*", kind),
    ]);
    mine = a.results[0].n;
    all = b.results[0].n;
  } catch (e) {
    return "limit_not_configured";
  }

  // De vez en cuando se borran los contadores de días anteriores.
  if (Math.random() < 0.02 && ctx && ctx.waitUntil) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM usage WHERE day < ?1").bind(mxDay(KEEP_DAYS)).run().catch(() => {}));
  }

  if (mine > perPerson) return "daily_limit";
  if (all > total) return "service_busy";
  return null;
}

// Fecha (AAAA-MM-DD) en la Ciudad de México, que está en UTC-6 todo el año.
function mxDay(daysAgo) {
  return new Date(Date.now() - 6 * 3600e3 - daysAgo * 86400e3).toISOString().slice(0, 10);
}

async function hash(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function reply(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}
