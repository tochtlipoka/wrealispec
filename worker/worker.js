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
  "You are the whiteboard teacher of Wrealispec",
];

const MODEL = "claude-haiku-5-5";
// Para pronunciación y pizarra se usa un modelo más preciso: explicar sonidos exige más cuidado.
const MODEL_PRECISE = "claude-sonnet-5-5";
const PRECISE_PROMPT_STARTS = [
  "You are a pronunciation coach for Wrealispec",
  "You are the whiteboard teacher of Wrealispec",
];
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
  "es-f": { languageCode: "es-US", name: "es-US-Neural2-A" }, // voz en español para explicar en la pizarra
};
const TTS_MAX_CHARS = 9000;   // historia completa (se parte en pedazos para Google)
const TTS_CHUNK_CHARS = 2500; // tamaño de cada pedazo

// ---------- Límite diario de uso (protege el gasto de IA y voz) ----------
// Se cuenta por persona (dirección IP convertida en un código irreversible; la IP no se guarda)
// y en total para todo el sitio. Los contadores viven en la base D1 enlazada como "DB" y se
// reinician cada día a medianoche de la Ciudad de México. Se pueden cambiar sin tocar el código
// con variables del Worker (Settings → Variables), p. ej. DAILY_AI_PER_PERSON o DAILY_TTS_TOTAL.
const LIMIT_DEFAULTS = {
  DAILY_AI_PER_PERSON: 80,      // una clase completa con conversación usa ~20-25 llamadas
  DAILY_TTS_PER_PERSON: 150,    // audios con voz natural (historia, pizarra, retos y conversación)
  DAILY_SAMPLE_PER_PERSON: 20,  // frases de prueba al elegir la voz
  DAILY_AI_TOTAL: 3000,         // topes de todo el sitio por día (red de seguridad)
  DAILY_TTS_TOTAL: 4000,
  DAILY_SAMPLE_TOTAL: 2000,
  DAILY_STT_PER_PERSON: 80,     // grabaciones convertidas a texto (lectura y conversación)
  DAILY_STT_TOTAL: 3000,
};
const LIMIT_NAMES = {
  ai: ["DAILY_AI_PER_PERSON", "DAILY_AI_TOTAL"],
  tts: ["DAILY_TTS_PER_PERSON", "DAILY_TTS_TOTAL"],
  sample: ["DAILY_SAMPLE_PER_PERSON", "DAILY_SAMPLE_TOTAL"],
  stt: ["DAILY_STT_PER_PERSON", "DAILY_STT_TOTAL"],
};
// Voz a texto con Whisper en Cloudflare (Workers AI, enlazado como "AI"). No se guarda el audio.
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const STT_MAX_BASE64 = 9000000; // ~6.5 MB: unos 3 minutos de lectura en WAV de 16 kHz
// Frase que se oye al probar cada voz.
const SAMPLE_TEXT = "Hi! I'm the voice that will read your story. Let's practice together.";
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

    if (body.stt) {
      const q = await useQuota(request, env, ctx, "stt");
      if (q) return reply({ error: q }, 429, cors);
      return stt(body.stt, env, cors);
    }
    if (body.tts) {
      const isSample = body.tts.sample === true;
      const q = await useQuota(request, env, ctx, isSample ? "sample" : "tts");
      if (q) return reply({ error: q }, 429, cors);
      if (isSample) return tts({ text: SAMPLE_TEXT, voice: body.tts.voice, rate: 1 }, env, cors);
      if (Array.isArray(body.tts.sentences)) return ttsMarked(body.tts, env, cors);
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
    const model = PRECISE_PROMPT_STARTS.some((x) => prompt.startsWith(x)) ? MODEL_PRECISE : MODEL;
    const payload = { model, max_tokens: MAX_TOKENS, messages: [{ role: "user", content }] };
    if (wantJson) {
      payload.tools = [{
        name: "respond",
        description: "Send your answer as a JSON object with exactly the fields requested in the instructions.",
        input_schema: { type: "object", additionalProperties: true },
      }];
      payload.tool_choice = { type: "tool", name: "respond" };
    }

    const callClaude = (body) => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let upstream;
    try {
      upstream = await callClaude(payload);
      // Si el modelo preciso no responde (no disponible para la llave, saturado, etc.), se intenta con el rápido.
      if (!upstream.ok && model !== MODEL) {
        payload.model = MODEL;
        upstream = await callClaude(payload);
      }
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

// Convierte la lectura en voz alta del alumno en texto. El audio llega en base64 y no se guarda.
async function stt(req, env, cors) {
  if (!env.AI) return reply({ error: "stt_not_configured" }, 500, cors);
  const audio = typeof req.audio === "string" ? req.audio : "";
  if (!audio) return reply({ error: "stt_empty" }, 400, cors);
  if (audio.length > STT_MAX_BASE64) return reply({ error: "stt_too_long" }, 400, cors);
  let out;
  try {
    out = await env.AI.run(STT_MODEL, { audio, language: "en", task: "transcribe", vad_filter: true });
  } catch (e) {
    return reply({ error: "stt_error" }, 502, cors);
  }
  const text = String((out && out.text) || "").trim();
  return reply({ text }, 200, cors);
}

// Historia completa en un solo audio, con marcas invisibles al inicio de cada oración.
// Google devuelve en qué segundo empieza cada una, y así la app resalta, pausa y repite
// oración por oración sin pedir más audios. Las marcas no se cobran como caracteres.
async function ttsMarked(req, env, cors) {
  if (!env.GOOGLE_TTS_KEY) return reply({ error: "tts_not_configured" }, 500, cors);
  const voice = TTS_VOICES[req.voice] || TTS_VOICES["us-f"];
  const sents = req.sentences.filter((x) => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  if (!sents.length) return reply({ error: "tts_empty" }, 400, cors);
  const total = sents.reduce((n, x) => n + x.length, 0);
  if (sents.length > 150 || total > TTS_MAX_CHARS) return reply({ error: "tts_too_long" }, 400, cors);

  // Se agrupan oraciones completas en pedazos que Google acepte (máx. ~5,000 bytes por solicitud).
  const chunks = [];
  let cur = [], len = 0;
  for (let i = 0; i < sents.length; i++) {
    const e = xmlEscape(sents[i]);
    if (e.length > 4500) return reply({ error: "tts_too_long" }, 400, cors);
    if (cur.length && len + e.length > TTS_CHUNK_CHARS) { chunks.push(cur); cur = []; len = 0; }
    cur.push({ i, e });
    len += e.length + 20;
  }
  if (cur.length) chunks.push(cur);

  const segments = [];
  for (const chunk of chunks) {
    const ssml = "<speak>" + chunk.map((c) => `<mark name="s${c.i}"/>${c.e} `).join("") + "</speak>";
    let r;
    try {
      r = await fetch(`https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${env.GOOGLE_TTS_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { ssml },
          voice,
          audioConfig: { audioEncoding: "MP3", speakingRate: 1 },
          enableTimePointing: ["SSML_MARK"],
        }),
      });
    } catch (e) {
      return reply({ error: "upstream_error" }, 502, cors);
    }
    if (r.status === 429) return reply({ error: "rate_limited" }, 429, cors);
    if (!r.ok) return reply({ error: "tts_error", status: r.status }, 502, cors);
    const data = await r.json();
    const marks = (data.timepoints || [])
      .map((t) => ({ i: Number(String(t.markName || "").slice(1)), t: Number(t.timeSeconds) || 0 }))
      .filter((m) => Number.isInteger(m.i));
    segments.push({ audio: data.audioContent || "", first: chunk[0].i, last: chunk[chunk.length - 1].i, marks });
  }
  return reply({ segments }, 200, cors);
}

function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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
  const [personName, totalName] = LIMIT_NAMES[kind] || LIMIT_NAMES.ai;
  const perPerson = lim(personName);
  const total = lim(totalName);

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
