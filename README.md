# ChessGPT

A chess board for Windows 98SE / Internet Explorer 6, backed by a modern Node
server and a configurable AI opponent. The human plays Black. Select a piece
to see legal destinations; pawn promotion offers Queen, Rook, Bishop or Knight.

## Run it

Run the backend on a modern Windows, Linux or macOS machine with Node 22.9+
(Node 24 recommended). The legacy computer needs only JavaScript and XMLHTTP
in its browser; it does not need Node, an AI CLI or a chess engine installed.

Install dependencies and create your own configuration:

```text
npm ci
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell,
`cp .env.example .env` on Linux/macOS). Configure one of the connections below,
then run `npm start`. Restart the backend after changing configuration.

Open http://localhost:3080/ on the server, or `http://YOUR-SERVER-LAN-IP:3080/`
on another computer. IE6 uses HTTP on your LAN; the modern backend handles
HTTPS to remote providers. `HOST=127.0.0.1` limits access to the server itself;
the default `0.0.0.0` allows connections through its network interfaces.

## Choose an AI connection

**Installed Codex CLI:** authenticate with `codex login` under the operating-system
account that runs the backend, then set:

```dotenv
AI_MODE=codex
AI_MODEL=default
CODEX_COMMAND=codex
```

The CLI uses its existing login. Local execution describes the CLI location;
inference may still be remote and subject to account limits. `default` selects
the CLI's built-in model default. Personal CLI configuration is ignored for
chess calls; set an explicit supported model ID if desired.

**Remote API:** configure a supported endpoint, its model ID and bearer token:

```dotenv
AI_MODE=api
AI_API_FORMAT=chat
AI_URL=https://api.example.com/v1/chat/completions
AI_MODEL=YOUR_MODEL_ID
AI_TOKEN=YOUR_API_TOKEN
```

Replace every placeholder, including `api.example.com`, with your provider or
compatible gateway's values. `AI_URL` is the complete POST endpoint, not a base
URL. For Responses, use `AI_API_FORMAT=responses` and the corresponding endpoint.
Only Chat Completions and Responses text formats are supported. Matching a URL
path alone does not establish compatibility with a provider's native API.
The legacy `AI_MODE=gateway` is an alias for the HTTP connection path.

See [the API configuration guide](docs/API-CONFIGURATION.md) for the settings,
CLI paths, token files, request formats, container setup and troubleshooting.
Missing credentials fail startup. Failed AI calls pause White for Retry;
there is no silent engine or practice replacement. `npm run practice` selects
the explicit account-free local practice opponent. Credentials stay on the
backend; do not put them in browser code or commit `.env`.

## Play and difficulty

Select the next game's difficulty before Start or Restart. Changing the selector
during a match applies to the next game, including automatic restart.

| Mode | White move selection |
| --- | --- |
| Pure (`pure`) | The configured AI chooses from all legal moves; no engine assistance. |
| Easy / assisted | AI chooses among up to 12 searched candidates within 250 centipawns of the best. |
| Normal / assisted | Same, within 100 centipawns. Default. |
| Hard / assisted | Same, within 35 centipawns, with a longer search. |

These are experimental bands, not Elo ratings. Stockfish 19 lite runs on the
server, using search budgets of 0.5, 1 and 1.8 seconds plus startup. Assisted
modes require mate in one when the rules library verifies it. When the engine
finds forced mate, only its shortest proven mating candidates are permitted.
The AI still selects White's move. Unsafe proposals get corrective feedback
and up to two additional calls. Exhausted retries or engine failures pause play.
Bounded search is not a guarantee of perfect play. Practice uses its own simple
heuristic and does not use an AI connection or Stockfish assistance.

## Strategy, reviews and match history

The server owns the board and enforces legal play with chess.js, including
castling, en passant, promotion, checkmate and draws. Each AI turn receives
ASCII, FEN, ordered SAN/UCI history, a legal move list, current strategy and
recent verified position facts. The AI returns a move and brief strategy;
the server applies the move rather than trusting an AI-generated board.

Strategy objectives include a success measure and a revision condition.
Completed matches receive a one-paragraph AI review and a bounded lesson for
the next game in that browser session. Restart resets the board, clocks and
current strategy while retaining the latest completed lesson as advice to
reassess. An unfinished restart keeps that lesson; **Forget previous lesson**
clears it. This is prompt memory, not model training. Sessions are separate
between browsers and disappear on server restart.

The recap includes complete move history, AI requests/replies, rejected
proposals, strategies, reviews and errors. Current and Previous match views
and a text download are available. Disk archives use `data/recaps` by default;
set `RECAP_DIR` to change the location. Archives survive backend restart, but
in-memory game sessions and the Previous match selector do not. Archive errors
appear in the recap and do not stop play.

After a terminal result, automatic restart waits for review completion and
then eight seconds. The previous paragraph remains visible in the next game.
Review failure leaves the result intact. Clocks measure elapsed thinking time,
including connection latency; there is no time-limit loss.

## Legacy compatibility and verification

The client uses HTML 4 tables, basic CSS, ES3 JavaScript with semicolons, GIF
pieces and same-origin XMLHTTP with ActiveX fallbacks. It needs no canvas,
SVG, modern layout API, browser JSON parser, webfont or browser-side HTTPS.
The 740-pixel layout targets 800x600 screens; longer content can scroll.

`npm run check` verifies syntax, ES3 parsing, chess rules, session handling,
reviews and mocked CLI/API adapters. Client tests cover both ActiveX paths and
promotion controls. Automated checks do not establish actual IE6 rendering or
compatibility with every provider/CLI release. Validate a configured connection
by starting a game, and test rendering and controls on the intended legacy
computer. Live calls, retries and post-game reviews consume provider usage.

## Container deployment

`compose.yml` builds the Node/Stockfish image locally and exposes port 3080.
Configure a remote API in `.env`, then run `docker compose up --build -d`.
The image does not include Codex; a host CLI installation is not available
inside it. Run direct Codex on its installed host or prepare a custom image.

[deploy/compose.example.yml](deploy/compose.example.yml) illustrates deployment
of an existing image with a token file and persistent recap storage.
[deploy/traefik.example.yml](deploy/traefik.example.yml) is an optional reverse
proxy example. Replace image, network, hostname, credential paths and access
ranges for your environment. No specific infrastructure repository or hosting
platform is required. Back up recap storage according to your needs.
For the deployment example, supply `CHESSGPT_IMAGE`, `AI_URL`, `AI_MODEL`,
`CHESSGPT_TOKEN_FILE`, `CHESSGPT_DATA_DIR` and an existing `CHESSGPT_NETWORK`.
The image runs as UID 1000: the token file must be readable and recap storage
writable by that user. The example exposes the app only on its container network;
use a reverse proxy on that network or add a host port mapping if needed.

## Dependencies

Stockfish.js runs as a separate server process. Its GPLv3 license is included
at `node_modules/stockfish/Copying.txt`; [source and build instructions](https://github.com/nmrugg/stockfish.js)
are available upstream. Rules-library documentation: [chess.js](https://jhlywa.github.io/chess.js/).

ChessGPT is licensed under [GPL-3.0](LICENSE).
