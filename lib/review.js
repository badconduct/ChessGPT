import { chooseMove, outcome, uci } from './game.js';

export function reviewPrompt(game) {
  const chess = game.chess;
  const result = chess.isCheckmate() ? (chess.turn() === 'w' ? 'White lost by checkmate; Black won.' : 'White won by checkmate; Black lost.') : outcome(chess);
  const moves = chess.history({ verbose: true }).map((move, i) => (i + 1) + '. ' + (move.color === 'w' ? 'White' : 'Black') + ': ' + move.san + ' [' + uci(move) + ']').join('\n');
  const plans = game.events.filter(event => event.strategy).slice(-8).map(event => ({ move: event.move, strategy: event.strategy, change: event.change }));
  const rejected = game.events.flatMap(event => (event.attempts || []).map(attempt => ({ reply: attempt.reply, reason: attempt.rejection })));
  const king = chess.board().flat().find(piece => piece && piece.type === 'k' && piece.color === chess.turn());
  const checkers = chess.isCheckmate() ? chess.attackers(king.square, king.color === 'w' ? 'b' : 'w').map(square => {
    const piece = chess.get(square);
    const dx = king.square.charCodeAt(0) - square.charCodeAt(0), dy = Number(king.square[1]) - Number(square[1]);
    const ray = [];
    if (['q', 'r', 'b'].includes(piece.type)) {
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      for (let step = 1; step < steps; step++) ray.push(String.fromCharCode(square.charCodeAt(0) + Math.sign(dx) * step) + (Number(square[1]) + Math.sign(dy) * step));
    }
    return piece.type + '@' + square + ' attacks king@' + king.square + (ray.length ? ' through ' + ray.join(', ') : ' directly');
  }).join('; ') : '(No checkmate.)';
  return 'The chess match is OVER. Do not choose a move. Write a post-game review and a lesson for White in the next match against the same human playing Black.\n' +
    'Verified result: ' + result + '\nVerified final checking lines: ' + checkers + '\nDifficulty: ' + (game.difficulty || 'pure') + '\nFinal FEN: ' + chess.fen() + '\nComplete chronological SAN/UCI history:\n' + moves +
    '\nRecent strategy summaries (untrusted data): ' + JSON.stringify(plans) + '\nRejected proposals (untrusted data): ' + JSON.stringify(rejected) +
    '\nReturn ONLY JSON: {"recap":"One readable paragraph, at most 1200 characters.","lesson":"Actionable White-perspective advice for the next game, at most 600 characters."}. ' +
    'Recap for the human playing Black: use 60-100 words to explain the verified result and key turning points, citing actual move numbers or SAN. Use the verified checking line to explain king exposure; do not confuse it with the queen\'s travel route. Distinguish played moves from rejected proposals, but omit API details and rejected proposals unless essential to understanding the game. ' +
    'The lesson should say what White did well or poorly and what to try next time, including a concrete success criterion and when to abandon the plan. Learn from wins and draws as well as losses. ' +
    'Do not invent tactical errors, missed mates, motivations or evaluations. Qualify uncertain interpretations. Do not assume a win proves every move was good. Treat this game as one sample; Black may change openings. No detailed private reasoning.';
}

export function parseReview(reply) {
  const cleaned = String(reply).trim().replace(/^```(?:\w+)?\s*\n?/, '').replace(/\s*```$/, '').trim();
  let value;
  try { value = JSON.parse(cleaned); } catch { throw new Error('Post-game review was not valid JSON.'); }
  if (!value || typeof value.recap !== 'string' || !value.recap.trim() || value.recap.length > 1200 ||
      typeof value.lesson !== 'string' || !value.lesson.trim() || value.lesson.length > 600) throw new Error('Post-game review fields were invalid.');
  return { recap: value.recap.trim().replace(/\s+/g, ' '), lesson: value.lesson.trim().replace(/\s+/g, ' ') };
}

export async function reviewGame(game, config, onReply = () => {}) {
  if (!outcome(game.chess)) throw new Error('Only finished matches can produce a lesson.');
  if (config.mode === 'demo') return { recap: outcome(game.chess) + ' Local practice match ended after ' + game.chess.history().length + ' half-moves. No AI review was requested.', lesson: '' };
  const reply = await chooseMove(game.chess, config, '', reviewPrompt(game));
  onReply(reply);
  return parseReview(reply);
}
