import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';
import { uci } from './game.js';

const require = createRequire(import.meta.url);
export const difficulties = {
  pure: { label: 'Pure ChatGPT', margin: Infinity, ms: 0 },
  easy: { label: 'Easy / assisted', margin: 250, ms: 500 },
  normal: { label: 'Normal / assisted', margin: 100, ms: 1000 },
  hard: { label: 'Hard / assisted', margin: 35, ms: 1800 }
};

// One bounded server-side analysis at a time, including across different games.
let queue = Promise.resolve();
export function evaluate(chess, ms) {
  const fen = chess.fen(), moves = chess.history({ verbose: true });
  const position = moves.length ? 'position fen ' + moves[0].before + ' moves ' + moves.map(uci).join(' ') : 'position fen ' + fen;
  const task = queue.then(() => analyze(position, ms));
  queue = task.catch(() => {});
  return task;
}

function analyze(position, ms) {
  return new Promise((resolve, reject) => {
    const engine = spawn(process.execPath, [require('stockfish').findEngine('lite-single')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', done = false, depth = 0, scores = new Map(), completed = [];
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); engine.kill();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Tactical analysis timed out. Retry White.')), ms + 15000);
    const send = command => engine.stdin.write(command + '\n');
    engine.on('error', () => finish(new Error('Could not start tactical analysis. Retry White.')));
    engine.stdin.on('error', () => {});
    engine.on('exit', () => { if (!done) finish(new Error('Tactical engine stopped. Retry White.')); });
    engine.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (const line of lines) {
        if (line === 'uciok') { send('setoption name Hash value 16'); send('setoption name MultiPV value 12'); send('isready'); }
        if (line === 'readyok') { send(position); send('go movetime ' + ms); }
        const info = /\bdepth (\d+).*\bmultipv (\d+).*\bscore (cp|mate) (-?\d+)(?!\d).*\bpv ([a-h][1-8][a-h][1-8][qrbn]?)/.exec(line);
        if (info && !/\b(?:upperbound|lowerbound)\b/.test(line)) {
          const nextDepth = Number(info[1]);
          if (nextDepth > depth) { if (scores.size) completed = [...scores.values()]; scores = new Map(); depth = nextDepth; }
          if (nextDepth === depth) scores.set(Number(info[2]), { move: info[5], type: info[3], score: Number(info[4]), depth });
        }
        if (line.startsWith('bestmove ')) {
          // Never compare root moves from different search depths.
          const result = completed.length ? completed : [...scores.values()];
          if (!result.length) finish(new Error('Tactical analysis returned no candidates. Retry White.'));
          else finish(null, result);
        }
      }
    });
    send('uci');
  });
}

export function candidatesWithin(scores, margin) {
  const value = entry => entry.type === 'cp' ? entry.score : entry.score > 0 ? 100000 - entry.score : -100000 - entry.score;
  const ranked = scores.slice().sort((a, b) => value(b) - value(a));
  const best = ranked[0];
  if (!best) throw new Error('No tactical candidates. Retry White.');
  return ranked.filter(entry => best.type === 'mate' && best.score > 0 ? entry.type === 'mate' && entry.score > 0 && entry.score <= best.score : value(best) - value(entry) <= margin);
}

export async function assistanceFor(chess, difficulty, analyzer = evaluate) {
  const settings = difficulties[difficulty];
  if (!settings) throw new Error('Unknown difficulty.');
  if (difficulty === 'pure') return { allowed: null, summary: 'Pure ChatGPT: legality only; no engine assistance.' };
  const legal = chess.moves({ verbose: true });
  const mates = legal.filter(move => { const next = new Chess(chess.fen()); next.move(move); return next.isCheckmate(); }).map(uci);
  if (mates.length) return { allowed: mates, summary: 'Verified mate in one. Required candidates: ' + mates.join(' ') };
  const scores = await analyzer(chess, settings.ms);
  const selected = candidatesWithin(scores.filter(entry => legal.some(move => uci(move) === entry.move)), settings.margin);
  return { allowed: selected.map(entry => entry.move), summary: 'Stockfish 19 lite, bounded search. Scores are from White\'s perspective, not a rating. Permitted candidates:\n' + selected.map(entry => entry.move + ': ' + entry.type + ' ' + entry.score + ' (depth ' + entry.depth + ')').join('\n') };
}

export function positionFacts(chess) {
  const pieces = chess.board().flat().filter(Boolean);
  const blackKing = pieces.find(piece => piece.color === 'b' && piece.type === 'k');
  const counts = color => pieces.filter(piece => piece.color === color && piece.type !== 'k').map(piece => piece.type + '@' + piece.square).join(' ') || 'none';
  const undeveloped = pieces.filter(piece => piece.color === 'w' && ((piece.type === 'n' && ['b1', 'g1'].includes(piece.square)) || (piece.type === 'b' && ['c1', 'f1'].includes(piece.square)))).length;
  const loneKing = pieces.filter(piece => piece.color === 'b').length === 1;
  const whiteKing = pieces.find(piece => piece.color === 'w' && piece.type === 'k');
  const kingDistance = Math.max(Math.abs(whiteKing.square.charCodeAt(0) - blackKing.square.charCodeAt(0)), Math.abs(Number(whiteKing.square[1]) - Number(blackKing.square[1])));
  const edgeDistance = Math.min(blackKing.square.charCodeAt(0) - 97, 104 - blackKing.square.charCodeAt(0), Number(blackKing.square[1]) - 1, 8 - Number(blackKing.square[1]));
  const fields = chess.fen().split(' '); fields[1] = 'b'; fields[3] = '-';
  const kingMoves = new Chess(fields.join(' ')).moves({ verbose: true }).filter(move => move.piece === 'k').map(move => move.to);
  return 'White material: ' + counts('w') + '. Black material: ' + counts('b') + '. White minor pieces still on starting squares: ' + undeveloped + '. Black king: ' + blackKing.square + '. Black king legal destinations on this board (hypothetical Black turn): ' + (kingMoves.join(' ') || 'none') + '. Black king distance from edge: ' + edgeDistance + '; king separation: ' + kingDistance + '. ' +
    (loneKing ? 'Lone-king conversion: coordinate king and heavy pieces, restrict escape squares, and force mate. Avoid stalemate and repetition. Extra promotions are secondary to a proven mating route.' : 'Choose a measurable objective appropriate to this position: development, a supported pawn advance, material gain, king safety or forcing mate.');
}
