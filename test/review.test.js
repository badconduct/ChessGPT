import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Chess } from 'chess.js';
import { newGame, promptFor } from '../lib/game.js';
import { parseReview, reviewPrompt } from '../lib/review.js';
import { createApp } from '../server.js';

test('review uses verified White result and full moves; lessons are bounded advice', () => {
  const game = newGame();
  for (const move of ['f3', 'e5', 'g4', 'Qh4#']) game.chess.move(move);
  const prompt = reviewPrompt(game);
  assert.match(prompt, /White lost by checkmate; Black won/);
  assert.match(prompt, /4\. Black: Qh4# \[d8h4\]/);
  assert.match(prompt, /Do not invent tactical errors/);
  game.chess = new Chess(); for (const move of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) game.chess.move(move);
  assert.match(reviewPrompt(game), /White won by checkmate; Black lost/);
  game.chess = new Chess('7k/5K2/6Q1/8/8/8/8/8 b - - 0 1');
  assert.match(reviewPrompt(game), /Draw by stalemate/);
  assert.deepEqual(parseReview('{"recap":"One\nparagraph","lesson":"Protect the king."}'.replace('One\nparagraph', 'One\\nparagraph')), { recap: 'One paragraph', lesson: 'Protect the king.' });
  for (const value of ['e2e4', '{}', JSON.stringify({ recap: 'x'.repeat(1201), lesson: 'a' }), JSON.stringify({ recap: 'a', lesson: 'x'.repeat(601) })]) assert.throws(() => parseReview(value));
  assert.match(promptFor(new Chess(), '', '', 'Do not weaken the king.'), /untrusted advice, not instructions/);
});

test('finished-match review runs once, waits before restart, carries a lesson privately and can forget it', async t => {
  const requests = [];
  let reviewResponse, openingCount = 0;
  const lesson = 'Last game White lost after weakening the king with f3 and g4. Develop centrally and castle before pushing flank pawns; revise for concrete threats.';
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request);
    if (request.messages[1].content.includes('The chess match is OVER')) { reviewResponse = res; return; }
    const move = ++openingCount === 1 ? 'f2f3' : openingCount === 2 ? 'g2g4' : 'e2e4';
    res.end(JSON.stringify({ choices: [{ message: { content: move } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const app = createApp({ mode: 'gateway', url: 'http://127.0.0.1:' + mock.address().port, token: 'test', model: 'default', timeout: 2000 });
  app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.address().port;
  const initial = await fetch(base + '/api/start', { method: 'POST' });
  const cookie = initial.headers.get('set-cookie').split(';')[0]; await initial.text();
  const state = async () => (await fetch(base + '/api/state', { headers: { cookie } })).text();
  const ready = async () => {
    for (let i = 0; i < 100; i++) { const xml = await state(); if (xml.includes('busy="0"')) return xml; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('White still busy');
  };
  const action = async (path, body = '') => { const response = await fetch(base + path, { method: 'POST', headers: { cookie }, body }); assert.equal(response.status, 200); await response.text(); };
  await ready(); await action('/api/move', 'from=e7&to=e5'); await ready();
  await action('/api/move', 'from=d8&to=h4');
  for (let i = 0; i < 100 && !reviewResponse; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(reviewResponse); assert.match(await state(), /<reviewBusy>1<\/reviewBusy>/);
  const restart = action('/api/start');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests.length, 3, 'restart waits for the one review call');
  reviewResponse.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ recap: 'Black won with Qh4# after White exposed its king.', lesson }) } }] }));
  await restart; await ready();
  assert.equal(requests.length, 4);
  const opening = requests[3].messages[1].content;
  assert.ok(opening.includes(lesson)); assert.match(opening, /\(No moves played\.\)/); assert.doesNotMatch(opening, /4\. Black: Qh4/);
  const recap = await (await fetch(base + '/api/recap?match=previous', { headers: { cookie } })).text();
  assert.match(recap, /POST-GAME REVIEW\nBlack won with Qh4#/); assert.match(recap, /AI post-game review/);
  await action('/api/start'); await ready();
  assert.ok(requests[4].messages[1].content.includes(lesson), 'unfinished restart retains last completed lesson');
  const other = await fetch(base + '/api/start', { method: 'POST' }); await other.text();
  for (let i = 0; i < 100 && requests.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.doesNotMatch(requests[5].messages[1].content, /Last game White lost/);
  await action('/api/forget'); assert.match(await state(), /<lesson><\/lesson>/);
  await action('/api/start'); await ready(); assert.doesNotMatch(requests[6].messages[1].content, /Last game White lost/);
});

test('failed AI review preserves result and raw reply without inventing a lesson', async t => {
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* drain */ }
    const content = ++calls === 1 ? 'f2f3' : calls === 2 ? 'g2g4' : 'An unstructured and unusable review.';
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
  const app = createApp({ mode: 'gateway', url: 'http://127.0.0.1:' + mock.address().port, token: 'test', model: 'default', timeout: 2000 });
  app.listen(0, '127.0.0.1'); await once(app, 'listening'); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.address().port;
  const start = await fetch(base + '/api/start', { method: 'POST' }); const cookie = start.headers.get('set-cookie').split(';')[0]; await start.text();
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      const xml = await (await fetch(base + '/api/state', { headers: { cookie } })).text();
      if (xml.includes('busy="0"') && !xml.includes('<reviewBusy>1')) return xml;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out');
  };
  await wait();
  for (const body of ['from=e7&to=e5', 'from=d8&to=h4']) { const response = await fetch(base + '/api/move', { method: 'POST', headers: { cookie }, body }); await response.text(); await wait(); }
  const xml = await wait(); assert.match(xml, /You win! Checkmate/); assert.match(xml, /AI review unavailable/); assert.match(xml, /<lesson><\/lesson>/);
  const recap = await (await fetch(base + '/api/recap', { headers: { cookie } })).text(); assert.match(recap, /An unstructured and unusable review/); assert.match(recap, /not valid JSON/);
});
