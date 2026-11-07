# Servidor de IA de Wrealispec (Cloudflare Worker)

Este Worker guarda en secreto la llave de la API de Claude y solo acepta las tareas de Wrealispec que llegan desde wrealispec.com.

1. Cloudflare → Workers & Pages → Create → Hello World → nombre `wrealispec-ai` → Deploy.
2. Edit code → pega todo `worker.js` → Deploy.
3. Settings → Variables and Secrets → Add → tipo **Secret**, nombre `ANTHROPIC_API_KEY`, valor: tu llave → Deploy.
4. Copia la dirección del Worker (https://wrealispec-ai.TU-USUARIO.workers.dev) y ponla en `AI_URL` dentro de `app/index.html`.

Nunca subas la llave al repositorio.
