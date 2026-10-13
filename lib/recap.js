import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { outcome, uci } from './game.js';

export function recapFor(game, mode) {
  const time = value => new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const moves = game.chess.history({ verbose: true });
  const lines = ['CHESSGPT / FULL MATCH RECAP', 'Match: ' + game.id,
    'Started (America/New_York): ' + time(game.startedAt), 'Opponent: ' + (mode === 'demo' ? 'LOCAL PRACTICE (no ChatGPT API calls)' : mode === 'codex' ? 'LOCAL CODEX CLI' : mode === 'api' ? 'REMOTE API' : 'DOCKERNET AI'),
    'Difficulty: ' + (game.difficulty || 'pure') + (mode === 'demo' ? ' (practice; no engine)' : ''),
    'Result: ' + (game.closedReason || outcome(game.chess) || 'In progress'), '', 'COMPLETE MOVE HISTORY'];
  for (let i = 0; i < moves.length; i++) lines.push((i + 1) + '. ' + (moves[i].color === 'w' ? 'White' : 'Black') + ': ' + moves[i].san + ' [' + uci(moves[i]) + ']');
  if (!moves.length) lines.push('(No moves.)');
  lines.push('', 'POST-GAME REVIEW', game.review || (game.reviewBusy ? 'Review in progress.' : game.reviewError || '(Available when the match ends.)'),
    'Lesson for the next match: ' + (game.reviewLesson || '(None.)'), 'Lesson carried into this match: ' + (game.lesson || '(None.)'));
  lines.push('', 'FINAL / CURRENT BOARD', game.chess.ascii(), 'FEN: ' + game.chess.fen(), '', 'TURN-BY-TURN RECORD');
  for (const event of game.events) {
    lines.push('', time(event.at) + ' (America/New_York) / ' + event.label);
    if (event.move) lines.push('Move: ' + event.move);
    if (event.assistance) lines.push('Assistance: ' + event.assistance);
    for (const attempt of event.attempts || []) lines.push('REJECTED REQUEST:', attempt.prompt, 'REJECTED REPLY:', String(attempt.reply), 'Reason: ' + attempt.rejection);
    if (event.prompt) lines.push('REQUEST:', event.prompt);
    if (event.reply !== undefined) lines.push('REPLY:', String(event.reply));
    if (event.strategy) lines.push('Strategy: ' + event.strategy);
    if (event.change) lines.push('Plan update: ' + event.change);
    if (event.error) lines.push('ERROR: ' + event.error);
    if (event.pending) lines.push(game.closedReason ? 'Request abandoned by restart.' : 'Waiting for reply.');
  }
  if (game.recapWarning) lines.push('', 'ARCHIVE WARNING: ' + game.recapWarning);
  return lines.join('\n') + '\n';
}

export function saveRecap(game, mode, directory) {
  if (!directory) return Promise.resolve();
  const snapshot = recapFor(game, mode);
  // Serialize snapshots per match; separate IDs isolate replies from retired games.
  game.saveChain = (game.saveChain || Promise.resolve()).then(async () => {
    await mkdir(directory, { recursive: true });
    const file = join(directory, game.id + '.txt');
    await writeFile(file + '.tmp', snapshot, { encoding: 'utf8', mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await rename(file + '.tmp', file); break; }
      catch (error) {
        // Windows can briefly lock the destination while a recap is being read.
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await delay(20 * (attempt + 1));
      }
    }
    game.recapWarning = '';
  }).catch(() => { game.recapWarning = 'Could not save match to disk; the in-memory recap is still available.'; });
  return game.saveChain;
}
