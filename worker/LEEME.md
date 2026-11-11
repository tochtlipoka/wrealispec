# Servidor de IA de Wrealispec (Cloudflare Worker)

Este Worker guarda en secreto la llave de la API de Claude y la de Google (voz), solo acepta las tareas de Wrealispec que llegan desde wrealispec.com y limita cuánto puede usar cada persona al día.

## Despliegue automático desde GitHub

El Worker se despliega solo cuando un cambio llega a la rama `main` (Cloudflare Workers Builds). Ya no se copia y pega el código en Cloudflare.

- Configuración: `wrangler.jsonc` en esta carpeta (nombre del Worker, base D1 `DB`, Workers AI `AI`, `keep_vars`).
- En Cloudflare: `wrealispec-ai` → Settings → Build → repositorio `tochtlipoka/wrealispec`, rama `main`, Root directory `worker`, Build command vacío, Deploy command `npx wrangler deploy`.
- Las llaves siguen como secretos en Cloudflare; nunca van en el repositorio.
- Si un despliegue sale mal: Cloudflare → `wrealispec-ai` → Deployments → regresar a la versión anterior.

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
