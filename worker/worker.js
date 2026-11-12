// Wrealispec · servidor intermedio para la IA (Cloudflare Worker) · v3
// Guarda en secreto la llave de Claude (ANTHROPIC_API_KEY) y la de Google para la voz (GOOGLE_TTS_KEY).
//
// Desde la v2 (nov 2026) las instrucciones de la IA viven AQUÍ, no en el navegador.
// La app solo manda el nombre de la tarea y los datos crudos del alumno, por ejemplo:
//   { "task": "corregir", "data": { "topic": "...", "level": "A2", "text": "..." }, "json": true }
// El Worker revisa cada dato (tipo y tamaño), arma la instrucción completa y llama a Claude.
// Así nadie puede usar este servidor para pedirle a la IA algo que no sea Wrealispec.

const ALLOWED_ORIGINS = [
  "https://wrealispec.com",
  "https://www.wrealispec.com",
];

const MODEL = "claude-haiku-5-5";
// Para pronunciación y pizarra se usa un modelo más preciso: explicar sonidos exige más cuidado.
const MODEL_PRECISE = "claude-sonnet-5-5";
const MAX_PROMPT_CHARS = 20000;  // instrucción ya armada (plantilla + datos del alumno)
const MAX_IMAGE_BASE64 = 7000000; // ~5 MB
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Regla que se agrega al final de todas las instrucciones (antes la ponía la app).
const JSON_RULE = "\n\nIMPORTANT: reply with valid JSON only. Inside text values never use double quotes; use «» or single quotes instead. Write all Spanish in Mexican Spanish, the way people speak in Mexico (for example «papas», not «patatas»; «ustedes», not «vosotros»; «computadora», not «ordenador»; «celular», not «móvil»).";

// Palabras meta por nivel (las historias de la IA son ~40% más largas).
const LEVELS = { A1:[40,60], A2:[60,100], B1:[100,150], B2:[150,220], C1:[220,300] };

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

// ======================================================================
//  Cuentas, planes y fases (desde la v3, nov 2026)
//  La app manda «Authorization: Bearer <token de Supabase>» si el alumno entró a su cuenta.
//  El Worker revisa el sello del token él solo, con las llaves públicas (JWKS) de Supabase,
//  sin preguntarle a Supabase en cada petición. El plan viaja dentro del token (dato «wplan»,
//  que agrega el Auth Hook public.claim_plan; ver supabase/planes.sql).
//
//  Interruptor AUTH_MODE (variable del panel de Cloudflare, sin desplegar):
//    off      → todo como antes: límites por IP y sin revisar tokens.
//    observe  → (por omisión) revisa tokens y planes y anota en el registro lo que bloquearía,
//               pero no bloquea: los límites siguen por IP como antes.
//    enforce  → bloquea: 401 token inválido, 403 fase fuera del plan, límites por cuenta.
// ======================================================================
const SB_URL_DEFAULT = "https://bbepraefoojognseuxzq.supabase.co";
const AUTH_MODES = ["off", "observe", "enforce"];

// Qué fase usa cada tarea. Una tarea que no esté aquí se rechaza, así ninguna queda abierta por olvido.
const PHASE_OF = {
  aclarar: 1, corregir: 1, historia_ia: 1, vocabulario: 1,       // 1 · Escribe y corrijo
  tts: 2, sample: 2,                                            // 2 · Escucha y repite
  stt: 3, evaluar_lectura: 3, volver_a_contar: 3, ejercicios: 3, // 3 · Grábate y te dicto
  evaluar_ejercicios: 3, pizarra_error: 3, pizarra_pronunciacion: 3,
  conversacion: 4,                                              // 4 · Conversemos
};
// Qué fases abre cada plan. «vencido» = la prueba de 7 días ya terminó.
const PLAN_PHASES = {
  invitado: [1, 2], prueba: [1, 2, 3, 4], ia: [1, 2, 3, 4], pro: [1, 2, 3, 4], piloto: [1, 2, 3, 4], vencido: [],
};
// Límites diarios por plan. Se cambian sin desplegar con variables LIMIT_<PLAN>_<TIPO>,
// por ejemplo LIMIT_IA_AI = 120 o LIMIT_INVITADO_TTS = 30.
const PLAN_LIMITS = {
  invitado: { ai: 10,  tts: 40,  sample: 10, stt: 20 },
  prueba:   { ai: 60,  tts: 120, sample: 20, stt: 60 },
  ia:       { ai: 100, tts: 150, sample: 20, stt: 100 },
  pro:      { ai: 120, tts: 200, sample: 20, stt: 120 },
  piloto:   { ai: 80,  tts: 150, sample: 20, stt: 80 },
};
// Precio de Claude en USD por millón de tokens (entrada, salida), para medir el costo por alumno.
const PRICES = { "claude-haiku-5-5": [0.10, 0.50], "claude-sonnet-5-5": [2, 10] };

const authMode = (env) => (AUTH_MODES.includes(env.AUTH_MODE) ? env.AUTH_MODE : "observe");
const sbUrl = (env) => String(env.SUPABASE_URL || SB_URL_DEFAULT).replace(/\/+$/, "");

function b64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Llaves públicas en memoria 10 minutos (lo que pide Supabase para poder revocarlas).
// Si llega un kid desconocido se vuelve a pedir el JWKS, como máximo una vez por minuto.
let jwks = { keys: new Map(), at: 0, forcedAt: 0 };
async function loadJwks(env, force) {
  const now = Date.now();
  if (!force && jwks.at && now - jwks.at < 600e3) return;
  if (force) { if (now - jwks.forcedAt < 60e3) return; jwks.forcedAt = now; }
  const r = await fetch(sbUrl(env) + "/auth/v1/.well-known/jwks.json");
  if (!r.ok) throw new Error("jwks_" + r.status);
  const d = await r.json();
  const keys = new Map();
  for (const k of (d && d.keys) || []) {
    if (!k || k.kty !== "EC" || k.crv !== "P-256" || typeof k.kid !== "string" || (k.alg && k.alg !== "ES256")) continue;
    try {
      keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: k.x, y: k.y, ext: true },
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
    } catch (e) { /* llave mal formada: se ignora */ }
  }
  jwks = { keys, at: now, forcedAt: jwks.forcedAt };
}

// Devuelve { claims } si el token es auténtico y vigente, { bad: motivo } si no, o { down: true }
// si no se pudieron obtener las llaves de Supabase.
async function verifyToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((x) => !/^[A-Za-z0-9_-]+$/.test(x))) return { bad: "format" };
  let head, claims, sig;
  try {
    head = JSON.parse(new TextDecoder().decode(b64u(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64u(parts[1])));
    sig = b64u(parts[2]);
  } catch (e) { return { bad: "format" }; }
  if (!head || typeof head !== "object" || !claims || typeof claims !== "object") return { bad: "format" };
  if (head.alg !== "ES256" || typeof head.kid !== "string") return { bad: "alg" }; // ni none ni HS256
  if (sig.length !== 64) return { bad: "sig" };
  try { await loadJwks(env, false); } catch (e) { if (!jwks.keys.size) return { down: true }; }
  let key = jwks.keys.get(head.kid);
  if (!key) { try { await loadJwks(env, true); } catch (e) {} key = jwks.keys.get(head.kid); }
  if (!key) return { bad: "kid" };
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig,
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return { bad: "sig" };
  const now = Math.floor(Date.now() / 1000), skew = 30;
  if (typeof claims.exp !== "number" || claims.exp + skew < now) return { bad: "exp" };
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) return { bad: "nbf" };
  if (typeof claims.iat === "number" && claims.iat - skew > now) return { bad: "iat" };
  if (claims.iss !== sbUrl(env) + "/auth/v1") return { bad: "iss" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes("authenticated") || claims.role !== "authenticated") return { bad: "aud" };
  if (typeof claims.sub !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub)) return { bad: "sub" };
  return { claims };
}

function planOf(claims, env) {
  const fallback = has(PLAN_LIMITS, env.DEFAULT_PLAN || "") ? env.DEFAULT_PLAN : "piloto";
  let plan = typeof claims.wplan === "string" && has(PLAN_LIMITS, claims.wplan) && claims.wplan !== "invitado" ? claims.wplan : fallback;
  if (plan === "prueba" && typeof claims.wtrial === "number" && claims.wtrial < Date.now() / 1000) plan = "vencido";
  return plan;
}

// Quién hace la petición: invitado (sin encabezado), alumno con su plan, token inválido o llaves caídas.
async function whoIsIt(request, env) {
  const h = request.headers.get("Authorization");
  if (h === null) return { plan: "invitado" };
  const m = /^Bearer ([A-Za-z0-9._-]+)$/.exec(h.trim());
  if (!m) return { bad: "header" };
  const v = await verifyToken(m[1], env);
  if (v.down) return { down: true };
  if (v.bad) return { bad: v.bad };
  return { sub: v.claims.sub, plan: planOf(v.claims, env) };
}

// ¿Puede esta persona usar esta tarea? null = sí; si no, [estado, cuerpo de la respuesta].
function gate(actor, key) {
  if (actor.down) return [503, { error: "auth_unavailable" }];
  if (actor.bad) return [401, { error: "session_invalid" }];
  const phase = PHASE_OF[key];
  if (!phase) return [400, { error: "bad_request" }];
  if ((PLAN_PHASES[actor.plan] || []).includes(phase)) return null;
  if (actor.plan === "vencido") return [403, { error: "trial_ended", phase }];
  return [403, { error: "plan_required", phase }];
}

function planLimit(env, plan, kind) {
  const v = parseInt(env[`LIMIT_${plan.toUpperCase()}_${kind.toUpperCase()}`], 10);
  return Number.isFinite(v) && v >= 0 ? v : ((PLAN_LIMITS[plan] || {})[kind] || 0);
}

// Límite por cuenta (o por IP para invitados) con una sola instrucción atómica: si hay cupo devuelve
// el nuevo conteo; si ya está en el tope no escribe nada. Así 20 peticiones simultáneas con cupo 5
// dejan pasar exactamente 5. Devuelve { err } o { refund } para regresar el cupo si falla el proveedor.
const BUMP = `INSERT INTO usage (day, who, kind, n) VALUES (?1, ?2, ?3, 1)
              ON CONFLICT(day, who, kind) DO UPDATE SET n = n + 1 WHERE n < ?4 RETURNING n`;
const UNBUMP = "UPDATE usage SET n = n - 1 WHERE day = ?1 AND who = ?2 AND kind = ?3 AND n > 0";
async function useQuotaPlan(request, env, ctx, kind, actor) {
  if (!env.DB) return { err: "limit_not_configured" };
  const cap = planLimit(env, actor.plan, kind);
  const [, totalName] = LIMIT_NAMES[kind] || LIMIT_NAMES.ai;
  const tv = parseInt(env[totalName], 10);
  const total = Number.isFinite(tv) && tv >= 0 ? tv : LIMIT_DEFAULTS[totalName];
  const day = mxDay(0), salt = env.HASH_SALT || "wrealispec";
  const who = actor.sub ? "u:" + await hash(`${actor.sub}|${salt}`)
    : "ip:" + await hash(`${request.headers.get("CF-Connecting-IP") || "unknown"}|${day}|${salt}`);
  if (cap <= 0) return { err: "daily_limit" };
  try {
    const a = await env.DB.prepare(BUMP).bind(day, who, kind, cap).all();
    if (!a.results || !a.results.length) return { err: "daily_limit" };
    const b = total > 0 ? await env.DB.prepare(BUMP).bind(day, "*", kind, total).all() : { results: [] };
    if (!b.results || !b.results.length) {
      await env.DB.prepare(UNBUMP).bind(day, who, kind).run();
      return { err: "service_busy" };
    }
  } catch (e) {
    return { err: "limit_not_configured" };
  }
  if (Math.random() < 0.02 && ctx && ctx.waitUntil) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM usage WHERE day < ?1").bind(mxDay(KEEP_DAYS)).run().catch(() => {}));
  }
  const refund = () => {
    const p = env.DB.batch([env.DB.prepare(UNBUMP).bind(day, who, kind), env.DB.prepare(UNBUMP).bind(day, "*", kind)]).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p);
    return p;
  };
  return { refund };
}

// Costo de Claude por alumno y mes (para validar los precios de los planes). El alumno se guarda como
// un código irreversible; los invitados se suman juntos en «invitado».
let costTableReady = false;
async function recordCost(env, actor, model, usage) {
  if (!env.DB || !usage) return;
  const [pin, pout] = PRICES[model] || PRICES[MODEL];
  const inT = Number(usage.input_tokens) || 0, outT = Number(usage.output_tokens) || 0;
  const usd = (inT * pin + outT * pout) / 1e6;
  if (!costTableReady) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_cost (month TEXT NOT NULL, who TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '',
      calls INTEGER NOT NULL DEFAULT 0, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0,
      usd REAL NOT NULL DEFAULT 0, PRIMARY KEY (month, who))`).run();
    costTableReady = true;
  }
  const who = actor.sub ? "u:" + await hash(`${actor.sub}|${env.HASH_SALT || "wrealispec"}`) : "invitado";
  await env.DB.prepare(`INSERT INTO ai_cost (month, who, plan, calls, in_tok, out_tok, usd) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)
    ON CONFLICT(month, who) DO UPDATE SET plan = excluded.plan, calls = calls + 1, in_tok = in_tok + excluded.in_tok,
    out_tok = out_tok + excluded.out_tok, usd = usd + excluded.usd`)
    .bind(mxDay(0).slice(0, 7), who, actor.plan || "invitado", inT, outT, usd).run();
}

// ======================================================================
//  Plantillas de las instrucciones de la IA (copiadas tal cual de la app v0.9.22)
// ======================================================================
function asgBlock(a){
  if (!a) return "";
  const parts = [];
  if (a.structure) parts.push(`use this structure: ${a.structure}`);
  if (a.verbs && a.verbs.length) parts.push(`use these verbs: ${a.verbs.join(", ")}`);
  if (a.adjectives && a.adjectives.length) parts.push(`use these adjectives: ${a.adjectives.join(", ")}`);
  if (a.needQuestion) parts.push("include at least one question");
  return parts.length ? "\n\nThe teacher asked the student to: " + parts.join("; ") + "." : "";
}
function aiStoryPrompt({ topic, level, asg, name }){
  // Las historias de la IA son ~40% más largas que la meta del alumno, para que tengan más que estudiar.
  const [a, b] = (LEVELS[level] || [100, 150]).map(n => Math.round(n * 1.4 / 5) * 5);
  return `You are the writing corrector of Wrealispec. This time, instead of correcting, you write a short original story for the student to study.
Student name: ${name || "(unknown)"}. Student level (CEFR): ${level}. Topic: "${topic}".${asgBlock(asg)}

Rules:
1. story: an original, natural English story of ${a} to ${b} words about the topic, in first person, as if the student wrote it, at level ${level}.${asg ? " Use every requirement the teacher asked for." : ""} Write times like "6:30 am" (without periods).
2. title: a short title in English.
3. glossary: 5 to 8 useful words or phrases from the story with their meaning in Spanish ("en", "es").
4. intro_es: 1 warm sentence in Spanish presenting the story to the student. Never use numbers or grades.
5. teacher_questions: 3 simple follow-up questions in English a teacher can ask about this story.
6. useful_phrases: 4 short English sentences to explain the story, each with "en" and "es".
7. emojis: exactly 3 emojis that illustrate the main moments of the story (places, objects or actions), in story order, as one string with no spaces. Do not use faces.

Reply with only JSON in this shape:
{"title":"","story":"","glossary":[{"en":"","es":""}],"intro_es":"","teacher_questions":["","",""],"useful_phrases":[{"en":"","es":""}],"emojis":""}`;
}
function clarBlock(clar){
  if (!clar || !clar.length) return "";
  return "\n\nBefore this correction, the student explained what they meant in some parts (they may answer in Spanish or Portuguese). The student's explanation ALWAYS wins over your own guess, even if you thought they meant something else. Use these meanings when you correct and keep the student's words where possible. Never replace the student's idea with a different or more generic one. If the student explains an idea with a metaphor or a personal expression (for example \"que mi inglés llegue hasta el cielo\"), keep that meaning and use the closest NATURAL English expression a native speaker would say (for example \"take my English to the next level\" or \"the sky's the limit\"), not a literal translation. In the errors list, explain each confusion and, for metaphors, say in Spanish how that idea is naturally expressed in English:\n" +
    clar.map((c, i) => `${i+1}. "${c.quote}" → the student meant: ${c.meaning}`).join("\n");
}
function clarifyPrompt({ topic, level, text, name }){
  return `You are the writing corrector of Wrealispec, an English method for Spanish- and Portuguese-speaking adults. Before correcting, you read the student's text to make sure you understand what they meant.
Student name: ${name || "(unknown)"}. Student level (CEFR): ${level}. Topic given by the teacher: "${topic}".
${text ? `Here is the student's text:\n"""\n${text}\n"""` : `The attached image is a photo of the student's notebook page.`}

Tasks:
1. transcription: ${text ? "copy the text above exactly." : "copy exactly what the student wrote, including every mistake. Do NOT correct anything here. If a word is unreadable, write [?]."}
2. not_english: true only if the text is mostly not in English or is not a real attempt (random letters, almost empty).
3. off_topic: true only if the text clearly does not talk about the topic.
4. questions: sentences whose MEANING is unclear, not simple grammar mistakes. For example a word that looks confused with a similar word (sky / skill), a sentence that can mean two different things, or an idea that does not make sense. Pay special attention to false friends that Spanish speakers often confuse, because the sentence can look correct but mean something else: actually (en realidad) vs. currently (actualmente), embarrassed vs. pregnant (embarazada), assist vs. attend (asistir), library vs. bookstore (librería), carpet vs. folder (carpeta), realize vs. carry out (realizar), lost my mind vs. got lost (perderse), sensible vs. sensitive (sensible), exit vs. success (éxito), career vs. degree (carrera). Ask about every sentence that really needs it (usually 0 to 5, never more than 10); use an empty list if everything is understandable. For each one: "quote" (the exact words from the transcription), "guess_en" (your best guess of what they meant, written as a correct English sentence, or "" if you cannot guess), "question_es" (a short, friendly question in Spanish, for example: "¿Quisiste decir «my skills» (mis habilidades)? «The sky» significa «el cielo»." or "¿Exactamente qué quisiste decir aquí?").
5. greeting_es: 1 or 2 warm sentences in Spanish. Greet the student by name if you know it, say something specific and positive about their idea, and if there are questions, say you want to ask a few things before giving your feedback. Never use numbers or grades.
6. note_es: if not_english or off_topic is true, one kind sentence in Spanish explaining it; otherwise "".

Reply with only JSON in this shape:
{"transcription":"","not_english":false,"off_topic":false,"questions":[{"quote":"","guess_en":"","question_es":""}],"greeting_es":"","note_es":""}`;
}
function correctionPrompt({ topic, level, text, clar, asg }){
  return `You are the writing corrector of Wrealispec, an English method for Spanish-speaking adults. The student handwrote a short story in a notebook.
Student level (CEFR): ${level}. Topic given by the teacher: "${topic}".
${text ? `Here is the student's text, already transcribed and confirmed by the student:\n"""\n${text}\n"""` : `The attached image is a photo of the student's notebook page.`}${clarBlock(clar)}${asgBlock(asg)}

Rules:
1. transcription: ${text ? "return an empty string (the app already has the text)." : "copy exactly what the student wrote, including every mistake. Do NOT correct anything here. If a word is unreadable, write [?]."}
2. corrected: rewrite the text so it is correct, natural English. Keep the student's ideas, order and voice. Change only what is needed. Do not add new ideas. Use vocabulary at most one level above ${level}. Write times like "6:30 am" (without periods). Also fix capital letters (months, days, nationalities, languages, names and "I").
3. errors: the most important mistakes (maximum 8). Prioritize repeated mistakes and mistakes that change the meaning. For each one: "original" (exact words from the transcription), "correction", "type" (grammar | vocabulary | spelling | word_order | punctuation), "rule_es" (short explanation in simple Spanish, maximum 20 words).
4. strengths_es: 2 specific things the student did well, in Spanish.
5. feedback_es: 2 sentences in Spanish, in a warm, encouraging tone like a friendly teacher. Write all Spanish in Mexican Spanish, the way people speak in Mexico (for example «papas», not «patatas»; «ustedes», not «vosotros»; «computadora», not «ordenador»; «celular», not «móvil»). First what was good, then the one thing to focus on before the next class. Never use numbers or grades.
6. word_count: number of words in the transcription.
7. teacher_questions: 3 simple follow-up questions in English, at level ${level}, that a teacher can ask in a video call about this story to start a conversation.
8. useful_phrases: 4 short English sentences the student can use to explain this story, each with "en" and "es".
10. emojis: exactly 3 emojis that illustrate the main moments of the story (places, objects or actions), in story order, as one string with no spaces. Do not use faces.
9. assignment_check: only if the teacher gave requirements above; one entry per requirement (the structure, each word to use, the question): "item" (the requirement, short), "ok" (true if the student used it correctly), "note_es" (warm, maximum 15 words, in Spanish). If there are no requirements, use an empty list.

Reply with only JSON in this shape:
{"transcription":"","corrected":"","errors":[{"original":"","correction":"","type":"","rule_es":""}],"strengths_es":["",""],"feedback_es":"","word_count":0,"teacher_questions":["","",""],"useful_phrases":[{"en":"","es":""}],"assignment_check":[{"item":"","ok":true,"note_es":""}],"emojis":""}`;
}
function retellPrompt(level, story, retell){
  return `You are an English tutor for Wrealispec. The student (CEFR ${level}) studied this story many times:
"""
${story}
"""
Now, without looking, the student explained the story in their own words:
"""
${retell}
"""
Evaluate the retelling. It does not need to match word for word. Reply with only JSON:
{"coverage_pct":0,"ideas_missing_es":[""],"errors":[{"original":"","correction":"","rule_es":""}],"feedback_es":""}
coverage_pct: percentage (0-100) of the story's main ideas the student included.
ideas_missing_es: main ideas missing, in Spanish, maximum 4 (empty list if none).
errors: maximum 5 important grammar or vocabulary mistakes in the retelling; rule_es in simple Spanish, maximum 20 words.
feedback_es: 2 sentences in Spanish, in a warm, encouraging tone, first what was good, then one tip. Never use numbers or percentages.`;
}
function readingPrompt(level, story, heard, misses){
  const list = misses.length ? misses.map(m => `- "${m.word}" → ${m.heard ? `heard as "${m.heard}"` : "not heard"}`).join("\n") : "(none)";
  return `You are a pronunciation coach for Wrealispec. A Spanish-speaking student (CEFR ${level}) read this story aloud into a speech recognizer:
"""
${story}
"""
This is what the speech recognizer wrote:
"""
${heard}
"""
These are the ONLY words of the story that did not match what the recognizer wrote:
${list}
Rules:
- Comment only on the words in that list. Never mention any other word, sound or example that is not in the story.
- Skip names of people or places and Spanish words (for example names or Mexican dishes): the recognizer often spells them differently, so they are not pronunciation mistakes.
- Ignore differences in punctuation, capital letters and numbers written as digits.
- If no word in the list is a real mistake, words_to_practice must be [].
Reply with only JSON:
{"feedback_es":"","words_to_practice":[{"word":"","heard_as":"","tip_es":""}]}
feedback_es: 2 sentences in Spanish, in a warm, encouraging tone, first what went well, then the main thing to practice. Never use numbers or percentages.
Be accurate: never state syllable counts or rules you are not sure about; focus on the one sound that most likely caused the confusion. Never describe the position of the tongue, lips or teeth.
words_to_practice: maximum 5 words, chosen only from the list above; heard_as is what the recognizer wrote (or "" if skipped); tip_es: in simple Spanish, maximum 15 words: name the one sound or letter to practice (as it appears in the word) and give a Spanish-like spelling with syllables separated by hyphens and the stressed syllable in CAPITALS (for example «every» → «É-vri», «bus» → «BAS» con la «a» corta).`;
}
function qaPrompt(level, story){
  return `Create 5 short listening exercises about this story for a Spanish-speaking student of English (CEFR ${level}):
"""
${story}
"""
The student HEARS each prompt read aloud. Use exactly this order so the rhythm changes:
1. "multiple_choice": a question about a fact in the story with 3 short options; "answer" is a list with the index (0 to 2) of the correct option.
2. "dictation": one sentence copied exactly from the story (8 to 14 words) in "prompt"; the student writes exactly what they hear. No options.
3. "multi_select": a question with 4 short options where exactly 2 are correct; "answer" lists the indexes of the correct options.
4. "open": a why or how question about the story; the student answers with a short sentence.
5. "opinion": a personal question connected to the story's topic.
Each prompt under 20 words, at level ${level}. Options in English. Never call it a test or exam. Reply with only JSON:
{"items":[{"type":"","prompt":"","label_es":"","options":[],"answer":[]}]}
label_es: a short instruction in Spanish, for example "Elige la respuesta correcta", "Escribe exactamente lo que escuchas", "Elige todas las correctas", "Responde la pregunta".`;
}
function qaEvalPrompt(level, story, items, answers){
  const pairs = items.map((it, i) => `${i+1}. [${it.type}] ${it.prompt}\nStudent answer: ${answers[i] || "(no answer)"}`).join("\n\n");
  return `You are an English tutor for Wrealispec. The student (CEFR ${level}) listened to these exercises about this story and answered in writing.
Story:
"""
${story}
"""
Exercises and answers:
${pairs}

Evaluate each answer. "ok" is true when the content is right (for "opinion": when it answers the question and is understandable), even with small grammar mistakes. Reply with only JSON:
{"results":[{"ok":true,"better_en":"","feedback_es":""}],"summary_es":""}
better_en: a correct, natural model answer in English at the student's level.
feedback_es: maximum 20 words in Spanish; mention one grammar mistake if there is one.
summary_es: 1 sentence in Spanish, warm and encouraging, about how the student did overall. Never use numbers or scores.`;
}

function boardPrompt(level, story, er){
  return `You are the whiteboard teacher of Wrealispec. Explain ONE mistake to a Spanish-speaking student of English (CEFR ${level}) as a short animated whiteboard lesson: 4 to 6 steps, about 40 seconds in total.
The student's corrected story (use it for examples):
"""
${story}
"""
The mistake: "${er.original}" → "${er.correction}" (type: ${er.type || "grammar"}). Short rule already given: ${er.rule_es || ""}
Reply with only JSON:
{"title_es":"","steps":[{"say_es":"","board":[{"t":"","k":"","hl":""}],"en":""}]}
Rules:
- title_es: the topic in Spanish, maximum 6 words (for example «El plural con s»).
- say_es: what the teacher says in this step, in warm, simple Mexican Spanish, 1 or 2 short sentences. A Spanish voice will read it, so never write English words in say_es: refer to them as «esta palabra», «la s final», «el verbo», etc.
- board: 0 to 2 lines that appear on the board in this step, maximum 42 characters each. k is one of: wrong (the student's mistake, shown crossed out), right (the correct form), note (a very short rule in Spanish), example (another English example). hl: an exact part of t to highlight (for example the added letter or word), or "".
- en: an English sentence (maximum 12 words) that an English voice says after say_es, to model the correct form; "" if not needed.
- Order: 1) show the mistake; 2) the rule; 3) the correct form; 4) one or two examples, from the student's story when possible; last step: short encouragement, with the full correct sentence in en.`;
}
// La oración de la historia que contiene la palabra la elige la app (ya sabe partir oraciones).
function boardPronPrompt(level, w, sentence){
  return `You are the whiteboard teacher of Wrealispec. Teach a Spanish-speaking student of English (CEFR ${level}) how to pronounce ONE word, as a short animated whiteboard lesson: 4 or 5 steps, about 35 seconds in total.
Word: "${w.word}". When the student read it aloud, the speech recognizer ${w.heard_as ? `understood "${w.heard_as}"` : "did not understand it"}.
Sentence from the student's story: "${sentence}"
Reply with only JSON:
{"title_es":"","steps":[{"say_es":"","board":[{"t":"","k":"","hl":""}],"en":"","slow":false}]}
Rules:
- Be accurate. Never state syllable counts or rules you are not sure about. Focus on the one or two sounds that most likely caused the confusion. Never describe the position of the tongue, lips or teeth: the student learns by listening (slowly, then normally) and repeating.
- title_es: maximum 6 words in Spanish (for example «Cómo se dice every»).
- say_es: warm, simple Mexican Spanish, 1 or 2 short sentences. A Spanish voice reads it, so never write English words in say_es: say «esta palabra», «el primer sonido», etc.
- board: 0 to 2 lines per step, maximum 42 characters each. k: right = the word or the sentence; wrong = what was heard, only if it is a different word; note = a very short tip in Spanish about the sound; example = a Spanish-like spelling with syllables separated by hyphens and the stressed syllable in CAPITALS (for example «É-vri»). hl: an exact part of t to highlight, or "".
- en: what an English voice says after say_es (the word, or the sentence, maximum 12 words); "" if nothing. slow: true to play it slowly.
- Order: 1) the word, and what was heard; 2) the sound to practice, with the Spanish-like spelling; 3) the word said slowly (slow: true) and then at normal speed (slow: false); 4) the word inside the sentence from the story; last step: short encouragement.`;
}

function chatPrompt({ level, name, story, questions, turns, finish }){
  const transcript = turns.map(t => `${t.who === "ai" ? "Tutor" : "Student"}: ${t.text}`).join("\n") || "(no messages yet)";
  return `You are an English tutor for Wrealispec having a short conversation with a student (CEFR ${level}) about the student's story.
Student name: ${name || "(unknown)"}.
Story:
"""
${story}
"""
Questions a teacher could ask: ${questions.join(" | ")}
Conversation so far:
${transcript}

Rules:
- Use simple English at the student's level, 1 to 3 short sentences per turn.
- First turn: greet the student by name and ask them to explain their story in their own words.
- Then ask ONE question at a time (about 5 questions in total), reacting naturally to what the student said.
- If the student makes an important mistake, repeat their idea correctly in your reply, without lecturing.
- If the student writes in Spanish, answer kindly in English and encourage them to try in English.
${finish ? "- The student wants to finish now: say goodbye and set done to true.\n" : ""}- When the student has answered about 5 questions, say goodbye and set done to true.
Reply with only JSON:
{"reply":"","hint_es":"","hint_words":[],"done":false,"feedback":null}
hint_es: a short Spanish translation of your reply.
hint_words: 6 to 10 English words or very short chunks (1 to 3 words each) that would help the student answer your question, taken from the story when possible. Never a full sentence and never the full answer; include one or two useful words that are not strictly needed. [] when done is true.
When done is true, feedback is {"fluency":0,"grammar":0,"vocabulary":0,"comment_es":"","corrections":[{"original":"","correction":"","rule_es":""}]}: scores from 0 to 100 (they are never shown as numbers), comment_es is 2 warm sentences in Spanish (what went well, then one tip), corrections are maximum 4 from the student's messages, rule_es maximum 20 words.`;
}

function vocabPrompt({ level, topic, structs, prev }){
  return `You are an English tutor for Wrealispec. Suggest vocabulary for a student's next short story.
Student level: CEFR ${level}.
Topic or trigger question: "${topic}"
Structures to practice: ${structs.length ? structs.join("; ") : "(any)"}
Reply with only JSON: {"verbs":[],"adjectives":[]}
- verbs: 5 or 6 useful verbs for this topic, written in the form the student should use with the structures (for example "went" for past simple, "have visited" for present perfect).
- adjectives: 5 or 6 useful adjectives for this topic.
- Words must match the student's level. ${prev.length ? `Do not repeat: ${prev.join(", ")}.` : ""}`;
}

// ======================================================================
//  Revisión de los datos que manda la app. Si algo no tiene el tipo o el
//  tamaño esperado, la solicitud se rechaza (no se recorta en silencio).
// ======================================================================
class BadInput extends Error {}
const TEXT = 6000; // historia o texto del alumno (C1 pide máx. 300 palabras: sobra espacio)
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
function str(v, max, field){
  if (v === undefined || v === null) return "";
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string" || v.length > max) throw new BadInput(field);
  return v;
}
function list(v, maxItems, each, field){
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems) throw new BadInput(field);
  return v.map(each);
}
const lvl = (v) => (typeof v === "string" && has(LEVELS, v) ? v : "A2");
const words = (v, n, max, field) => list(v, n, (x) => str(x, max, field), field);
function assignment(v){
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return {
    structure: str(v.structure, 300, "asg"),
    verbs: words(v.verbs, 20, 60, "asg"),
    adjectives: words(v.adjectives, 20, 60, "asg"),
    needQuestion: v.needQuestion === true,
  };
}
function needText(t, field){ if (!t.trim()) throw new BadInput(field); return t; }

// Cada tarea: cómo se arma su instrucción, si acepta foto, qué modelo usa y cuánto puede responder.
const TASKS = {
  aclarar: { image: true, tokens: 6000, build: (d, img) => clarifyPrompt({
    topic: str(d.topic, 300, "topic"), level: lvl(d.level), name: str(d.name, 80, "name"),
    text: img ? "" : needText(str(d.text, TEXT, "text"), "text"),
  }) },
  corregir: { image: true, tokens: 6000, build: (d, img) => correctionPrompt({
    topic: str(d.topic, 300, "topic"), level: lvl(d.level),
    text: img ? "" : needText(str(d.text, TEXT, "text"), "text"),
    clar: list(d.clar, 12, (c) => ({ quote: str(obj(c).quote, 400, "clar"), meaning: str(obj(c).meaning, 600, "clar") }), "clar"),
    asg: assignment(d.asg),
  }) },
  historia_ia: { tokens: 6000, build: (d) => aiStoryPrompt({
    topic: str(d.topic, 300, "topic"), level: lvl(d.level), asg: assignment(d.asg), name: str(d.name, 80, "name"),
  }) },
  evaluar_lectura: { precise: true, tokens: 3000, build: (d) => readingPrompt(
    lvl(d.level), needText(str(d.story, TEXT, "story"), "story"), str(d.heard, 8000, "heard"),
    list(d.misses, 400, (m) => ({ word: str(obj(m).word, 80, "misses"), heard: str(obj(m).heard, 80, "misses") }), "misses"),
  ) },
  volver_a_contar: { tokens: 3000, build: (d) => retellPrompt(
    lvl(d.level), needText(str(d.story, TEXT, "story"), "story"), needText(str(d.retell, 4000, "retell"), "retell"),
  ) },
  ejercicios: { tokens: 3000, build: (d) => qaPrompt(lvl(d.level), needText(str(d.story, TEXT, "story"), "story")) },
  evaluar_ejercicios: { tokens: 3000, build: (d) => qaEvalPrompt(
    lvl(d.level), needText(str(d.story, TEXT, "story"), "story"),
    list(d.items, 5, (it) => ({ type: str(obj(it).type, 30, "items"), prompt: str(obj(it).prompt, 400, "items") }), "items"),
    list(d.answers, 5, (a) => (Array.isArray(a) ? words(a, 6, 10, "answers").join(",") : str(a, 800, "answers")), "answers"),
  ) },
  pizarra_error: { precise: true, tokens: 3000, build: (d) => {
    const e = obj(d.error);
    return boardPrompt(lvl(d.level), needText(str(d.story, TEXT, "story"), "story"), {
      original: needText(str(e.original, 400, "error"), "error"), correction: str(e.correction, 400, "error"),
      type: str(e.type, 30, "error"), rule_es: str(e.rule_es, 400, "error"),
    });
  } },
  pizarra_pronunciacion: { precise: true, tokens: 3000, build: (d) => boardPronPrompt(lvl(d.level), {
    word: needText(str(d.word, 80, "word"), "word"), heard_as: str(d.heard_as, 80, "heard_as"),
  }, str(d.sentence, 800, "sentence")) },
  conversacion: { tokens: 3000, build: (d) => chatPrompt({
    level: lvl(d.level), name: str(d.name, 80, "name"), story: needText(str(d.story, TEXT, "story"), "story"),
    questions: words(d.questions, 6, 400, "questions"),
    turns: list(d.turns, 30, (t) => ({ who: obj(t).who === "ai" ? "ai" : "me", text: str(obj(t).text, 800, "turns") }), "turns"),
    finish: d.finish === true,
  }) },
  vocabulario: { tokens: 1500, build: (d) => vocabPrompt({
    level: lvl(d.level), topic: needText(str(d.topic, 300, "topic"), "topic"),
    structs: words(d.structs, 8, 200, "structs"), prev: words(d.prev, 40, 60, "prev"),
  }) },
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST" || !allowed) return reply({ error: "forbidden" }, 403, cors);
    let body;
    try { body = await request.json(); } catch (e) { return reply({ error: "bad_request" }, 400, cors); }
    if (!body || typeof body !== "object") return reply({ error: "bad_request" }, 400, cors);

    // Quién es y si su plan le permite esta parte (según AUTH_MODE).
    const mode = authMode(env);
    const actor = mode === "off" ? { plan: "invitado", legacy: true } : await whoIsIt(request, env);
    // Revisa la puerta y cobra el cupo. Devuelve una respuesta de error o { refund }.
    const admit = async (key, kind) => {
      const g = gate(actor, key);
      if (mode === "enforce") {
        if (g) return { res: reply(g[1], g[0], cors) };
        const q = await useQuotaPlan(request, env, ctx, kind, actor);
        return q.err ? { res: reply({ error: q.err }, 429, cors) } : q;
      }
      if (g && mode === "observe") console.log(JSON.stringify({ wrealispec: "observe", would: g[1].error, task: key, plan: actor.plan || "", why: actor.bad || "" }));
      const q = await useQuota(request, env, ctx, kind);
      return q ? { res: reply({ error: q }, 429, cors) } : { refund: () => {} };
    };
    const settle = (res, a) => { if (res.status >= 500 || res.status === 429) a.refund(); return res; };

    if (body.stt) {
      const a = await admit("stt", "stt");
      if (a.res) return a.res;
      return settle(await stt(body.stt, env, cors), a);
    }
    if (body.tts) {
      const isSample = body.tts.sample === true;
      const a = await admit(isSample ? "sample" : "tts", isSample ? "sample" : "tts");
      if (a.res) return a.res;
      if (isSample) return settle(await tts({ text: SAMPLE_TEXT, voice: body.tts.voice, rate: 1 }, env, cors), a);
      if (Array.isArray(body.tts.sentences)) return settle(await ttsMarked(body.tts, env, cors), a);
      return settle(await tts(body.tts, env, cors), a);
    }

    // Instrucciones de la corrección, para la sección «para profesores» de la app. No usa la IA ni cuota.
    if (body.task === "instrucciones") {
      return reply({ text: correctionPrompt({ topic: "{tema}", level: "{nivel}" }) + JSON_RULE }, 200, cors);
    }

    // ---------- Tareas de la IA ----------
    const name = typeof body.task === "string" ? body.task : "";
    const task = has(TASKS, name) ? TASKS[name] : null;
    if (!task) return reply({ error: "bad_request" }, 400, cors);
    if (body.prompt !== undefined) return reply({ error: "bad_request" }, 400, cors); // el formato viejo ya no se acepta
    if (!env.ANTHROPIC_API_KEY) return reply({ error: "not_configured" }, 500, cors);

    const hasImage = body.image !== undefined && body.image !== null;
    if (hasImage) {
      const { media_type, data } = obj(body.image);
      if (!task.image || !IMAGE_TYPES.includes(media_type) || typeof data !== "string" || data.length > MAX_IMAGE_BASE64) {
        return reply({ error: "image_rejected" }, 400, cors);
      }
    }

    let prompt;
    try {
      prompt = task.build(obj(body.data), hasImage) + JSON_RULE;
    } catch (e) {
      if (e instanceof BadInput) return reply({ error: "bad_request", field: e.message }, 400, cors);
      throw e;
    }
    if (prompt.length > MAX_PROMPT_CHARS) return reply({ error: "too_long" }, 400, cors);

    // Se cuenta antes de llamar a la IA: si ya se llegó al límite o el plan no lo incluye, no se gasta nada.
    const a = await admit(name, "ai");
    if (a.res) return a.res;

    const content = [];
    if (hasImage) content.push({ type: "image", source: { type: "base64", media_type: body.image.media_type, data: body.image.data } });
    content.push({ type: "text", text: prompt });

    // Con json: true, la respuesta llega como un objeto ya estructurado (herramienta "respond"),
    // así no depende de que la IA escriba bien las comillas.
    const wantJson = body.json === true;
    const model = task.precise ? MODEL_PRECISE : MODEL;
    const payload = { model, max_tokens: task.tokens, messages: [{ role: "user", content }] };
    if (wantJson) {
      payload.tools = [{
        name: "respond",
        description: "Send your answer as a JSON object with exactly the fields requested in the instructions.",
        input_schema: { type: "object", additionalProperties: true },
      }];
      payload.tool_choice = { type: "tool", name: "respond" };
    }

    const callClaude = (b) => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(b),
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
      a.refund();
      return reply({ error: "upstream_error" }, 502, cors);
    }

    // Si falla Claude, el cupo se le regresa al alumno: no es su culpa.
    if (upstream.status === 429 || upstream.status === 529) { a.refund(); return reply({ error: "rate_limited" }, 429, cors); }
    if (!upstream.ok) { a.refund(); return reply({ error: "upstream_error" }, 502, cors); }

    const data = await upstream.json();
    if (mode !== "off" && !actor.bad && !actor.down && ctx && ctx.waitUntil) {
      ctx.waitUntil(recordCost(env, actor, payload.model, data.usage).catch(() => {}));
    }
    const tool = (data.content || []).find((c) => c.type === "tool_use");
    if (wantJson && tool && tool.input && typeof tool.input === "object") {
      return reply({ json: tool.input, stop: data.stop_reason || "" }, 200, cors);
    }
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    return reply({ text, stop: data.stop_reason || "" }, 200, cors);
  },
};

// ======================================================================
//  Voz (Google Text-to-Speech), voz a texto (Whisper) y límite diario de uso
//  (sin cambios respecto a la v1)
// ======================================================================
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
