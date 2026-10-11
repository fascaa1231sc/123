# vorflux-openai-proxy

A lightweight OpenAI-compatible proxy node that runs on Vorflux and calls
upstream models through **Vorflux AI Cloud** (the account's REST API). No
third-party AI provider keys are needed — inference is billed to Vorflux
Cloud Credits.

## Endpoints

All OpenAI-compatible routes are mounted identically under `/v1/*` and
`/api/v1/*` and require `Authorization: Bearer <PROXY_API_KEY>`:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/models` (and `/api/v1/models`) | Live upstream model list in OpenAI format, with `-thinking` variants injected for Claude models (cached ~5 min) |
| POST | `/v1/chat/completions` (and `/api/v1/chat/completions`) | Chat completions, streaming and non-streaming |
| GET | `/api/healthz` | Health check — `{"status":"ok"}` (no auth) |

Any unmatched path returns a JSON 404 (never HTML).

## How upstream routing works

Vorflux AI Cloud has no native `/v1/chat/completions`, so the proxy maps
requests onto the two official upstream APIs:

- **Non-streaming, non-thinking requests → Batch API**
  (`POST /api/v1/batch`): a one-off prompt against the model, no agent
  session is created. If the configured key lacks batch permissions, the
  proxy falls back to the Sessions API automatically.
- **Streaming requests and `-thinking` requests → Sessions API**
  (`POST /api/v1/sessions`): each request runs a GENERAL session.
  `modelSelection.thinkingEnabled` + `thinkingBudgetTokens: 16000` implement
  the `-thinking` variants. Agent `thought` messages stream back wrapped in
  `<think>...</think>` as normal content; `text` messages are the answer.
  Sessions are archived when the response completes.

Message conversion rules:

- A single user message is passed through verbatim (no role prefixes).
- Multi-turn history is compressed into one prompt with `System:` /
  `User:` / `Assistant:` / `Tool:` labels.
- `image_url` parts are converted to Anthropic-style image sources
  (`data:...;base64,...` → `{type:"base64"}`, `https://...` → `{type:"url"}`)
  and embedded as markdown image references in the upstream prompt, because
  the upstream accepts text prompts. Base64 payloads above ~1.5 MB are
  replaced by a placeholder note.

Other behavior:

- `max_tokens` is clamped to 64000 (the default and maximum output limit).
- Streaming always emits a final `usage` chunk (as if
  `stream_options: {include_usage: true}` were set).
- SSE responses use `text/event-stream`, `Cache-Control: no-cache`,
  `Connection: keep-alive`, `X-Accel-Buffering: no`, flush every chunk, send
  a `: ping` comment every 5 seconds, and end with `data: [DONE]`.

## Status page

`web/index.html` is a minimal dark status page served at `/`: service status
(via `/api/healthz`), the node address (`window.location.origin`), and the
supported models grouped by vendor (via `/api/status/models`).

## Configuration

| Variable | Purpose |
| --- | --- |
| `PROXY_API_KEY` | The key clients use to authenticate against this proxy |
| `VORFLUX_API_KEY` | Upstream Vorflux API key (Settings → API; needs `sessions:read`, `sessions:write`, `batch:read`, `batch:write`) |
| `PORT` | Listen port (default `8787`) |

`backend/.env` (gitignored) is loaded automatically; real environment
variables take precedence.

## Run

```bash
npm install
npm run build
npm start
```

Base URL for clients: `http://<host>:<port>/v1`
