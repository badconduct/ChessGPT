import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server.js';

test('full match recap survives board restart and is saved on disk', async t => {
  const prefix = join(tmpdir(), 'chessgpt-recap-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  const app = createApp({ mode: 'demo', recapDir: directory });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.close(); await once(app, 'close'); });
  const base = 'http://127.0.0.1:' + app.address().port;
  assert.equal((await fetch(base + '/api/recap')).status, 404);
  const start = await fetch(base + '/api/start', { method: 'POST' });
  const cookie = start.headers.get('set-cookie').split(';')[0]; await start.text();
  async function stable() {
    for (let i = 0; i < 50; i++) {
      const recap = await (await fetch(base + '/api/recap', { headers: { cookie } })).text();
      const files = await readdir(directory);
      const id = /Match: ([a-f0-9]+)/.exec(recap)[1];
      if (!recap.includes('Waiting for reply.') && files.includes(id + '.txt')) {
        const saved = await readFile(join(directory, id + '.txt'), 'utf8');
        if (saved === recap) return recap;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Recap was not persisted');
  }
  await stable();
  const move = await fetch(base + '/api/move', { method: 'POST', headers: { cookie }, body: 'from=a7&to=a6' });
  assert.equal(move.status, 200); await move.text();
  const recap = await stable();
  assert.match(recap, /1\. White: .*\n2\. Black: a6 \[a7a6\]\n3\. White:/);
  assert.match(recap, /Human Black turn\nMove: a6/);
  assert.equal((recap.match(/Local practice White turn/g) || []).length, 2);
  assert.doesNotMatch(recap, /REQUEST:/);
  const download = await fetch(base + '/api/recap?download=1', { headers: { cookie } });
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.match(download.headers.get('content-type'), /text\/plain/);
  assert.equal(await download.text(), recap);
  const reset = await fetch(base + '/api/start', { method: 'POST', headers: { cookie } });
  const state = await reset.text(); assert.match(state, /previous="1"/);
  const previous = await (await fetch(base + '/api/recap?match=previous', { headers: { cookie } })).text();
  assert.match(previous, /Restarted before completion/);
  assert.match(previous, /2\. Black: a6 \[a7a6\]/);
  const fresh = await stable(); assert.doesNotMatch(fresh, /Human Black turn/);
  const files = (await readdir(directory)).filter(file => file.endsWith('.txt'));
  assert.equal(files.length, 2);
  const oldId = /Match: ([a-f0-9]+)/.exec(previous)[1];
  assert.equal(await readFile(join(directory, oldId + '.txt'), 'utf8'), previous);
});
