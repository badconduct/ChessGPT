import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Chess } from 'chess.js';
import { assistanceFor, candidatesWithin, positionFacts } from '../lib/engine.js';
import { createApp } from '../server.js';

test('assisted modes require the missed mate from the recorded match; pure does not use an engine', async () => {
  const chess = new Chess('8/5p1p/n2Q4/pk6/2p3p1/5b2/PPPRN2P/2K5 w - - 3 28');
  const unexpected = () => { throw new Error('Engine must not be needed'); };
  for (const difficulty of ['easy', 'normal', 'hard']) assert.deepEqual((await assistanceFor(chess, difficulty, unexpected)).allowed, ['e2c3']);
  assert.equal((await assistanceFor(chess, 'pure', unexpected)).allowed, null);
  assert.match(positionFacts(new Chess('2R1Q3/8/2K2k2/2P5/8/8/8/8 w - - 19 83')), /Lone-king conversion/);
});

test('difficulty bands handle centipawns and prefer the fastest proven mate', () => {
  const scores = [300, 265, 200, 50, 49].map((score, i) => ({ move: String(i), score, type: 'cp' }));
  assert.equal(candidatesWithin(scores, 35).length, 2);
  assert.equal(candidatesWithin(scores, 100).length, 3);
  assert.equal(candidatesWithin(scores, 250).length, 4);
  assert.deepEqual(candidatesWithin([{ move: 'a', type: 'mate', score: 4 }, { move: 'b', type: 'mate', score: 2 }, { move: 'c', type: 'cp', score: 2000 }], 250).map(entry => entry.move), ['b']);
  assert.equal(candidatesWithin([{ move: 'a', type: 'mate', score: -2 }, { move: 'b', type: 'mate', score: -8 }], 35)[0].move, 'b');
});

test('real Stockfish excludes the recorded hanging-knight move and finds a winning conversion', async () => {
  const hanging = await assistanceFor(new Chess('8/8/8/5N1R/6k1/8/PPP5/2K5 w - - 0 52'), 'hard');
  assert.ok(hanging.allowed.length);
  assert.ok(!hanging.allowed.includes('h5h4'));
  const conversion = await assistanceFor(new Chess('2R1Q3/8/2K2k2/2P5/8/8/8/8 w - - 19 83'), 'hard');
  assert.match(conversion.summary, /mate [1-9]/);
});

test('assisted HTTP turns reject unsafe AI candidates, retain every reply, and fail without substitution', async t => {
  const requests = [];
  let engineFails = false, alwaysReject = false;
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const content = JSON.stringify({ move: alwaysReject || requests.length === 1 ? 'a2a3' : 'e2e4', strategy: 'Develop pieces; next target Nf3 and castling.', change: 'Initial plan.' });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const app = createApp({ mode: 'gateway', url: 'http://127.0.0.1:' + mock.address().port, token: 'test', model: 'default', timeout: 2000,
    analyzer: async () => { if (engineFails) throw new Error('Engine unavailable'); return [{ move: 'e2e4', type: 'cp', score: 20, depth: 10 }]; } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.address().port;
  let cookie = '';
  async function start() {
    const response = await fetch(base + '/api/start', { method: 'POST', headers: cookie ? { cookie } : {}, body: 'difficulty=hard' });
    assert.equal(response.status, 200); cookie = response.headers.get('set-cookie').split(';')[0]; await response.text();
    for (let i = 0; i < 100; i++) {
      const state = await (await fetch(base + '/api/state', { headers: { cookie } })).text();
      if (state.includes('busy="0"')) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('White never completed');
  }
  let state = await start();
  assert.equal(requests.length, 2); assert.match(state, />e4<\/ply>/);
  assert.match(requests[1].messages[1].content, /previous reply was rejected/);
  const recap = await (await fetch(base + '/api/recap', { headers: { cookie } })).text();
  assert.match(recap, /REJECTED REPLY:/); assert.match(recap, /a2a3/); assert.match(recap, /Difficulty: hard/);
  alwaysReject = true; state = await start();
  assert.equal(requests.length, 5); assert.ok(!state.includes('<ply ')); assert.match(state, /outside the permitted/);
  engineFails = true; state = await start();
  assert.equal(requests.length, 5); assert.ok(!state.includes('<ply ')); assert.match(state, /Engine unavailable/);
  const bad = await fetch(base + '/api/start', { method: 'POST', headers: { cookie }, body: 'difficulty=impossible' });
  assert.equal(bad.status, 422);
});
