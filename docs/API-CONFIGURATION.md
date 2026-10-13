# Configure the AI opponent

ChessGPT runs its Node backend on a modern Windows, Linux or macOS machine.
The Windows 98 / IE6 computer runs only the HTTP browser client. It never holds
provider credentials and does not run Codex or Stockfish.

Copy `.env.example` to `.env`, choose one connection below, then run `npm ci`
and `npm start`. Restart Node after changing configuration. `.env` is ignored
by Git. Never commit tokens or include them in screenshots.

## Option 1: an installed Codex CLI

Install a current Codex CLI on the modern machine and authenticate it:

```text
codex login
codex login status
```

Run these commands under the same operating-system account that will run
ChessGPT. Set these values in `.env`:

```dotenv
AI_MODE=codex
AI_MODEL=default
AI_TIMEOUT_MS=180000
CODEX_COMMAND=codex
# Optional, if supported by your chosen model:
# AI_REASONING_EFFORT=medium
```

No ChessGPT API token or separate gateway is needed. The existing Codex login
is used, including `CODEX_HOME` if you set it. Local CLI execution can still
use remote model inference and your account's usage limits; it is not an
offline chess model.

`default` means the CLI's built-in model default. Set `AI_MODEL` to an explicit
model ID if you want to choose one. Personal Codex config and project rules
are ignored for these calls. ChessGPT sends the board, history, strategy and
session lesson explicitly, using a new ephemeral call each time. Post-game
reviews use the same adapter. Calls run serially in disposable temporary
directories, with the read-only sandbox and agent tools disabled. No shell is
used to launch the CLI, and no resume/session ID is passed.

On Windows, standard npm installations are detected on PATH and their JavaScript
entry point is launched with Node, rather than executing a `.cmd` shell shim.
If discovery fails, set either `CODEX_COMMAND` to the absolute native executable
path, or `CODEX_JS_PATH` to the npm package's `bin/codex.js` path. These are paths,
not shell commands or strings containing extra arguments. Paths with spaces
are supported. On Linux/macOS, `codex` must be available on the Node process's PATH.

Use a CLI supporting `exec --ephemeral --ignore-user-config --ignore-rules
--output-schema --output-last-message`, `--sandbox read-only` and the feature
disable switches. Automated tests use a mock CLI; actual compatibility should
be checked against your installed version. Successful CLI discovery or login
does not establish that all inference flags or model IDs are supported.

Official reference: [Codex non-interactive commands](https://learn.chatgpt.com/docs/developer-commands#codex-exec).

## Option 2: a remote API

For an OpenAI-compatible Chat Completions endpoint:

```dotenv
AI_MODE=api
AI_API_FORMAT=chat
AI_URL=https://api.example.com/v1/chat/completions
AI_MODEL=YOUR_MODEL_ID
AI_TOKEN=YOUR_API_TOKEN
AI_TIMEOUT_MS=180000
```

Replace the example hostname, model and token with values offered by your provider.
`api.example.com` is a placeholder, not a working AI service. `AI_URL` is
the **complete POST endpoint**, not the base URL; ChessGPT does not append paths.
To use a compatible gateway, change the URL, model ID/alias and client token.
Provider account access, supported models and billing are managed by the provider.

The backend sends `Authorization: Bearer <AI_TOKEN>`, JSON `model` and `messages`
with system/user roles, and reads `choices[0].message.content`. Calls are
non-streaming text requests. They do not use native provider-specific image,
search, streaming or stateful conversation features. A returned move must be
legal and follow the app's move/strategy JSON contract.

For the Responses API:

```dotenv
AI_MODE=api
AI_API_FORMAT=responses
AI_URL=https://api.example.com/v1/responses
AI_MODEL=YOUR_MODEL_ID
AI_TOKEN=YOUR_API_TOKEN
```

Here the body contains `model` and a text-message `input` array. ChessGPT reads
message items with `output_text` content in the response's `output` array.
It also accepts a gateway's top-level `output_text` extension. It sends no
`previous_response_id`; the app supplies its own context and lesson each turn.

Official references: [Chat Completions](https://developers.openai.com/api/reference/chat-completions/overview),
[Responses input/output](https://developers.openai.com/api/docs/guides/migrate-to-responses).

Only these two HTTP formats are implemented. Native Gemini `generateContent`
and Anthropic Messages endpoints need their own adapters. Use a provider's
OpenAI-compatible endpoint if available; check its documentation for supported
roles, model names and behavior rather than assuming complete compatibility.

## Settings reference

| Variable | Meaning |
| --- | --- |
| `AI_MODE` | `api`, `codex`, `demo`, or the legacy HTTP name `gateway`. Unset retains `gateway` for compatibility. |
| `AI_API_FORMAT` | `chat` (default) or `responses`; used for HTTP requests. |
| `AI_URL` | Complete HTTP(S) POST URL; defaults to the matching OpenAI endpoint. No embedded username/password. |
| `AI_MODEL` | Remote provider model ID; required in `api` mode. In `codex`/legacy gateway, defaults to `default`. |
| `AI_TOKEN` | Remote bearer credential, server-side only. |
| `AI_TOKEN_FILE` | Readable file containing only the remote token; takes precedence over `AI_TOKEN`. |
| `AI_PROFILE` | Optional gateway-specific `X-AI-Profile` header; leave blank for standard providers. |
| `AI_TIMEOUT_MS` | Per-call timeout, 1000–600000 ms; default 180000. Retries and reviews are separate calls. |
| `CODEX_COMMAND` | Native executable name/path; default `codex`. No shell arguments. |
| `CODEX_JS_PATH` | Optional npm CLI JS path launched with Node; takes precedence over `CODEX_COMMAND`. |
| `CODEX_HOME` | CLI's own credential/config home, inherited by the CLI. Do not commit its contents. |
| `AI_REASONING_EFFORT` | Optional local-Codex setting. Accepted values: none, minimal, low, medium, high, xhigh; model support varies. Not sent to remote APIs. |
| `CHESS_DIFFICULTY` | Initial server default: pure, easy, normal (default), hard. Browser selection overrides it for the next game. |
| `HOST`, `PORT` | HTTP bind address/port; defaults `0.0.0.0`, `3080`. Use `127.0.0.1` for server-local access only. |
| `RECAP_DIR` | Saved text recaps; default `data/recaps`. Contains prompts/replies but not API credentials. |

API URL, token and profile are ignored in `codex` mode. Provider-specific
sampling or reasoning fields are not inferred or forwarded. `AI_REASONING_EFFORT`
applies only to the direct CLI connection; remote providers retain their own
defaults. For reproducible model selection, supply an explicit supported ID.

## Existing HTTP gateway configurations

`AI_MODE=gateway` is the legacy name for the HTTP adapter. Existing installations
can keep their endpoint, advertised model alias, bearer credential and optional
`AI_PROFILE`. The profile header is an extension supported by some gateways;
it is not required by the standard text request formats.

## Docker and troubleshooting

The provided Docker image contains Node and Stockfish, not the Codex CLI.
Use `api`/`gateway` mode with Docker. Direct local Codex should initially run
with `npm start` on the host where the CLI is installed and authenticated.
Use a custom image and credential setup if you later want Codex inside Docker;
a host CLI installation is not automatically visible in a container.

Missing token: set `AI_TOKEN` or a readable `AI_TOKEN_FILE`. A local CLI login
does not supply an API key to remote `api` mode. In local mode, run
`codex login status` under the server account; check CLI/model access if a call
fails. Codex progress/errors are not exposed as raw output in the browser.

HTTP 401/403: check the remote credential/account. HTTP 404: verify the complete
endpoint and API format. A rejected model: use a model ID advertised by that
provider. Timeout: choose a supported faster model or raise the per-call limit.
Invalid response: endpoint must return the selected text format; the model
must also follow the chess JSON contract. TLS verification remains enabled.

Failures pause White for Retry; they never silently substitute a local move.
`npm run practice` is the explicit account-free local heuristic mode.
`npm run check` runs mocked API/CLI tests and compatibility tests without
consuming model usage. To test a configured connection, start a game yourself;
that consumes provider/CLI usage, including post-game reviews.
