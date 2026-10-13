// Explicit, usage-consuming regression check; never run by npm test.
import { readFile, writeFile } from 'node:fs/promises';
import { Chess } from 'chess.js';
import { configuration } from '../lib/config.js';
import { assistanceFor, positionFacts } from '../lib/engine.js';
import { chooseMove, parseDecision, promptFor, uci } from '../lib/game.js';

const config = await configuration();
if (config.mode === 'demo') throw new Error('Live verification requires a configured AI connection.');
const source = new Chess(); source.loadPgn(await readFile('artifacts/last-game.pgn', 'utf8'));
const moves = source.history({ verbose: true });
const report = [];
for (const [name, plies] of [['Missed mate / White 28', 54], ['Hanging knight / White 52', 102], ['Final conversion / White 83', 164]]) {
  const chess = new Chess(); for (const move of moves.slice(0, plies)) chess.move(move);
  const assistance = await assistanceFor(chess, 'hard');
  let prompt = promptFor(chess, '', positionFacts(chess) + '\n' + assistance.summary + '\nMANDATORY permitted UCI moves: ' + assistance.allowed.join(' '));
  const entry = { name, fen: chess.fen(), modelAlias: config.model, reasoning: 'gateway default; no override', assistance, attempts: [] };
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await chooseMove(chess, config, '', prompt);
    entry.attempts.push({ prompt, reply });
    const decision = parseDecision(reply, chess);
    if (assistance.allowed.includes(uci(decision.move))) {
      entry.accepted = uci(decision.move); entry.san = decision.move.san;
      chess.move(decision.move); entry.checkmate = chess.isCheckmate(); break;
    }
    entry.attempts.at(-1).rejected = 'Outside permitted candidates';
    prompt += '\nPrevious reply rejected: ' + JSON.stringify(reply) + '. Choose one permitted candidate. Board unchanged.';
  }
  entry.elapsedMs = Date.now() - started;
  report.push(entry);
  await writeFile('artifacts/assisted-live-verification.json', JSON.stringify(report, null, 2));
  if (!entry.accepted) throw new Error(name + ': three rejected replies');
  console.log(name + ': ' + entry.san + (entry.checkmate ? ' / CHECKMATE' : '') + ', ' + entry.attempts.length + ' API call(s), ' + entry.elapsedMs + 'ms');
}
