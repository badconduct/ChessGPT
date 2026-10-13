import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { parse } from 'acorn';
import { outcome, parseMove, promptFor, chooseMove } from '../lib/game.js';
import { createApp } from '../server.js';

test('browser script parses as ES3', async () => {
  parse(await readFile(new URL('../public/client.js', import.meta.url), 'utf8'), { ecmaVersion: 3 });
});
test('startup without AI credentials fails rather than silently playing locally', async () => {
  const env = { ...process.env };
  delete env.AI_MODE; delete env.AI_TOKEN; delete env.AI_TOKEN_FILE; delete env.AI_TOKEN_SOURCE;
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { env, timeout: 3000 }),
    error => error.code === 1 && /Gateway mode requires AI_TOKEN or AI_TOKEN_FILE/.test(error.stderr));
});
test('model responses cannot replace the board or play illegal moves', () => {
  const chess = new Chess();
  assert.equal(parseMove('e2e4', chess).san, 'e4');
  assert.equal(parseMove('```\ne2e4\n```', chess).san, 'e4');
  assert.throws(() => parseMove('e2e5', chess));
  assert.throws(() => parseMove('I choose e2e4', chess));
  assert.equal(chess.history().length, 0);
  assert.match(promptFor(chess), /Legal UCI moves:/);
});
test('terminal states from Black perspective and special moves', () => {
  const lose = new Chess(); for (const move of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) lose.move(move);
  assert.match(outcome(lose), /You lose/);
  const win = new Chess(); for (const move of ['f3', 'e5', 'g4', 'Qh4#']) win.move(move);
  assert.match(outcome(win), /You win/);
  assert.match(outcome(new Chess('7k/5K2/6Q1/8/8/8/8/8 b - - 0 1')), /stalemate/);
  const castle = new Chess('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  castle.move(parseMove('e8g8', castle)); assert.equal(castle.get('f8').type, 'r');
  const ep = new Chess(); for (const move of ['e4', 'a6', 'e5', 'd5']) ep.move(move);
  ep.move(parseMove('e5d6', ep)); assert.equal(ep.get('d5'), undefined);
  const promotion = new Chess('7k/8/8/8/8/8/p7/7K b - - 0 1');
  promotion.move(parseMove('a2a1n', promotion)); assert.equal(promotion.get('a1').type, 'n');
});
test('gateway sends fresh ASCII and no prior conversation', async t => {
  let received;
  const mock = (await import('node:http')).createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received = { headers: req.headers, body: JSON.parse(body) };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'e2e4' } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const reply = await chooseMove(new Chess(), { mode: 'gateway', url: 'http://127.0.0.1:' + mock.address().port, token: 'test-token', model: 'default', timeout: 2000 });
  assert.equal(reply, 'e2e4'); assert.equal(received.headers.authorization, 'Bearer test-token');
  assert.equal(received.body.messages.length, 2); assert.match(received.body.messages[1].content, /r  n  b  q  k/);
  assert.equal(received.body.previous_response_id, undefined);
});
test('HTTP session opening, legal moves, isolation and fresh restart', async t => {
  const app = createApp({ mode: 'demo' }); app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.address().port;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/api/state')).status, 404);
  const start = await fetch(base + '/api/start', { method: 'POST' }); const cookie = start.headers.get('set-cookie').split(';')[0]; await start.text();
  let response = await fetch(base + '/api/state', { headers: { cookie } }); let state = await response.text();
  assert.match(state, /turn="b"/); assert.equal((state.match(/<ply /g) || []).length, 1);
  response = await fetch(base + '/api/move', { method: 'POST', headers: { cookie }, body: 'from=a7&to=a4' }); assert.equal(response.status, 422); await response.text();
  response = await fetch(base + '/api/move', { method: 'POST', headers: { cookie }, body: 'from=a7&to=a6' }); assert.equal(response.status, 200); await response.text();
  state = await (await fetch(base + '/api/state', { headers: { cookie } })).text(); assert.equal((state.match(/<ply /g) || []).length, 3);
  response = await fetch(base + '/api/start', { method: 'POST', headers: { cookie } }); await response.text();
  state = await (await fetch(base + '/api/state', { headers: { cookie } })).text(); assert.equal((state.match(/<ply /g) || []).length, 1);
  const other = await fetch(base + '/api/start', { method: 'POST' }); assert.notEqual(other.headers.get('set-cookie').split(';')[0], cookie); await other.text();
});

test('restart isolates in-flight AI calls and failures leave White available to retry', async t => {
  const http = await import('node:http');
  const pending = [];
  const gateway = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* drain request */ }
    pending.push(res); gateway.emit('received');
  });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening'); t.after(() => gateway.close());
  const app = createApp({ mode: 'gateway', url: 'http://127.0.0.1:' + gateway.address().port, token: 'test', model: 'default', timeout: 2000 });
  app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.address().port;
  let received = once(gateway, 'received');
  let response = await fetch(base + '/api/start', { method: 'POST' }); const cookie = response.headers.get('set-cookie').split(';')[0]; await response.text(); await received;
  received = once(gateway, 'received');
  response = await fetch(base + '/api/start', { method: 'POST', headers: { cookie } }); await response.text(); await received;
  pending[0].end(JSON.stringify({ choices: [{ message: { content: 'e2e4' } }] }));
  pending[1].end(JSON.stringify({ choices: [{ message: { content: 'd2d4' } }] }));
  let state;
  for (let attempt = 0; attempt < 30; attempt++) {
    state = await (await fetch(base + '/api/state', { headers: { cookie } })).text();
    if (state.includes('busy="0"')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(state, /<ply from="d2" to="d4">d4<\/ply>/); assert.doesNotMatch(state, /<ply from="e2"/);
  received = once(gateway, 'received');
  response = await fetch(base + '/api/start', { method: 'POST', headers: { cookie } }); await response.text(); await received;
  pending[2].writeHead(503); pending[2].end('unavailable');
  for (let attempt = 0; attempt < 30; attempt++) {
    state = await (await fetch(base + '/api/state', { headers: { cookie } })).text();
    if (state.includes('busy="0"')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(state, /turn="w" busy="0"/); assert.match(state, /HTTP 503/); assert.doesNotMatch(state, /<ply /);
});
