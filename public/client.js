/* Deliberately ES3: no JSON, Unicode pieces, SVG, canvas or modern DOM APIs. */
var state = null, selected = '', squares = {}, poll = null, sending = false, failures = 0, pendingPromotion = null;
var recapMatch = 'current', recapKey = '', recapLoaded = '', recapPrevious = false;
var recapSupported = false;
function el(id) { return document.getElementById(id); }
function text(node) { return node ? (typeof node.text !== 'undefined' ? node.text : node.textContent) : ''; }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function preText(node, value) {
  // IE6 reparses PRE innerHTML and collapses its newlines. Use literal text.
  if (typeof node.innerText !== 'undefined') node.innerText = String(value).replace(/\r\n|\r|\n/g, '\r\n');
  else node.innerHTML = escapeHtml(value);
}
function init() {
  var html = '<table class="chessboard" width="382" cellspacing="0" cellpadding="0"><colgroup><col width="18"><col span="8" width="44"></colgroup><tr><td class="axis"></td>', r, f, sq;
  for (f = 7; f >= 0; f--) html += '<td class="fileaxis">' + 'abcdefgh'.charAt(f) + '</td>';
  html += '</tr>';
  for (r = 1; r <= 8; r++) {
    html += '<tr><td class="axis">' + r + '</td>';
    for (f = 7; f >= 0; f--) { sq = 'abcdefgh'.charAt(f) + r; html += '<td id="cell_' + sq + '" class="' + ((f + r) % 2 ? 'light' : 'dark') + '"><a class="square" id="sq_' + sq + '" href="#" title="' + sq + '" onclick="clickSquare(\'' + sq + '\'); return false;"></a></td>'; }
    html += '</tr>';
  }
  el('board').innerHTML = html + '</table>';
  var back = 'rnbqkbnr';
  for (f = 0; f < 8; f++) { squares['abcdefgh'.charAt(f) + '1'] = 'w' + back.charAt(f); squares['abcdefgh'.charAt(f) + '2'] = 'wp'; squares['abcdefgh'.charAt(f) + '7'] = 'bp'; squares['abcdefgh'.charAt(f) + '8'] = 'b' + back.charAt(f); }
  drawBoard();
}
function xhr() {
  if (window.XMLHttpRequest) return new XMLHttpRequest();
  try { return new ActiveXObject('Msxml2.XMLHTTP'); } catch (e) { return new ActiveXObject('Microsoft.XMLHTTP'); }
}
function request(path, data, done) {
  var x;
  try { x = xhr(); } catch (e) { el('status').innerHTML = 'Enable ActiveX XMLHTTP to play.'; return; }
  x.open(data === null ? 'GET' : 'POST', path + '?t=' + new Date().getTime(), true);
  if (data !== null) x.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  x.onreadystatechange = function () {
    if (x.readyState !== 4) return;
    sending = false;
    if ((x.status === 200 || x.status === 409 || x.status === 422) && x.responseXML && x.responseXML.documentElement) {
      failures = 0; render(x.responseXML.documentElement); if (done) done();
    } else { el('status').innerHTML = 'Connection interrupted. Retry or restart.'; el('retry').disabled = false; el('start').disabled = false; if (state && state.busy && failures++ < 3) poll = window.setTimeout(refresh, 2000); }
  };
  x.send(data);
}
function startGame() { if (sending) return; closePromotion(); sending = true; window.clearTimeout(poll); selected = ''; el('start').disabled = true; request('/api/start', 'difficulty=' + encodeURIComponent(el('difficulty').value || 'normal')); }
function retryWhite() { if (sending) return; sending = true; request('/api/retry', ''); }
function forgetLesson() { if (sending) return; sending = true; request('/api/forget', ''); }
function refresh() { request('/api/state', null); }
function clock(ms) { var seconds = Math.floor(Number(ms) / 1000), mins = Math.floor(seconds / 60); return (mins < 10 ? '0' : '') + mins + ':' + (seconds % 60 < 10 ? '0' : '') + seconds % 60; }
function render(root) {
  window.clearTimeout(poll);
  state = { turn: root.getAttribute('turn'), busy: root.getAttribute('busy') === '1', ended: root.getAttribute('ended') === '1', legal: root.getElementsByTagName('move') };
  var pieces = root.getElementsByTagName('piece'), history = root.getElementsByTagName('ply'), i, html = '<table class="movetable" cellspacing="0">';
  squares = {}; for (i = 0; i < pieces.length; i++) squares[pieces[i].getAttribute('square')] = pieces[i].getAttribute('code');
  state.lastFrom = history.length ? history[history.length - 1].getAttribute('from') : '';
  state.lastTo = history.length ? history[history.length - 1].getAttribute('to') : '';
  drawBoard();
  el('status').innerHTML = escapeHtml(text(root.getElementsByTagName('status')[0]));
  if (pendingPromotion) {
    if (state.busy || state.ended || state.turn !== 'b' || !legalMove(pendingPromotion.from, pendingPromotion.to, 'q')) closePromotion();
    else el('status').innerHTML = 'Choose Queen, Rook, Bishop or Knight below the board.';
  }
  var aiMode = root.getAttribute('mode');
  el('mode').innerHTML = aiMode === 'demo' ? 'LOCAL PRACTICE / ChatGPT is not connected' : aiMode === 'codex' ? 'LOCAL CODEX CLI / AI opponent' : aiMode === 'api' ? 'REMOTE API / AI opponent' : 'DOCKERNET AI / ChatGPT connected';
  var difficulty = text(root.getElementsByTagName('difficulty')[0]);
  el('opponent').innerHTML = escapeHtml(difficulty) + (root.getAttribute('mode') === 'demo' ? ' / local practice' : difficulty === 'Pure ChatGPT' ? ' / legality only' : ' / Stockfish checks; ChatGPT chooses');
  el('whiteclock').innerHTML = clock(root.getAttribute('white')); el('blackclock').innerHTML = clock(root.getAttribute('black'));
  for (i = 0; i < history.length; i += 2) html += '<tr><td class="number">' + (i / 2 + 1) + '.</td><td>' + escapeHtml(text(history[i])) + '</td><td>' + (history[i + 1] ? escapeHtml(text(history[i + 1])) : '&middot;') + '</td></tr>';
  el('history').innerHTML = history.length ? html + '</table>' : '<p class="subtle">Waiting for White\'s opening.</p>';
  el('history').scrollTop = el('history').scrollHeight;
  el('movecount').innerHTML = ' / ' + Math.ceil(history.length / 2);
  preText(el('ascii'), text(root.getElementsByTagName('ascii')[0]));
  preText(el('prompt'), text(root.getElementsByTagName('prompt')[0]));
  el('reply').innerHTML = 'Reply: ' + escapeHtml(text(root.getElementsByTagName('reply')[0]));
  el('strategy').innerHTML = 'White strategy: ' + escapeHtml(text(root.getElementsByTagName('strategy')[0]) || 'Not established.');
  el('strategychange').innerHTML = 'Plan update: ' + escapeHtml(text(root.getElementsByTagName('change')[0]) || 'None.');
  recapKey = (root.getAttribute('match') || '') + ':' + (root.getAttribute('recapVersion') || '');
  recapSupported = root.getAttribute('recapVersion') !== null && root.getAttribute('recapVersion') !== '';
  el('servernotice').style.display = recapSupported ? 'none' : 'block';
  if (!recapSupported) {
    el('servernotice').innerHTML = 'This is an older ChessGPT server without full match recaps. ';
    if (window.location && window.location.port === '3080') el('servernotice').innerHTML += '<a href="http://' + escapeHtml(window.location.hostname) + ':3081/">Open the connected version on port 3081.</a>';
    else el('servernotice').innerHTML += 'Restart the server with the updated application.';
  }
  recapPrevious = root.getAttribute('previous') === '1';
  el('previousrecap').disabled = !recapPrevious;
  if (el('exchange').style.display === 'block' && recapLoaded !== recapKey + ':' + recapMatch) loadRecap();
  var reviewBusy = text(root.getElementsByTagName('reviewBusy')[0]) === '1', review = text(root.getElementsByTagName('review')[0]), lesson = text(root.getElementsByTagName('lesson')[0]), reviewError = text(root.getElementsByTagName('reviewError')[0]);
  el('matchreview').style.display = review || reviewBusy || reviewError ? 'block' : 'none';
  el('matchreview').innerHTML = escapeHtml(reviewBusy ? 'ChatGPT is reviewing the match...' : reviewError || (state.ended ? 'Match review: ' : 'Previous match: ') + review);
  el('matchlesson').style.display = lesson ? 'block' : 'none';
  el('matchlesson').innerHTML = 'White learned: ' + escapeHtml(lesson);
  el('forgetlesson').style.display = lesson ? 'inline' : 'none';
  el('start').disabled = reviewBusy; el('start').innerHTML = 'Restart game';
  el('retry').disabled = state.busy || state.ended || state.turn !== 'w';
  el('result').innerHTML = state.ended ? escapeHtml(text(root.getElementsByTagName('status')[0])) + (reviewBusy ? ' Reviewing match.' : ' Restarting in 8 seconds.') : '';
  if (state.ended && !reviewBusy) poll = window.setTimeout(startGame, 8000);
  else poll = window.setTimeout(refresh, 1000);
}
function drawBoard() {
  var r, f, sq, code, legal, i, cls;
  for (r = 1; r <= 8; r++) for (f = 0; f < 8; f++) {
    sq = 'abcdefgh'.charAt(f) + r; code = squares[sq]; legal = false;
    if (state) for (i = 0; i < state.legal.length; i++) if (state.legal[i].getAttribute('from') === selected && state.legal[i].getAttribute('to') === sq) legal = true;
    cls = (f + r) % 2 ? 'light' : 'dark';
    if (state && (sq === state.lastFrom || sq === state.lastTo)) cls = 'last';
    if (sq === selected) cls = 'selected'; else if (legal) cls = 'legal';
    el('cell_' + sq).className = cls;
    el('sq_' + sq).innerHTML = (code ? '<img src="/pieces/' + code + '.gif" alt="' + code + '">' : legal ? '<span class="dot">&middot;</span>' : '') + '<span class="coord">' + sq + '</span>';
  }
}
function clickSquare(sq) {
  if (!state || state.busy || state.ended || state.turn !== 'b' || sending || pendingPromotion) return;
  var i, move = null, hasPromotion = false;
  for (i = 0; i < state.legal.length; i++) if (state.legal[i].getAttribute('from') === selected && state.legal[i].getAttribute('to') === sq) { move = state.legal[i]; if (move.getAttribute('promotion')) hasPromotion = true; }
  if (move) {
    if (hasPromotion) {
      pendingPromotion = { from: selected, to: sq };
      el('promotion').style.display = 'block';
      el('status').innerHTML = 'Choose Queen, Rook, Bishop or Knight below the board.';
      return;
    }
    sendMove(selected, sq, '');
  } else { selected = squares[sq] && squares[sq].charAt(0) === 'b' && selected !== sq ? sq : ''; drawBoard(); }
}
function legalMove(from, to, promotion) {
  var i, m;
  if (!state) return false;
  for (i = 0; i < state.legal.length; i++) {
    m = state.legal[i];
    if (m.getAttribute('from') === from && m.getAttribute('to') === to && (m.getAttribute('promotion') || '') === promotion) return true;
  }
  return false;
}
function closePromotion() { pendingPromotion = null; el('promotion').style.display = 'none'; }
function cancelPromotion() { closePromotion(); selected = ''; drawBoard(); el('status').innerHTML = 'Your move. You play Black.'; }
function choosePromotion(piece) {
  if (!pendingPromotion || sending || !state || state.busy || state.ended || state.turn !== 'b') return;
  if (!legalMove(pendingPromotion.from, pendingPromotion.to, piece)) return;
  var from = pendingPromotion.from, to = pendingPromotion.to;
  closePromotion(); sendMove(from, to, piece);
}
function sendMove(from, to, promotion) {
  selected = ''; sending = true; window.clearTimeout(poll);
  request('/api/move', 'from=' + from + '&to=' + to + '&promotion=' + promotion);
}
function togglePrompt() {
  el('exchange').style.display = el('exchange').style.display === 'none' ? 'block' : 'none';
  if (el('exchange').style.display === 'block' && state) loadRecap();
}
function selectRecap(match) {
  if (match === 'previous' && !recapPrevious) return;
  recapMatch = match; recapLoaded = '';
  el('downloadrecap').href = '/api/recap?match=' + match + '&download=1';
  loadRecap();
}
function recapText(value) {
  preText(el('recap'), value);
}
function loadRecap() {
  if (!state) { recapText('Start a match to see its recap.'); return; }
  if (!recapSupported) {
    recapText('This older server does not have the recap endpoint. Reopening cannot fix it. Open the updated ChessGPT server (on this laptop: http://localhost:3081/).');
    return;
  }
  var x, key = recapKey + ':' + recapMatch;
  try { x = xhr(); } catch (e) { recapText('Enable XMLHTTP ActiveX to read the recap.'); return; }
  recapLoaded = key;
  x.open('GET', '/api/recap?match=' + recapMatch + '&t=' + new Date().getTime(), true);
  x.onreadystatechange = function () {
    if (x.readyState !== 4 || key !== recapKey + ':' + recapMatch) return;
    if (x.status === 200) recapText(x.responseText);
    else { recapLoaded = ''; recapText('Could not load recap. Close and reopen the panel to retry.'); }
  };
  x.send(null);
}
function allowRecapDownload() {
  if (state && recapSupported) return true;
  el('exchange').style.display = 'block'; loadRecap(); return false;
}
