import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Chess } from 'chess.js';
import { promptFor, parseDecision, newGame } from '../lib/game.js';
import { createApp } from '../server.js';

test('prompt carries the full ordered SAN/UCI history and saved plan', () => {
  const chess = new Chess();
  for (const move of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']) chess.move(move);
  const prompt = promptFor(chess, 'Develop and castle, then pressure the center.');
  assert.match(prompt, /1\. White: e4 \[e2e4\]\n2\. Black: e5 \[e7e5\]\n3\. White: Nf3 \[g1f3\]\n4\. Black: Nc6 \[b8c6\]\n5\. White: Bc4 \[f1c4\]\n6\. Black: Nf6 \[g8f6\]/);
  assert.match(prompt, /Latest opponent move: Nf6 \[g8f6\]/);
  assert.ok(prompt.includes('Develop and castle, then pressure the center.'));
  assert.match(prompt, /Tactics take priority/);
  assert.match(promptFor(newGame().chess), /\(No moves played\.\)/);
});

test('structured decisions validate both move and bounded strategy', () => {
  const chess = new Chess();
  const decision = parseDecision(JSON.stringify({ move: 'e2e4', strategy: 'Develop and castle.', change: 'Initial plan.' }), chess);
  assert.equal(decision.move.san, 'e4'); assert.equal(decision.strategy, 'Develop and castle.');
  assert.equal(parseDecision('e2e4', chess, 'Existing plan.').strategy, 'Existing plan.');
  for (const response of [null, {}, { move: 'e2e5', strategy: 'Attack.', change: 'Change.' },
    { move: 'e2e4', strategy: '', change: 'Change.' },
    { move: 'e2e4', strategy: 'x'.repeat(801), change: 'Change.' },
    { move: 'e2e4', strategy: 'Plan.', change: 'x'.repeat(241) }]) {
    assert.throws(() => parseDecision(JSON.stringify(response), chess));
  }
  assert.equal(chess.history().length, 0);
});

test('gateway carries strategy through turns and retries, and clears it on restart', async t => {
  const requests = [];
  const replies = [
    { move: 'e2e4', strategy: 'Develop and castle.', change: 'Initial plan.' },
    { move: 'e2e5', strategy: 'This invalid plan must not persist.', change: 'Invalid.' },
    { move: 'g1f3', strategy: 'Develop and castle.', change: 'Plan unchanged.' },
    { move: 'd2d4', strategy: 'Open the center while Black moves flank pawns.', change: 'Black spent another tempo on the a-pawn.' },
    { move: 'e2e4', strategy: 'Fresh opening plan.', change: 'Initial plan.' }
  ];
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[requests.length - 1]) } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const app = createApp({ mode: 'gateway', url: 'http://127.0.0.1:' + mock.address().port, token: 'test', model: 'default', timeout: 2000 });
  app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.address().port;
  const start = await fetch(base + '/api/start', { method: 'POST' });
  const cookie = start.headers.get('set-cookie').split(';')[0]; await start.text();
  async function ready() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const state = await (await fetch(base + '/api/state', { headers: { cookie } })).text();
      if (state.includes('busy="0"')) return state;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('White did not finish');
  }
  async function action(path, body = '') {
    const response = await fetch(base + path, { method: 'POST', headers: { cookie }, body });
    assert.equal(response.status, 200); await response.text(); return ready();
  }
  assert.match(await ready(), /<strategy>Develop and castle\.<\/strategy>/);
  let state = await action('/api/move', 'from=a7&to=a6');
  assert.match(state, /AI returned an illegal move/);
  assert.match(state, /<strategy>Develop and castle\.<\/strategy>/);
  assert.equal((state.match(/<ply /g) || []).length, 2);
  state = await action('/api/retry'); assert.match(state, /<change>Plan unchanged\.<\/change>/);
  state = await action('/api/move', 'from=a6&to=a5');
  assert.match(state, /<strategy>Open the center while Black moves flank pawns\.<\/strategy>/);
  assert.ok(requests[1].messages[1].content.includes('2. Black: a6 [a7a6]'));
  assert.ok(requests[2].messages[1].content.includes('Develop and castle.'));
  assert.ok(!requests[2].messages[1].content.includes('This invalid plan must not persist.'));
  assert.ok(requests[3].messages[1].content.includes('3. White: Nf3 [g1f3]\n4. Black: a5 [a6a5]'));
  const recap = await (await fetch(base + '/api/recap', { headers: { cookie } })).text();
  assert.equal((recap.match(/\/ AI White turn/g) || []).length, 4);
  assert.equal((recap.match(/\nREQUEST:/g) || []).length, 4);
  assert.equal((recap.match(/\nREPLY:/g) || []).length, 4);
  assert.match(recap, /ERROR: White could not move\. AI returned an illegal move/);
  assert.match(recap, /Strategy: Develop and castle\./);
  assert.match(recap, /Plan update: Black spent another tempo/);
  state = await action('/api/start'); assert.match(state, /<strategy>Fresh opening plan\.<\/strategy>/);
  assert.equal((state.match(/<ply /g) || []).length, 1);
  assert.ok(requests[4].messages[1].content.includes('(No moves played.)'));
  assert.ok(requests[4].messages[1].content.includes('(Not established.)'));
  assert.ok(!requests[4].messages[1].content.includes('Open the center while Black moves flank pawns.'));
  const previous = await (await fetch(base + '/api/recap?match=previous', { headers: { cookie } })).text();
  assert.match(previous, /5\. White: d4 \[d2d4\]/);
  assert.match(previous, /ERROR: White could not move/);
});
