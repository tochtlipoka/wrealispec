// Pruebas del Worker de Wrealispec (v3: cuentas, planes, fases y límites por cuenta).
// Corren con Node 22 sin instalar nada:   node --test worker/tests/
// - node:test es el ejecutor de pruebas que trae Node.
// - node:sqlite es SQLite, el mismo motor que usa Cloudflare D1.
// - Cada prueba crea sus propias llaves ES256, firma tokens de prueba, sirve un JWKS falso
//   y espía fetch: si una petición rechazada intentara llamar a Claude o a Google, la prueba falla.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "wrealispec-worker-"));
const workerFile = join(dir, "worker.mjs");
writeFileSync(workerFile, readFileSync(join(here, "..", "worker.js")));
let loads = 0;
// Cada prueba usa una copia nueva del módulo, así la caché de llaves no pasa de una prueba a otra.
const freshWorker = async () => (await import(pathToFileURL(workerFile).href + "?n=" + (++loads))).default;

const SB = "https://bbepraefoojognseuxzq.supabase.co";
const SUB = "11111111-2222-4333-8444-555555555555";
const enc = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

async function newKey(kid) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, priv: pair.privateKey, jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, kid, alg: "ES256", use: "sig" } };
}
async function sign(key, claims, head = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: "ES256", typ: "JWT", kid: key.kid, ...head });
  const c = enc({ iss: SB + "/auth/v1", aud: "authenticated", role: "authenticated", sub: SUB, iat: now, exp: now + 3600, wplan: "piloto", ...claims });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.priv, new TextEncoder().encode(h + "." + c));
  return h + "." + c + "." + Buffer.from(sig).toString("base64url");
}

// D1 de mentiras sobre SQLite real.
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE usage (day TEXT NOT NULL, who TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, who, kind))");
  const prepare = (sql) => {
    let args = [];
    const st = {
      bind: (...a) => { args = a; return st; },
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => { db.prepare(sql).run(...args); return { success: true }; },
      first: async () => db.prepare(sql).get(...args) ?? null,
    };
    return st;
  };
  return { db, prepare, batch: async (sts) => { const out = []; for (const s of sts) out.push(await s.all()); return out; } };
}

// Escenario: llaves, JWKS falso, proveedores falsos y un Worker nuevo.
async function setup(opts = {}) {
  const key = await newKey("k1");
  const calls = { jwks: 0, claude: 0, google: 0 };
  let jwksKeys = opts.jwksKeys || [key.jwk];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.endsWith("/auth/v1/.well-known/jwks.json")) { calls.jwks++; return Response.json({ keys: jwksKeys }); }
    if (url.startsWith("https://api.anthropic.com/")) {
      calls.claude++;
      if (opts.claudeStatus) return new Response("{}", { status: opts.claudeStatus });
      return Response.json({ content: [{ type: "tool_use", input: { ok: true } }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 200 } });
    }
    if (url.startsWith("https://texttospeech.googleapis.com/")) { calls.google++; return Response.json({ audioContent: btoa("mp3") }); }
    throw new Error("fetch inesperado: " + url);
  };
  const d1 = makeD1();
  const env = { AUTH_MODE: "enforce", DB: d1, ANTHROPIC_API_KEY: "x", GOOGLE_TTS_KEY: "g", HASH_SALT: "sal", AI: { run: async () => ({ text: "hello" }) }, ...(opts.env || {}) };
  const worker = await freshWorker();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const send = async (body, { token, auth, ip = "1.2.3.4", method = "POST" } = {}) => {
    const headers = { Origin: "https://wrealispec.com", "CF-Connecting-IP": ip, "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    if (auth !== undefined) headers.Authorization = auth;
    const res = await worker.fetch(new Request("https://w.example/", { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined }), env, ctx);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, headers: res.headers };
  };
  const flush = () => Promise.all(pending.splice(0));
  const rows = (who) => d1.db.prepare("SELECT who, kind, n FROM usage WHERE who LIKE ? ORDER BY who").all(who);
  return { key, calls, env, send, flush, rows, d1, setJwks: (k) => { jwksKeys = k; } };
}
const AI = { task: "corregir", data: { topic: "Mi día", level: "A2", text: "I go to school." }, json: true };

test("1 · token válido, plan piloto: 200 y cuenta por cuenta (u:)", async () => {
  const t = await setup();
  const r = await t.send(AI, { token: await sign(t.key, {}) });
  assert.equal(r.status, 200);
  assert.equal(t.calls.claude, 1);
  assert.equal(t.rows("u:%").length, 1);
  assert.equal(t.rows("ip:%").length, 0);
});

for (const [n, label, mk] of [
  [2, "firma alterada (un carácter)", async (k) => { const s = await sign(k, {}); const p = s.split("."); const c = p[2][5] === "A" ? "B" : "A"; return p[0] + "." + p[1] + "." + p[2].slice(0, 5) + c + p[2].slice(6); }],
  [3, "contenido alterado (wplan cambiado a pro)", async (k) => { const s = (await sign(k, { wplan: "prueba" })).split("."); const c = JSON.parse(Buffer.from(s[1], "base64url")); c.wplan = "pro"; return s[0] + "." + enc(c) + "." + s[2]; }],
  [4, "alg: none sin firma", async () => enc({ alg: "none", typ: "JWT" }) + "." + enc({ sub: SUB, role: "authenticated", aud: "authenticated", iss: SB + "/auth/v1", exp: Math.floor(Date.now() / 1000) + 3600 }) + "."],
  [5, "alg: HS256 firmado con la llave pública como secreto", async (k) => {
    const h = enc({ alg: "HS256", typ: "JWT", kid: "k1" }), c = enc({ sub: SUB, role: "authenticated", aud: "authenticated", iss: SB + "/auth/v1", exp: Math.floor(Date.now() / 1000) + 3600 });
    const hk = await crypto.subtle.importKey("raw", new TextEncoder().encode(JSON.stringify(k.jwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", hk, new TextEncoder().encode(h + "." + c));
    return h + "." + c + "." + Buffer.from(sig).toString("base64url"); }],
  [6, "token vencido (exp hace 5 min)", (k) => sign(k, { exp: Math.floor(Date.now() / 1000) - 300 })],
  [7, "nbf en el futuro", (k) => sign(k, { nbf: Math.floor(Date.now() / 1000) + 600 })],
  [8, "iss de otro proyecto de Supabase", (k) => sign(k, { iss: "https://otroproyecto.supabase.co/auth/v1" })],
  [9, "aud distinto de authenticated", (k) => sign(k, { aud: "anon" })],
]) {
  test(`${n} · ${label}: 401 y no se llama a Claude`, async () => {
    const t = await setup();
    const r = await t.send(AI, { token: await mk(t.key) });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "session_invalid");
    assert.equal(t.calls.claude, 0);
    assert.equal(t.rows("%").length, 0, "no se cobra cupo");
  });
}

test("10 · kid desconocido: 401 y una sola recarga del JWKS", async () => {
  const t = await setup();
  const otra = await newKey("k-desconocida");
  const r1 = await t.send(AI, { token: await sign(otra, {}) });
  const r2 = await t.send(AI, { token: await sign(otra, {}) });
  assert.equal(r1.status, 401); assert.equal(r2.status, 401);
  assert.equal(t.calls.jwks, 2, "1 carga normal + 1 recarga forzada; la 2.ª petición no vuelve a recargar");
  assert.equal(t.calls.claude, 0);
});

test("11 · rotación: kid nuevo que sí aparece al recargar → 200", async () => {
  const t = await setup();
  const nueva = await newKey("k2");
  assert.equal((await t.send(AI, { token: await sign(t.key, {}) })).status, 200); // carga k1
  t.setJwks([t.key.jwk, nueva.jwk]);
  const r = await t.send(AI, { token: await sign(nueva, {}) });
  assert.equal(r.status, 200);
  assert.equal(t.calls.claude, 2);
});

test("12 · encabezado mal formado (Bearer vacío, 2 partes, basura): 401", async () => {
  const t = await setup();
  for (const auth of ["Bearer ", "Bearer a.b", "Basic abc", "Bearer ###.$$$.%%%", "Bearer a.b.c"]) {
    const r = await t.send(AI, { auth });
    assert.equal(r.status, 401, auth);
  }
  assert.equal(t.calls.claude, 0);
});

test("13 · sin encabezado: 200 como invitado, cuenta por IP (ip:)", async () => {
  const t = await setup();
  const r = await t.send(AI);
  assert.equal(r.status, 200);
  assert.equal(t.rows("ip:%").length, 1);
});

test("14 · invitado pide conversación o retos: 403 plan_required; prueba vencida: 403 trial_ended", async () => {
  const t = await setup();
  const chat = { task: "conversacion", data: { level: "A2", story: "I like tacos.", turns: [] }, json: true };
  const r1 = await t.send(chat);
  assert.equal(r1.status, 403); assert.deepEqual(r1.json, { error: "plan_required", phase: 4 });
  const r2 = await t.send({ stt: { audio: "AAAA" } });
  assert.equal(r2.status, 403); assert.equal(r2.json.phase, 3);
  const vencida = await sign(t.key, { wplan: "prueba", wtrial: Math.floor(Date.now() / 1000) - 60 });
  const r3 = await t.send(AI, { token: vencida });
  assert.equal(r3.status, 403); assert.equal(r3.json.error, "trial_ended");
  const vigente = await sign(t.key, { wplan: "prueba", wtrial: Math.floor(Date.now() / 1000) + 86400 });
  assert.equal((await t.send(chat, { token: vigente })).status, 200);
  assert.equal(t.calls.claude, 1, "solo la prueba vigente llegó a Claude");
});

test("15 · tarea que no existe: 400", async () => {
  const t = await setup();
  const r = await t.send({ task: "escribe_un_poema", data: {} });
  assert.equal(r.status, 400);
  assert.equal(t.calls.claude, 0);
});

test("16 · 20 peticiones simultáneas con cupo 5: pasan exactamente 5", async () => {
  const t = await setup({ env: { LIMIT_PILOTO_AI: "5" } });
  const tok = await sign(t.key, {});
  const rs = await Promise.all(Array.from({ length: 20 }, () => t.send(AI, { token: tok })));
  assert.equal(rs.filter((r) => r.status === 200).length, 5);
  assert.equal(rs.filter((r) => r.status === 429 && r.json.error === "daily_limit").length, 15);
  assert.equal(t.calls.claude, 5);
  assert.equal(t.rows("u:%")[0].n, 5);
});

test("17 · total del sitio lleno: 429 service_busy y el cupo del alumno se devuelve", async () => {
  const t = await setup({ env: { DAILY_AI_TOTAL: "1" } });
  const tok = await sign(t.key, {});
  assert.equal((await t.send(AI, { token: tok })).status, 200);
  const r = await t.send(AI, { token: tok });
  assert.equal(r.status, 429); assert.equal(r.json.error, "service_busy");
  assert.equal(t.rows("u:%")[0].n, 1, "el intento rechazado no le cuenta al alumno");
});

test("18 · Claude responde 500: 502 y el cupo se devuelve", async () => {
  const t = await setup({ claudeStatus: 500 });
  const r = await t.send(AI, { token: await sign(t.key, {}) });
  assert.equal(r.status, 502);
  await t.flush();
  assert.equal(t.rows("u:%")[0].n, 0);
  assert.equal(t.rows("*")[0].n, 0);
});

test("19 · AUTH_MODE = observe con token inválido: 200 como antes y queda anotado", async () => {
  const t = await setup({ env: { AUTH_MODE: "observe" } });
  const logs = []; const orig = console.log; console.log = (m) => logs.push(m);
  try {
    const r = await t.send(AI, { auth: "Bearer basura.basura.basura" });
    assert.equal(r.status, 200);
  } finally { console.log = orig; }
  assert.ok(logs.some((l) => String(l).includes('"would":"session_invalid"')));
  assert.equal(t.rows("u:%").length + t.rows("ip:%").length, 0, "en observe los límites siguen como antes");
  assert.equal(t.rows("%").length, 2, "contador por IP (formato anterior) y total del sitio");
});

test("20 · preflight OPTIONS acepta Authorization", async () => {
  const t = await setup();
  const r = await t.send(null, { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.match(r.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("21 · AUTH_MODE = off ignora el token por completo (reversa instantánea)", async () => {
  const t = await setup({ env: { AUTH_MODE: "off" } });
  const r = await t.send(AI, { auth: "Bearer basura" });
  assert.equal(r.status, 200);
  assert.equal(t.calls.jwks, 0);
});

test("22 · costo de IA por alumno: se suma por mes y por cuenta", async () => {
  const t = await setup();
  const tok = await sign(t.key, { wplan: "ia" });
  await t.send(AI, { token: tok }); await t.send(AI, { token: tok });
  await t.flush();
  const row = t.d1.db.prepare("SELECT who, plan, calls, in_tok, out_tok, usd FROM ai_cost").get();
  assert.equal(row.plan, "ia"); assert.equal(row.calls, 2); assert.equal(row.in_tok, 2000); assert.equal(row.out_tok, 400);
  assert.ok(Math.abs(row.usd - 0.0004) < 1e-9, "2 × (1000 × 0.10 + 200 × 0.50) / 1e6 = 0.0004 USD");
  assert.match(row.who, /^u:[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(row).includes(SUB), "el id real del alumno no se guarda");
});

test("23 · límites por plan desde el panel (LIMIT_INVITADO_AI = 1)", async () => {
  const t = await setup({ env: { LIMIT_INVITADO_AI: "1" } });
  assert.equal((await t.send(AI)).status, 200);
  const r = await t.send(AI);
  assert.equal(r.status, 429); assert.equal(r.json.error, "daily_limit");
  assert.equal((await t.send(AI, { ip: "9.9.9.9" })).status, 200, "otra IP tiene su propio cupo");
});

test("24 · voz (tts) con cuenta: pasa y cobra en «tts»", async () => {
  const t = await setup();
  const r = await t.send({ tts: { text: "Hello there.", voice: "us-f" } }, { token: await sign(t.key, {}) });
  assert.equal(r.status, 200);
  assert.equal(t.calls.google, 1);
  assert.equal(t.rows("u:%")[0].kind, "tts");
});
