# Servidor de IA de Wrealispec (Cloudflare Worker)

Este Worker guarda en secreto la llave de la API de Claude y la de Google (voz), solo acepta las tareas de Wrealispec que llegan desde wrealispec.com y limita cuánto puede usar cada persona al día.

## Despliegue automático desde GitHub

El Worker se despliega solo cuando un cambio llega a la rama `main` (Cloudflare Workers Builds). Ya no se copia y pega el código en Cloudflare. Conectado el 11 de noviembre de 2026.

- Configuración: `wrangler.jsonc` en esta carpeta (nombre del Worker, base D1 `DB`, Workers AI `AI`, `keep_vars`).
- En Cloudflare: `wrealispec-ai` → Settings → Build → repositorio `tochtlipoka/wrealispec`, rama `main`, Root directory `worker`, Build command vacío, Deploy command `npx wrangler deploy`.
- Las llaves siguen como secretos en Cloudflare; nunca van en el repositorio.
- Si un despliegue sale mal: Cloudflare → `wrealispec-ai` → Deployments → regresar a la versión anterior.

## Cuentas, planes y fases (v3, 12 nov 2026)

La app manda la sesión del alumno en cada llamada (`Authorization: Bearer <token de Supabase>`). El Worker revisa el sello del token él solo, con las llaves públicas de Supabase (JWKS, en memoria 10 minutos), sin preguntarle a Supabase en cada petición. El plan viaja dentro del token (`wplan`, y `wtrial` si está en prueba) gracias al Auth Hook `public.claim_plan` de `supabase/planes.sql`.

**Interruptor `AUTH_MODE`** (variable de texto en Settings → Variables, se cambia sin desplegar):

| Valor | Qué hace |
|---|---|
| `off` | Todo como antes: límites por IP y no se revisan tokens. Reversa instantánea. |
| `observe` (por omisión) | Revisa tokens y planes y anota en Logs lo que bloquearía (`"wrealispec":"observe"`), pero no bloquea: los límites siguen por IP. |
| `enforce` | Modo final: 401 si la sesión es falsa o venció, 403 si la fase no está en el plan, límites por cuenta. |

**Fases por plan:**

| Fase | Tareas | Sin cuenta | Prueba (7 días) | IA | Pro | Piloto |
|---|---|---|---|---|---|---|
| 1 · Escribe y corrijo | aclarar, corregir, historia_ia, vocabulario | Sí | Sí | Sí | Sí | Sí |
| 2 · Escucha y repite | voz natural (tts, muestras) | Sí | Sí | Sí | Sí | Sí |
| 3 · Grábate y te dicto | stt, evaluar_lectura, volver_a_contar, ejercicios, evaluar_ejercicios, pizarras | No | Sí | Sí | Sí | Sí |
| 4 · Conversemos | conversacion | No | Sí | Sí | Sí | Sí |

Al vencer la prueba, la IA responde `403 trial_ended`. Una fase fuera del plan responde `403 plan_required` con el número de fase.

**Límites diarios por plan** (llamadas a la IA / audios / muestras de voz / grabaciones):

| Plan | IA | Audios | Muestras | Grabaciones |
|---|---|---|---|---|
| Sin cuenta (por IP) | 10 | 40 | 10 | 20 |
| Prueba | 60 | 120 | 20 | 60 |
| IA | 100 | 150 | 20 | 100 |
| Pro | 120 | 200 | 20 | 120 |
| Piloto | 80 | 150 | 20 | 80 |

Se cambian sin desplegar con variables `LIMIT_<PLAN>_<TIPO>`, por ejemplo `LIMIT_IA_AI = 120` o `LIMIT_INVITADO_TTS = 30` (tipos: `AI`, `TTS`, `SAMPLE`, `STT`). Los topes de todo el sitio siguen siendo `DAILY_*_TOTAL`. El conteo es atómico: con cupo 5, de 20 peticiones simultáneas pasan exactamente 5. Si falla Claude o Google, el cupo se devuelve.

**Costo por alumno:** en `observe` y `enforce`, cada respuesta de Claude suma tokens y costo aproximado en la tabla D1 `ai_cost` (se crea sola), por mes y por cuenta (código irreversible `u:…`; los invitados juntos en `invitado`). Para verla: D1 → `wrealispec-usage` → Console → `SELECT plan, COUNT(*) alumnos, SUM(calls) llamadas, ROUND(SUM(usd), 2) usd FROM ai_cost WHERE month = '2026-11' GROUP BY plan;`

**Pruebas automáticas:** `node --test worker/tests/*.test.mjs` (Node 22, sin instalar nada). Corren solas en cada PR con GitHub Actions.

## Tareas de la IA (v2, nov 2026)

Las instrucciones de la IA viven en `worker.js`, no en la app. La app manda solo el nombre de la tarea y los datos del alumno:

```json
{ "task": "corregir", "data": { "topic": "…", "level": "B1", "text": "…" }, "json": true }
```

| Tarea | Para qué | Modelo |
|---|---|---|
| `aclarar` | Lee el texto o la foto y pregunta lo que no se entiende | Haiku |
| `corregir` | Corrige la historia (texto o foto) | Haiku |
| `historia_ia` | Escribe una historia para estudiar | Haiku |
| `evaluar_lectura` | Retroalimentación de la lectura en voz alta | Sonnet |
| `volver_a_contar` | Revisa la historia contada con sus palabras | Haiku |
| `ejercicios` | Crea los 5 retos de escucha | Haiku |
| `evaluar_ejercicios` | Revisa las respuestas abiertas de los retos | Haiku |
| `pizarra_error` | Guion de la pizarra para un error | Sonnet |
| `pizarra_pronunciacion` | Guion de la pizarra para una palabra | Sonnet |
| `conversacion` | Un turno de la conversación con el tutor | Haiku |
| `vocabulario` | Verbos y adjetivos para el siguiente reto | Haiku |
| `instrucciones` | Devuelve la instrucción de corrección para la sección «para profesores» (no usa la IA ni cuota) | — |

Cada dato se revisa (tipo y tamaño máximo). Si algo no cumple, se responde `bad_request` sin llamar a la IA. El formato viejo (`prompt` libre) ya no se acepta. Para cambiar cómo corrige o evalúa la IA, se edita la plantilla en `worker.js` y se vuelve a desplegar el Worker; la app no se toca.

Solo se aceptan solicitudes desde `https://wrealispec.com` y `https://www.wrealispec.com`.

## Instalación (una sola vez)

1. Cloudflare → Workers & Pages → Create → Hello World → nombre `wrealispec-ai` → Deploy.
2. Settings → Variables and Secrets → Add → tipo **Secret**:
   - `ANTHROPIC_API_KEY`: tu llave de Claude.
   - `GOOGLE_TTS_KEY`: tu llave de Google Text-to-Speech.
   - `HASH_SALT`: cualquier frase larga inventada (sirve para que la IP de nadie se pueda reconstruir).
3. Copia la dirección del Worker y ponla en `AI_URL` dentro de `app/index.html`.

## Límite diario de uso (base de datos D1)

Hazlo **antes** de pegar el código nuevo; sin la base, el Worker no deja pasar ninguna solicitud.

1. Cloudflare → Storage & Databases → D1 → **Create database** → nombre `wrealispec-usage`.
2. Abre la base → pestaña **Console** → pega y ejecuta:

   ```sql
   CREATE TABLE IF NOT EXISTS usage (
     day  TEXT    NOT NULL,
     who  TEXT    NOT NULL,
     kind TEXT    NOT NULL,
     n    INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (day, who, kind)
   );
   ```

3. Worker `wrealispec-ai` → Settings → **Bindings** → Add → **D1 database** → nombre de la variable `DB` → base `wrealispec-usage` → Deploy.
4. Edit code → pega todo `worker.js` → Deploy.

Límites por defecto (se reinician a medianoche de la Ciudad de México):

| Variable | Por defecto | Qué cuenta |
|---|---|---|
| `DAILY_AI_PER_PERSON` | 80 | llamadas a la IA por persona al día |
| `DAILY_TTS_PER_PERSON` | 150 | audios con voz natural por persona al día (historia, pizarra, retos y conversación) |
| `DAILY_AI_TOTAL` | 3000 | llamadas a la IA de todo el sitio al día |
| `DAILY_TTS_TOTAL` | 4000 | audios de todo el sitio al día |

Para cambiarlos sin tocar el código: Settings → Variables and Secrets → Add → tipo **Text** con el nombre de la tabla y el número nuevo.

## Voz a texto (lectura en voz alta)

La Fase 3 convierte la grabación del alumno en texto con Whisper, el modelo de voz a texto que corre dentro de Cloudflare.

1. Worker `wrealispec-ai` → **Bindings** → **Add binding** → **Workers AI** → nombre de la variable `AI` → Add binding.
2. Listo: no hay llave nueva. Cloudflare da una cuota gratis diaria (unos 200 minutos de audio al día) y después cobra centavos.

Límite: `DAILY_STT_PER_PERSON` (80 grabaciones por persona al día, lectura y conversación) y `DAILY_STT_TOTAL` (3000 en todo el sitio).

## Tope de gasto mensual

- **Anthropic:** platform.claude.com → Settings → Workspaces → crea uno llamado `wrealispec`, crea la llave de la API dentro de ese workspace → pestaña **Limits** → **Change limit** (tope mensual en USD) y **Add notification** (aviso por correo al llegar a cierta cantidad).
- **Google Cloud:** Billing → Budgets & alerts → crea un presupuesto con aviso; en APIs & Services → Text-to-Speech → Quotas puedes bajar el máximo de caracteres por minuto/día.

Nunca subas las llaves al repositorio.
