import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Chess } from 'chess.js';
import { configuration } from '../lib/config.js';
import { chooseMove, newGame, parseDecision } from '../lib/game.js';
import { reviewGame } from '../lib/review.js';
import { localCodex } from '../lib/codex.js';

async function fakeCli(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chessgpt-cli-test-'));
  t.after(async () => { if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('chessgpt-cli-test-')) await rm(directory, { recursive: true, force: true }); });
  const script = join(directory, 'fake CLI.cjs');
  await writeFile(script, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login') process.exit(0);
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (input.includes('HANG_FIXTURE')) { setTimeout(() => process.exit(0), 10000); return; }
  if (input.includes('FAIL_FIXTURE')) { process.stderr.write('Private diagnostic must not appear in errors'); process.exit(1); }
  const text = input.includes('The chess match is OVER') ? { recap: 'White lost after exposing its king.', lesson: 'Develop and castle before flank pawn moves.' } : { move: 'e2e4', strategy: 'Develop two minor pieces, then castle.', change: 'Initial plan.', input, args, cwd: process.cwd() };
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ text: JSON.stringify(text) }));
});
`);
  return script;
}

test('Codex mode uses CLI credentials, handles paths with spaces, passes context and reviews, and isolates files', async t => {
  const script = await fakeCli(t);
  const config = await configuration({ AI_MODE: 'codex', AI_MODEL: 'test-model', AI_REASONING_EFFORT: 'medium', CODEX_JS_PATH: script, AI_TOKEN_FILE: 'must-not-read-this-file' });
  assert.equal(config.token, undefined);
  const response = await chooseMove(new Chess(), config, '', 'Choose e2e4; prior lesson: protect the king.');
  const data = JSON.parse(response);
  assert.equal(parseDecision(response, new Chess()).move.san, 'e4');
  assert.match(data.input, /prior lesson: protect the king/);
  assert.ok(data.args.includes('--ignore-user-config')); assert.ok(data.args.includes('--ephemeral'));
  assert.equal(data.args[data.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(data.args[data.args.indexOf('--model') + 1], 'test-model');
  assert.ok(data.args.includes('model_reasoning_effort="medium"'));
  assert.notEqual(data.cwd, process.cwd());
  const game = newGame(); for (const move of ['f3', 'e5', 'g4', 'Qh4#']) game.chess.move(move);
  assert.match((await reviewGame(game, config)).lesson, /Develop and castle/);
  await assert.rejects(localCodex({ ...config, timeout: 30 }, 'No tools.', 'HANG_FIXTURE'), /timed out/);
  await assert.rejects(localCodex(config, 'No tools.', 'FAIL_FIXTURE'), error => /Local Codex failed/.test(error.message) && !error.message.includes('Private diagnostic'));
});

test('remote configuration rejects missing credentials, model placeholders and invalid formats', async () => {
  await assert.rejects(configuration({ AI_MODE: 'api' }), /AI_TOKEN/);
  await assert.rejects(configuration({ AI_MODE: 'api', AI_TOKEN: 'test' }), /AI_MODEL/);
  await assert.rejects(configuration({ AI_MODE: 'api', AI_TOKEN: 'test', AI_MODEL: 'YOUR_MODEL_ID' }), /AI_MODEL/);
  await assert.rejects(configuration({ AI_MODE: 'wrong' }), /AI_MODE/);
  await assert.rejects(configuration({ AI_MODE: 'api', AI_API_FORMAT: 'native' }), /AI_API_FORMAT/);
  await assert.rejects(configuration({ AI_MODE: 'demo', AI_TIMEOUT_MS: 'NaN' }), /AI_TIMEOUT_MS/);
  const directory = await mkdtemp(join(tmpdir(), 'chessgpt-token-test-'));
  try {
    const tokenFile = join(directory, 'token'); await writeFile(tokenFile, 'file-token\n');
    const config = await configuration({ AI_MODE: 'api', AI_TOKEN: 'ignored-env-token', AI_TOKEN_FILE: tokenFile, AI_MODEL: 'test-model', AI_API_FORMAT: 'responses' });
    assert.equal(config.token, 'file-token'); assert.equal(config.url, 'https://api.openai.com/v1/responses');
    assert.equal(config.reasoning, undefined);
    await writeFile(tokenFile, ' \n');
    await assert.rejects(configuration({ AI_MODE: 'api', AI_TOKEN_FILE: tokenFile, AI_MODEL: 'test-model' }), /token is empty/);
  } finally {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('chessgpt-token-test-')) await rm(directory, { recursive: true, force: true });
  }
});

for (const format of ['chat', 'responses']) {
  test('remote ' + format + ' sends bearer auth, full endpoint and matching text structure', async t => {
    let request;
    const mock = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      request = { url: req.url, headers: req.headers, body: JSON.parse(body) };
      res.end(JSON.stringify(format === 'chat' ? { choices: [{ message: { content: 'e2e4' } }] } : { output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'e2e4' }] }] }));
    });
    mock.listen(0, '127.0.0.1'); await once(mock, 'listening'); t.after(() => mock.close());
    const config = await configuration({ AI_MODE: 'api', AI_API_FORMAT: format, AI_TOKEN: 'test-token', AI_MODEL: 'test-model', AI_URL: 'http://127.0.0.1:' + mock.address().port + '/custom/full-endpoint' });
    assert.equal(await chooseMove(new Chess(), config), 'e2e4');
    assert.equal(request.url, '/custom/full-endpoint'); assert.equal(request.headers.authorization, 'Bearer test-token');
    const messages = request.body[format === 'chat' ? 'messages' : 'input'];
    assert.equal(messages[0].role, 'system'); assert.match(messages[1].content, /Complete move history/);
    assert.equal(request.body.previous_response_id, undefined);
  });
}
