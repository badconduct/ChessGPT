import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Chess } from 'chess.js';
import { stateXml } from '../server.js';
import { newGame } from '../lib/game.js';

const script = await readFile(new URL('../public/client.js', import.meta.url), 'utf8');
// Minimal DOM adapter for executing the shipped ES3 client against server XML.
function xmlRoot(xml) {
  function attributes(source) {
    return name => new RegExp('(?:^|\\s)' + name + '="([^"]*)"').exec(source)?.[1] ?? null;
  }
  return {
    getAttribute: attributes(/<game ([^>]*)>/.exec(xml)[1]),
    getElementsByTagName(tag) {
      return [...xml.matchAll(new RegExp('<' + tag + '(?: ([^>]*))?(?:/>|>([\\s\\S]*?)</' + tag + '>)', 'g'))]
        .map(match => ({ getAttribute: attributes(match[1] || ''), text: match[2] || '' }));
    }
  };
}
function client(fen) {
  const nodes = { promotion: { innerHTML: '', style: { display: 'none' } } }, requests = [];
  const context = vm.createContext({
    document: { getElementById(id) {
      return nodes[id] ||= { innerHTML: '', style: { display: 'none' } };
    } },
    window: { clearTimeout() {}, setTimeout() { return 1; },
      prompt() { throw new Error('Native prompt must not be needed'); } }
  });
  vm.runInContext(script, context);
  const game = newGame(); game.chess = new Chess(fen);
  const root = xmlRoot(stateXml(game, 'demo'));
  const browserRequest = context.request;
  context.request = (path, data) => requests.push({ path, data });
  context.render(root);
  return { context, nodes, requests, root, game, browserRequest };
}

test('post-game review waits before automatic restart, stays visible next game and forget uses XMLHTTP', () => {
  const { context, nodes, requests, game } = client('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  let scheduled;
  context.window.setTimeout = (fn, ms) => { scheduled = { fn, ms }; return 1; };
  game.reviewBusy = true; context.render(xmlRoot(stateXml(game, 'gateway')));
  assert.equal(scheduled.ms, 1000); assert.equal(nodes.start.disabled, true);
  assert.match(nodes.matchreview.innerHTML, /reviewing the match/);
  game.reviewBusy = false; game.review = 'Black won after White weakened its king.';
  context.render(xmlRoot(stateXml(game, 'gateway')));
  assert.equal(scheduled.ms, 8000); assert.equal(nodes.start.disabled, false);
  assert.match(nodes.matchreview.innerHTML, /Match review: Black won/);
  const next = newGame(); next.previousReview = game.review; next.lesson = 'Develop and castle before flank pawn pushes.';
  context.render(xmlRoot(stateXml(next, 'gateway')));
  assert.match(nodes.matchreview.innerHTML, /Previous match: Black won/);
  assert.equal(nodes.forgetlesson.style.display, 'inline');
  context.forgetLesson(); assert.deepEqual(requests, [{ path: '/api/forget', data: '' }]);
});

test('page exposes all promotion choices and cancellation', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="promotion"/);
  for (const piece of ['q', 'r', 'b', 'n']) assert.ok(html.includes("choosePromotion('" + piece + "')"));
  assert.ok(html.includes('cancelPromotion()'));
});

for (const [description, fen, destination] of [
  ['advance', '7k/8/8/8/8/8/p7/7K b - - 0 1', 'a1'],
  ['capture', '7k/8/8/8/8/8/p7/1R5K b - - 0 1', 'b1']
]) {
  for (const piece of ['q', 'r', 'b', 'n']) {
    test(`Black promotion ${description}: visible chooser submits ${piece}`, () => {
      const { context, nodes, requests, root, game } = client(fen);
      context.clickSquare('a2'); context.clickSquare(destination);
      assert.equal(nodes.promotion.style.display, 'block');
      assert.equal(requests.length, 0, 'do not send before choice');
      assert.ok(game.chess.get('a2'), 'pawn stays in place until choice');
      // Clock polling must not dismiss the pending choice or overwrite its instruction.
      context.render(root);
      assert.equal(nodes.promotion.style.display, 'block');
      assert.match(nodes.status.innerHTML, /Choose Queen/);
      context.choosePromotion(piece);
      assert.equal(nodes.promotion.style.display, 'none');
      assert.deepEqual(requests, [{ path: '/api/move', data: 'from=a2&to=' + destination + '&promotion=' + piece }]);
      const sent = new URLSearchParams(requests[0].data);
      game.chess.move({ from: sent.get('from'), to: sent.get('to'), promotion: sent.get('promotion') });
      assert.equal(game.chess.get(destination).type, piece);
      context.choosePromotion(piece); assert.equal(requests.length, 1, 'ignore double choice');
    });
  }
}
test('promotion cancel and restart do not submit a pawn move', () => {
  const { context, nodes, requests } = client('7k/8/8/8/8/8/p7/7K b - - 0 1');
  context.clickSquare('a2'); context.clickSquare('a1'); context.cancelPromotion();
  assert.equal(requests.length, 0); assert.equal(nodes.promotion.style.display, 'none');
  assert.equal(context.selected, ''); assert.equal(context.pendingPromotion, null);
  context.clickSquare('a2'); context.clickSquare('a1'); context.choosePromotion('k');
  assert.equal(requests.length, 0); assert.equal(nodes.promotion.style.display, 'block');
  context.startGame(); assert.equal(nodes.promotion.style.display, 'none');
  assert.deepEqual(requests, [{ path: '/api/start', data: 'difficulty=normal' }]);
});
test('ordinary pawn move sends immediately without a promotion chooser', () => {
  const { context, nodes, requests } = client('7k/8/8/8/8/p7/8/7K b - - 0 1');
  context.clickSquare('a3'); context.clickSquare('a2');
  assert.equal(nodes.promotion.style.display, 'none');
  assert.deepEqual(requests, [{ path: '/api/move', data: 'from=a3&to=a2&promotion=' }]);
});

for (const fallback of [false, true]) {
  test('promotion works through ' + (fallback ? 'Microsoft.XMLHTTP fallback' : 'Msxml2.XMLHTTP') + ' without native XMLHttpRequest', () => {
    const { context, nodes, root, browserRequest } = client('7k/8/8/8/8/8/p7/7K b - - 0 1');
    const constructors = [], sent = {};
    context.ActiveXObject = function (name) {
      constructors.push(name);
      if (fallback && name === 'Msxml2.XMLHTTP') throw new Error('ProgID unavailable');
      return {
        open(method, url, async) { Object.assign(sent, { method, url, async }); },
        setRequestHeader(name, value) { sent[name] = value; },
        send(body) {
          sent.body = body; this.status = 200; this.readyState = 4;
          this.responseXML = { documentElement: root }; this.onreadystatechange();
        }
      };
    };
    context.request = browserRequest;
    assert.equal(context.window.XMLHttpRequest, undefined);
    context.clickSquare('a2'); context.clickSquare('a1'); context.choosePromotion('n');
    assert.deepEqual(constructors, fallback ? ['Msxml2.XMLHTTP', 'Microsoft.XMLHTTP'] : ['Msxml2.XMLHTTP']);
    assert.equal(sent.method, 'POST'); assert.equal(sent.async, true);
    assert.match(sent.url, /^\/api\/move\?t=\d+$/);
    assert.equal(sent['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(sent.body, 'from=a2&to=a1&promotion=n');
    assert.equal(nodes.promotion.style.display, 'none');
    assert.equal(context.sending, false);
    assert.match(nodes.status.innerHTML, /Your move/);
  });
}

test('starting and restarting with the legacy DOM keeps each ASCII rank on its own line', () => {
  const { context, nodes, game } = client('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  nodes.ascii.innerText = ''; nodes.prompt.innerText = '';
  // IE6's PRE HTML parser loses newlines; don't let this adapter hide that path.
  Object.defineProperty(nodes.ascii, 'innerHTML', {
    set(value) { throw new Error('ASCII must not be sent through the legacy HTML parser'); }
  });
  for (const fen of [game.chess.fen(), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', game.chess.fen()]) {
    game.chess = new Chess(fen);
    game.lastPrompt = 'Board follows:\n<literal & text>\nChoose a move.';
    const root = xmlRoot(stateXml(game, 'api'));
    const getTags = root.getElementsByTagName;
    root.getElementsByTagName = tag => tag === 'prompt' ? [{ text: game.lastPrompt }] : getTags(tag);
    context.render(root);
    assert.equal(nodes.ascii.innerText.split('\r\n').join('\n'), game.chess.ascii());
    assert.equal(nodes.prompt.innerText, 'Board follows:\r\n<literal & text>\r\nChoose a move.');
  }
});

for (const legacyText of [true, false]) {
  test('recap uses ActiveX and displays literal replies with ' + (legacyText ? 'IE6 innerText' : 'escaped HTML'), () => {
    const { context, nodes } = client('7k/8/8/8/8/8/p7/7K b - - 0 1');
    const content = '1. White: e4\n<script>alert(1)</script>\n2. Black: a6';
    const calls = [];
    context.document.getElementById('recap');
    if (legacyText) nodes.recap.innerText = '';
    context.ActiveXObject = function () {
      return { open(method, url) { calls.push({ method, url }); }, send(body) {
        assert.equal(body, null); this.readyState = 4; this.status = 200;
        this.responseText = content; this.onreadystatechange();
      } };
    };
    context.recapPrevious = true;
    context.selectRecap('previous');
    assert.match(calls[0].url, /\/api\/recap\?match=previous&t=/);
    assert.equal(nodes.downloadrecap.href, '/api/recap?match=previous&download=1');
    if (legacyText) assert.equal(nodes.recap.innerText, content.replace(/\n/g, '\r\n'));
    else { assert.match(nodes.recap.innerHTML, /&lt;script&gt;/); assert.ok(nodes.recap.innerHTML.includes('\n')); }
  });
}

test('old server response explains missing recap support and prevents broken downloads', () => {
  const { context, nodes, game } = client('7k/8/8/8/8/8/p7/7K b - - 0 1');
  context.window.location = { port: '3080', hostname: 'localhost' };
  const oldXml = stateXml(game, 'demo').replace(/ recapVersion="[^"]*"/, '');
  context.render(xmlRoot(oldXml));
  assert.equal(nodes.servernotice.style.display, 'block');
  assert.match(nodes.servernotice.innerHTML, /http:\/\/localhost:3081\//);
  context.ActiveXObject = function () { throw new Error('Do not request an unsupported endpoint'); };
  context.togglePrompt();
  assert.match(nodes.recap.innerHTML, /older server does not have the recap endpoint/);
  assert.equal(context.allowRecapDownload(), false);
});
