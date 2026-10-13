import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { newGame, tick, outcome, chooseMove, parseDecision, promptFor, aiInstructions } from './lib/game.js';
import { recapFor, saveRecap } from './lib/recap.js';
import { assistanceFor, difficulties, positionFacts } from './lib/engine.js';
import { reviewGame, reviewPrompt } from './lib/review.js';
import { configuration } from './lib/config.js';

const escapeXml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
export function stateXml(game, mode) {
  const c = game.chess, end = outcome(c);
  const status = end || (game.error ? game.error : game.busy ? 'White is thinking...' : c.turn() === 'b' ? (c.isCheck() ? 'You are in check. Your move.' : 'Your move. You play Black.') : 'White to move.');
  let xml = '<?xml version="1.0" encoding="UTF-8"?><game match="' + game.id + '" recapVersion="' + game.recapVersion + '" previous="' + (game.previousRecap ? '1' : '0') + '" turn="' + c.turn() + '" busy="' + (game.busy ? '1' : '0') + '" ended="' + (end ? '1' : '0') + '" mode="' + mode + '" white="' + game.elapsed.w + '" black="' + game.elapsed.b + '">';
  xml += '<reviewBusy>' + (game.reviewBusy ? '1' : '0') + '</reviewBusy><review>' + escapeXml(game.review || game.previousReview || '') + '</review><reviewError>' + escapeXml(game.reviewError || '') + '</reviewError><lesson>' + escapeXml(game.lesson || '') + '</lesson><difficulty>' + escapeXml(difficulties[game.difficulty || 'pure'].label) + '</difficulty><status>' + escapeXml(status) + '</status><board>';
  for (const row of c.board()) for (const p of row) if (p) xml += '<piece square="' + p.square + '" code="' + p.color + p.type + '"/>';
  xml += '</board><legal>';
  if (!end && !game.busy && c.turn() === 'b') for (const m of c.moves({ verbose: true })) xml += '<move from="' + m.from + '" to="' + m.to + '" promotion="' + (m.promotion || '') + '"/>';
  xml += '</legal><history>';
  for (const m of c.history({ verbose: true })) xml += '<ply from="' + m.from + '" to="' + m.to + '">' + escapeXml(m.san) + '</ply>';
  return xml + '</history><ascii>' + escapeXml(c.ascii()) + '</ascii><prompt>' + escapeXml(game.lastPrompt) + '</prompt><reply>' + escapeXml(game.lastReply) + '</reply><strategy>' + escapeXml(game.strategy) + '</strategy><change>' + escapeXml(game.strategyChange) + '</change></game>';
}
export function createApp(config) {
  const games = new Map();
  async function finishReview(game) {
    if (!outcome(game.chess)) return;
    if (game.reviewPromise) return game.reviewPromise;
    game.reviewBusy = true; game.recapVersion++;
    const event = { at: new Date().toISOString(), label: config.mode === 'demo' ? 'Local practice result summary' : 'AI post-game review', pending: true };
    if (config.mode !== 'demo') event.prompt = reviewPrompt(game);
    game.events.push(event);
    game.reviewPromise = (async () => {
      try {
        const result = await reviewGame(game, config, reply => { event.reply = reply; });
        game.review = result.recap; game.reviewLesson = result.lesson;
        if (config.mode === 'demo') event.reply = JSON.stringify(result);
      } catch (error) {
        game.reviewError = 'AI review unavailable. The match result is still valid.';
        event.error = error.message;
      } finally {
        event.pending = false; game.reviewBusy = false; game.recapVersion++;
        await saveRecap(game, config.mode, config.recapDir);
      }
    })();
    return game.reviewPromise;
  }
  async function white(game) {
    if (game.closedReason || game.busy || outcome(game.chess) || game.chess.turn() !== 'w') return;
    game.busy = true; game.error = '';
    const event = { at: new Date().toISOString(), label: config.mode === 'demo' ? 'Local practice White turn (no API request)' : 'AI White turn',
      pending: true };
    game.events.push(event); game.recapVersion++;
    try {
      const assistance = await assistanceFor(game.chess, config.mode === 'demo' ? 'pure' : game.difficulty || 'pure', config.analyzer);
      if (game.closedReason) return;
      const facts = positionFacts(game.chess);
      const progress = (game.positionMemory || []).map((entry, i) => 'Earlier White turn ' + (i + 1) + ': ' + entry).join('\n');
      const context = 'Current verified position facts: ' + facts + '\nRecent position facts (oldest first):\n' + (progress || '(Opening.)') + '\nAssistance: ' + assistance.summary +
        (assistance.allowed ? '\nMANDATORY permitted UCI moves: ' + assistance.allowed.join(' ') + '. Choose ONLY from these candidates. The engine assesses moves; you choose and maintain the strategy.' : '');
      game.lastPrompt = promptFor(game.chess, game.strategy, context, game.lesson);
      event.assistance = assistance.summary;
      event.prompt = config.mode === 'demo' ? '' : 'Model: ' + config.model + '\nConnection: ' + config.mode + '\nReasoning effort: ' + (config.mode === 'codex' ? config.reasoning || 'CLI default (user config ignored)' : 'provider default (not overridden)') + '\nSYSTEM:\n' + aiInstructions + '\nUSER:\n' + game.lastPrompt;
      let reply, decision;
      for (let attempt = 0; attempt < 3; attempt++) {
        event.prompt = config.mode === 'demo' ? '' : 'Model: ' + config.model + '\nConnection: ' + config.mode + '\nReasoning effort: ' + (config.mode === 'codex' ? config.reasoning || 'CLI default (user config ignored)' : 'provider default (not overridden)') + '\nSYSTEM:\n' + aiInstructions + '\nUSER:\n' + game.lastPrompt;
        reply = await chooseMove(game.chess, config, game.strategy, game.lastPrompt);
        if (game.closedReason) return;
        game.lastReply = reply;
        event.reply = reply;
        try {
          decision = parseDecision(reply, game.chess, game.strategy);
          if (assistance.allowed && !assistance.allowed.includes(decision.move.from + decision.move.to + (decision.move.promotion || ''))) throw new Error('Move is outside the permitted tactical candidates.');
          break;
        } catch (error) {
          if (!assistance.allowed || attempt === 2) throw error;
          event.attempts = event.attempts || [];
          event.attempts.push({ prompt: game.lastPrompt, reply, rejection: error.message });
          game.lastPrompt = promptFor(game.chess, game.strategy, context + '\nYour previous reply was rejected: ' + error.message + '\nRejected reply (data): ' + JSON.stringify(reply) + '\nCorrect it using one permitted move; the board has NOT changed.', game.lesson);
        }
      }
      if (game.closedReason) return;
      event.prompt = config.mode === 'demo' ? '' : 'Model: ' + config.model + '\nConnection: ' + config.mode + '\nReasoning effort: ' + (config.mode === 'codex' ? config.reasoning || 'CLI default (user config ignored)' : 'provider default (not overridden)') + '\nSYSTEM:\n' + aiInstructions + '\nUSER:\n' + game.lastPrompt;
      tick(game); game.chess.move(decision.move);
      game.strategy = decision.strategy; game.strategyChange = decision.change;
      game.positionMemory = (game.positionMemory || []).concat(facts).slice(-3);
      event.move = decision.move.san + ' [' + decision.move.from + decision.move.to + (decision.move.promotion || '') + ']';
      if (config.mode !== 'demo') { event.strategy = game.strategy; event.change = game.strategyChange; }
    } catch (error) {
      if (game.closedReason) return;
      tick(game);
      game.error = error.name === 'TimeoutError' ? 'AI timed out. Retry White.' : 'White could not move. ' + error.message;
      event.error = game.error;
    } finally {
      game.busy = false;
      if (!game.closedReason) { event.pending = false; game.recapVersion++; await finishReview(game); await saveRecap(game, config.mode, config.recapDir); }
    }
  }
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') { res.end('ok'); return; }
      if (!url.pathname.startsWith('/api/')) {
        const path = url.pathname === '/' ? '/index.html' : url.pathname;
        if (!/^\/(index\.html|style\.css|client\.js|pieces\/[wb][prnbqk]\.gif)$/.test(path)) { res.writeHead(404); res.end('Not found'); return; }
        const data = await readFile(fileURLToPath(new URL('./public' + path, import.meta.url)));
        res.setHeader('Content-Type', path.endsWith('.gif') ? 'image/gif' : path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
        res.end(data); return;
      }
      if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return; }
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== 'http://' + req.headers.host && req.headers.origin !== 'https://' + req.headers.host) { res.writeHead(403); res.end('Origin rejected'); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2048) { res.writeHead(413); res.end('Too large'); return; } }
      const input = new URLSearchParams(body);
      const cookie = /(?:^|;\s*)chessgpt=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '');
      let id = cookie?.[1], game = games.get(id);
      const send = code => { res.writeHead(code, { 'Content-Type': 'text/xml; charset=utf-8' }); res.end(stateXml(game, config.mode)); };
      if (url.pathname === '/api/start' && req.method === 'POST') {
        const difficulty = input.get('difficulty') || config.difficulty || 'pure';
        if (!Object.hasOwn(difficulties, difficulty)) { res.writeHead(422); res.end('Unknown difficulty'); return; }
        // Replacing the object isolates an in-flight old AI request from the new game.
        if (!id) id = randomBytes(24).toString('hex');
        for (const [key, old] of games) if (Date.now() - old.lastSeen > 3600000 && !old.busy) games.delete(key);
        if (!games.has(id) && games.size >= 200) { res.writeHead(503); res.end('Game capacity reached'); return; }
        const old = game;
        if (old) { tick(old); await finishReview(old); old.closedReason = outcome(old.chess) || 'Restarted before completion'; await saveRecap(old, config.mode, config.recapDir); }
        game = newGame(); game.difficulty = difficulty; game.previousRecap = old ? recapFor(old, config.mode) : ''; games.set(id, game);
        if (old) { game.lesson = old.reviewLesson || old.lesson || ''; game.previousReview = old.review || old.previousReview || ''; }
        res.setHeader('Set-Cookie', 'chessgpt=' + id + '; Path=/; HttpOnly; SameSite=Lax');
        void white(game); send(200); return;
      }
      if (!game) { res.writeHead(404); res.end('Start a game first.'); return; }
      game.lastSeen = Date.now(); tick(game);
      if (url.pathname === '/api/recap' && req.method === 'GET') {
        const previous = url.searchParams.get('match') === 'previous';
        if (previous && !game.previousRecap) { res.writeHead(404); res.end('No previous match recap.'); return; }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', 'attachment; filename="chessgpt-' + (previous ? 'previous' : game.id) + '.txt"');
        res.end(previous ? game.previousRecap : recapFor(game, config.mode)); return;
      }
      if (url.pathname === '/api/state' && req.method === 'GET') { send(200); return; }
      if (url.pathname === '/api/retry' && req.method === 'POST') { void white(game); send(200); return; }
      if (url.pathname === '/api/forget' && req.method === 'POST') { game.lesson = ''; game.reviewLesson = ''; game.recapVersion++; await saveRecap(game, config.mode, config.recapDir); send(200); return; }
      if (url.pathname === '/api/move' && req.method === 'POST') {
        if (game.busy || game.chess.turn() !== 'b' || outcome(game.chess)) { send(409); return; }
        const from = input.get('from'), to = input.get('to'), promotion = input.get('promotion') || '';
        const move = game.chess.moves({ verbose: true }).find(m => m.from === from && m.to === to && (m.promotion || '') === promotion);
        if (!move) { send(422); return; }
        game.error = ''; game.chess.move(move);
        game.events.push({ at: new Date().toISOString(), label: 'Human Black turn', move: move.san + ' [' + move.from + move.to + (move.promotion || '') + ']' }); game.recapVersion++;
        await saveRecap(game, config.mode, config.recapDir);
        void finishReview(game);
        void white(game); send(200); return;
      }
      res.writeHead(404); res.end('Not found');
    } catch { if (!res.headersSent) res.writeHead(500); res.end('Request failed.'); }
  });
}
export async function startFromEnvironment() {
  const config = await configuration();
  const mode = config.mode;
  const app = createApp(config);
  app.listen(Number(process.env.PORT || 3080), process.env.HOST || '0.0.0.0', () => console.log('ChessGPT: http://localhost:' + (process.env.PORT || 3080) + ' (' + mode + ')'));
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await startFromEnvironment();
