# Sofistai v2

Consejo local de mentores vía [OpenRouter](https://openrouter.ai). Varios modelos escuchan la misma conversación, responden en paralelo, y **tú eliges** qué opinión entra al historial.

## Requisitos

- Node.js 20+
- Una API key de OpenRouter

## Arranque

```bash
npm install
npm start
```

Abre [http://127.0.0.1:3847](http://127.0.0.1:3847).

La primera vez la UI te pide la API key y la escribe en un archivo `.env` del proyecto (`OPENROUTER_API_KEY=...`) con permisos `0600`. También puedes crear `.env` a mano a partir de `.env.example`.

La key **no** se guarda en SQLite. El servidor escucha por defecto solo en `127.0.0.1` (`HOST` en `.env` para cambiarlo).

## Uso

1. Crea una sala y elige idioma de la conversación (español o inglés).
2. **Elegir modelos**: modal con el catálogo de OpenRouter y checkboxes.
3. Asigna seudónimos a cada mentor.
4. Escribe: todos los mentores responden en paralelo (candidatas).
5. Selecciona **una o varias** opiniones; cada elegida entra al hilo. **Continuar sin elegir más** archiva el resto en la pestaña **Descartadas** (solo lectura).

Los system prompts de los mentores están siempre en **inglés**; dentro se indica `Respond in Spanish.` o `Respond in English.` según el idioma de la sala.

## Costos

- Listar modelos (`GET /api/v1/models`) es gratis.
- Generar respuestas (chat completions) consume créditos según el modelo.

## Datos

- SQLite en `data/sofistai.sqlite` (gitignored).
- Puerto por defecto: `3847` (`PORT` en `.env`).

## Debug

Pon `SOFISTAI_DEBUG=1` (o `DEBUG=1`) en `.env` y reinicia. Con eso se registra cada interacción:

- Consola: líneas `[sofistai:debug] …`
- `data/logs/app.jsonl` — todo el servidor
- `data/logs/conversation-{id}.jsonl` — eventos de esa sala (mensajes, requests a mentores, respuestas, selección, errores)

Las API keys se redactan en los logs. `/api/health` incluye `"debug": true|false`.

Con debug activo, los JSONL pueden contener el texto completo de la conversación en disco: úsalo solo en local.

## Scripts

| Comando     | Descripción              |
| ----------- | ------------------------ |
| `npm start` | Servidor Express |
| `npm run dev` | Servidor con `--watch` en `server/` y live reload de HTML/CSS/JS en `public/` |

## Licencia

[MIT](LICENSE) © [Claviata](https://github.com/Claviata)
