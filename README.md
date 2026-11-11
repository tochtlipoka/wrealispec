# Wrealispec

Writing · Reading · Listening · Speaking · Conversation

Se escribe **Wrealispec** y se pronuncia **"realispec"** (la W es muda, como en *write*).

Prototipo del método Wrealispec en 4 fases:

1. **Escribe y corrijo**: escribes tu historia a mano y la IA la corrige.
2. **Escucha y repite**: escuchas tu historia en modo continuo o eco.
3. **Grábate y te dicto**: lees en voz alta, escuchas y respondes ejercicios sobre tu historia.
4. **Conversemos**: conversas con tu profesor.

Página en línea: https://wrealispec.com (antesala en ES · EN) · Demo: https://wrealispec.com/app/

La IA (Claude Haiku 5.5 y Sonnet 5.5) funciona a través del Worker de Cloudflare en `worker/`, que guarda las llaves y las instrucciones de la IA. La app solo le manda la tarea y los datos (ver `worker/LEEME.md`).
