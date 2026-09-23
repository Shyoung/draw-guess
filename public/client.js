/* =====================================================================
   서버가 터져서 도망친 곳에 낙원은 있나? — client.js
   Pure JS. Follows PROTOCOL.md v1 exactly (event names / payload fields).
   ===================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Constants & helpers
  // ------------------------------------------------------------------
  var W = 800, H = 600;
  var EMOJIS = ['😀', '😎', '🤩', '🥳', '😺', '🐶', '🐰', '🦊', '🐼', '🐨', '🐯', '🦁', '🐸', '🐙', '🦄', '🐧'];
  var AV_COLORS = ['#ffb3ba', '#ffdfba', '#fff5ba', '#baffc9', '#bae1ff', '#d7baff', '#f9c6e0', '#c9f2f2'];
  var PALETTE = [
    '#000000', '#4a4a4a', '#9b9b9b', '#d6d6d6', '#ffffff',
    '#e53935', '#8e1b1b', '#fb8c00', '#8d5524', '#fdd835',
    '#7cb342', '#2e7d32', '#00acc1', '#4fc3f7', '#1e88e5',
    '#283593', '#8e24aa', '#f06292', '#f8c9a0', '#ffb74d'
  ];
  var SIZES = [4, 10, 20, 36];
  var SFX = window.SFX || { play: function () {}, isMuted: function () { return true; }, setMuted: function () {}, toggle: function () { return true; } };
  var DEFAULT_SETTINGS = { rounds: 3, drawTime: 80, wordCount: 3, hints: 2, hintEndAt: 15, customWords: '', customWordsOnly: false, mode: 'classic', fixedDrawerId: null };
  var REASON_TEXT = { time: '시간 종료!', allGuessed: '모두 맞혔어요!', drawerLeft: '출제자가 나갔어요', notEnoughPlayers: '플레이어가 부족해요' };
  var STORAGE_KEY = 'drawguess.profile';
  var TOKEN_KEY = 'drawguess.token';      // 재접속용 토큰(브라우저별 1개)
  var LAST_ROOM_KEY = 'drawguess.lastRoom'; // 마지막으로 있던 방 { code, ts }
  var REJOIN_WINDOW_MS = 90 * 1000;        // 새로고침 후 이 시간 안이면 자동 재접속 시도

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function isHex(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c); }
  function num(v, fallback) { var n = Number(v); return isFinite(n) ? n : fallback; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function debounce(fn, ms) {
    var t = null;
    return function () { var a = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, a); }, ms); };
  }
  function safeAvatar(a) {
    var emoji = a && typeof a.emoji === 'string' && a.emoji ? a.emoji : '🙂';
    var color = a && isHex(a.color) ? a.color : '#d6d6d6';
    return { emoji: emoji, color: color };
  }
  function avatarNode(a, extraCls) {
    var av = safeAvatar(a);
    var n = el('span', 'avatar' + (extraCls ? ' ' + extraCls : ''), av.emoji);
    n.style.setProperty('--av', av.color);
    return n;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var state = {
    roomCode: null, hostId: null, phase: 'lobby', round: 0, totalRounds: 0,
    drawerId: null, settings: Object.assign({}, DEFAULT_SETTINGS), players: [],
    lobbyStep: 'mode', fixedDrawerId: null
  };
  var MODE_NAMES = { classic: '돌아가며 그리기', fixed: '한 명이 그리기' };
  /** fixed 모드에서 실제 출제자(지정된 사람이 없으면 호스트). classic 이면 null */
  function fixedDrawerId() {
    if (state.settings.mode !== 'fixed') return null;
    return state.fixedDrawerId || (state.settings.fixedDrawerId && findPlayer(state.settings.fixedDrawerId) ? state.settings.fixedDrawerId : state.hostId);
  }
  var myId = null;
  var inRoom = false;
  var socket = null;
  var rejoinTarget = null; // 연결이 끊긴 뒤 다시 붙을 방 코드 (null이면 재접속 안 함)

  function randomToken() {
    var s = '';
    try {
      var buf = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) s += ('0' + buf[i].toString(16)).slice(-2);
    } catch (e) { s = String(Date.now().toString(16)) + Math.random().toString(16).slice(2, 18); }
    return s;
  }
  function getToken() {
    var t = null;
    try { t = localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
    if (!t || !/^[A-Za-z0-9_-]{8,64}$/.test(t)) { t = randomToken(); try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ } }
    return t;
  }
  function setToken(t) { if (typeof t === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(t)) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* ignore */ } } }
  function saveLastRoom(code) { try { localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code: code, ts: Date.now() })); } catch (e) { /* ignore */ } }
  function clearLastRoom() { try { localStorage.removeItem(LAST_ROOM_KEY); } catch (e) { /* ignore */ } }
  function loadLastRoom() {
    try {
      var v = JSON.parse(localStorage.getItem(LAST_ROOM_KEY) || 'null');
      if (v && typeof v.code === 'string' && Date.now() - num(v.ts, 0) < REJOIN_WINDOW_MS) return v.code.toUpperCase();
    } catch (e) { /* ignore */ }
    return null;
  }

  // 최근 게임 이벤트에서 파생된 UI 데이터
  var ui = {
    wordMask: '', wordLength: 0, word: null, wordOptions: null, chosenWord: null, category: null,
    drawerName: '', timeLeft: null, turnEnd: null, ranking: null, optionsKey: '',
    gallery: null,      // 가장 최근 게임의 갤러리 [{ round, word, category, drawerName, guessed, ops }]
    galleryOpen: false,
    galleryThumbs: []   // 렌더링한 썸네일 dataURL 캐시 (gallery와 같은 인덱스)
  };

  var profile = { name: '', emoji: EMOJIS[0], color: AV_COLORS[4] };

  function isHost() { return !!myId && state.hostId === myId; }
  function isDrawer() { return !!myId && state.drawerId === myId; }
  function canDraw() { return state.phase === 'drawing' && isDrawer(); }
  function findPlayer(id) {
    for (var i = 0; i < state.players.length; i++) if (state.players[i].id === id) return state.players[i];
    return null;
  }
  function playerName(id, fallback) { var p = findPlayer(id); return p ? p.name : (fallback || '알 수 없음'); }

  // ------------------------------------------------------------------
  // Toasts
  // ------------------------------------------------------------------
  function toast(msg, kind) {
    var wrap = $('toasts'); if (!wrap) return;
    var t = el('div', 'toast' + (kind ? ' toast-' + kind : ''), String(msg));
    wrap.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 3000);
    while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
  }

  function renderSoundButton(btn) {
    var muted = SFX.isMuted();
    btn.textContent = muted ? '🔇' : '🔊';
    btn.title = muted ? '효과음 켜기' : '효과음 끄기';
    btn.setAttribute('aria-pressed', String(muted));
  }

  // ------------------------------------------------------------------
  // Drawing engine
  // ------------------------------------------------------------------
  var canvas = $('canvas');
  var ctx = null;
  try { ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null; } catch (e) { ctx = null; }
  var ops = [];
  var remoteOp = null;   // 네트워크로 수신 중인 stroke
  var localOp = null;    // 내가 그리는 중인 stroke

  function clearCanvas() {
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  function normPt(p) {
    if (!Array.isArray(p) || p.length < 2) return null;
    var x = Number(p[0]), y = Number(p[1]);
    if (!isFinite(x) || !isFinite(y)) return null;
    return [clamp(Math.round(x), 0, W), clamp(Math.round(y), 0, H)];
  }
  function sanitizeOp(op) {
    if (!op || typeof op !== 'object') return null;
    if (op.type === 'stroke') {
      var pts = Array.isArray(op.points) ? op.points.map(normPt).filter(Boolean) : [];
      return { type: 'stroke', tool: op.tool === 'eraser' ? 'eraser' : 'pen', color: isHex(op.color) ? op.color : '#000000', size: clamp(num(op.size, 4), 1, 60), points: pts };
    }
    if (op.type === 'fill') {
      var p = normPt([op.x, op.y]); if (!p) return null;
      return { type: 'fill', x: p[0], y: p[1], color: isHex(op.color) ? op.color : '#000000' };
    }
    return null;
  }
  function strokeColor(op) { return op.tool === 'eraser' ? '#ffffff' : (isHex(op.color) ? op.color : '#000000'); }

  // fromIdx: 새로 추가된 첫 점의 인덱스. 0이면 전체 그리기.
  function drawStroke(op, fromIdx) {
    if (!ctx || !op || !op.points || !op.points.length) return;
    var pts = op.points, size = clamp(num(op.size, 4), 1, 60), color = strokeColor(op);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = size;
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], size / 2, 0, Math.PI * 2); ctx.fill();
      return;
    }
    var start = Math.max(0, (fromIdx || 0) - 1);
    ctx.beginPath();
    ctx.moveTo(pts[start][0], pts[start][1]);
    for (var i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  // Scanline flood fill on ImageData, RGB tolerance to survive anti-aliased edges.
  function floodFill(x, y, hex, tolerance) {
    if (!ctx) return false;
    x = clamp(Math.round(num(x, 0)), 0, W - 1); y = clamp(Math.round(num(y, 0)), 0, H - 1);
    if (!isHex(hex)) hex = '#000000';
    var tol = tolerance == null ? 32 : tolerance;
    var fr = parseInt(hex.slice(1, 3), 16), fg = parseInt(hex.slice(3, 5), 16), fb = parseInt(hex.slice(5, 7), 16);
    var img;
    try { img = ctx.getImageData(0, 0, W, H); } catch (e) { return false; }
    var d = img.data;
    var i0 = (y * W + x) * 4;
    var tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
    // 같은 색이면 no-op
    if (Math.abs(tr - fr) <= tol && Math.abs(tg - fg) <= tol && Math.abs(tb - fb) <= tol) return false;

    var visited = new Uint8Array(W * H);
    function match(pi) {
      var i = pi * 4;
      return Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol && Math.abs(d[i + 2] - tb) <= tol;
    }
    var stack = [x, y];
    while (stack.length) {
      var sy = stack.pop(), sx = stack.pop();
      var pi = sy * W + sx;
      if (visited[pi] || !match(pi)) continue;
      var lx = sx, rx = sx;
      while (lx > 0 && !visited[pi - (sx - lx) - 1] && match(pi - (sx - lx) - 1)) lx--;
      while (rx < W - 1 && !visited[pi + (rx - sx) + 1] && match(pi + (rx - sx) + 1)) rx++;
      var rowBase = sy * W;
      for (var px = lx; px <= rx; px++) {
        var q = rowBase + px; visited[q] = 1;
        var qi = q * 4; d[qi] = fr; d[qi + 1] = fg; d[qi + 2] = fb; d[qi + 3] = 255;
      }
      for (var dy = -1; dy <= 1; dy += 2) {
        var ny = sy + dy; if (ny < 0 || ny >= H) continue;
        var nb = ny * W, inSpan = false;
        for (var qx = lx; qx <= rx; qx++) {
          var m = !visited[nb + qx] && match(nb + qx);
          if (m && !inSpan) { stack.push(qx, ny); inSpan = true; }
          else if (!m) inSpan = false;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return true;
  }

  function renderOp(op) {
    if (!op) return;
    if (op.type === 'stroke') drawStroke(op, 0);
    else if (op.type === 'fill') floodFill(op.x, op.y, op.color);
  }
  function redrawAll() {
    if (!ctx) return;
    clearCanvas();
    for (var i = 0; i < ops.length; i++) renderOp(ops[i]);
  }
  function resetCanvasState() {
    ops = []; remoteOp = null; localOp = null;
    cancelLocalStroke(false);
    clearCanvas();
  }

  // --- 원격 드로잉 수신 ---
  // choosing/turnEnd/gameOver 중에 도착한 드로잉 이벤트는 무시 (지연 도착한 유령 스트로크 방지).
  // lobby(방금 참가해 아직 room:state 미수신)와 drawing에서는 허용.
  function drawEventsBlocked() { return state.phase === 'choosing' || state.phase === 'turnEnd' || state.phase === 'gameOver'; }
  function onDrawStart(p) {
    if (drawEventsBlocked()) return;
    if (!p || typeof p !== 'object') return;
    var pt = normPt([p.x, p.y]); if (!pt) return;
    remoteOp = { type: 'stroke', tool: p.tool === 'eraser' ? 'eraser' : 'pen', color: isHex(p.color) ? p.color : '#000000', size: clamp(num(p.size, 4), 1, 60), points: [pt] };
    ops.push(remoteOp);
    drawStroke(remoteOp, 0);
  }
  function onDrawMove(p) {
    if (drawEventsBlocked()) return;
    var pts = p && Array.isArray(p.pts) ? p.pts : [];
    if (!remoteOp || !pts.length) return;
    var from = remoteOp.points.length;
    for (var i = 0; i < pts.length; i++) { var n = normPt(pts[i]); if (n) remoteOp.points.push(n); }
    if (remoteOp.points.length > from) drawStroke(remoteOp, from);
  }
  function onDrawEnd() { remoteOp = null; }
  function onDrawFill(p) {
    if (drawEventsBlocked()) return;
    if (!p || typeof p !== 'object') return;
    var pt = normPt([p.x, p.y]); if (!pt) return;
    var op = { type: 'fill', x: pt[0], y: pt[1], color: isHex(p.color) ? p.color : '#000000' };
    ops.push(op);
    floodFill(op.x, op.y, op.color);
  }
  function onDrawUndo() { if (drawEventsBlocked()) return; remoteOp = null; ops.pop(); redrawAll(); }
  function onDrawClear() { if (drawEventsBlocked()) return; remoteOp = null; ops = []; clearCanvas(); }
  function onDrawSync(p) {
    remoteOp = null; localOp = null;
    var list = p && Array.isArray(p.ops) ? p.ops : [];
    ops = list.map(sanitizeOp).filter(Boolean);
    redrawAll();
    // 중간 참가 시 진행 중인 stroke가 마지막 op일 수 있으므로 이어받을 수 있게 둔다.
    var last = ops[ops.length - 1];
    if (last && last.type === 'stroke' && state.phase === 'drawing') remoteOp = last;
  }

  // --- 로컬 드로잉 (출제자) ---
  var tool = 'pen', color = '#000000', size = SIZES[1];
  var drawing = false, activePointer = null, pending = [], flushTimer = null;

  function toLogical(e) {
    var r = canvas.getBoundingClientRect();
    var x = r.width ? (e.clientX - r.left) * W / r.width : 0;
    var y = r.height ? (e.clientY - r.top) * H / r.height : 0;
    return [clamp(Math.round(x), 0, W), clamp(Math.round(y), 0, H)];
  }
  function flush() {
    if (pending.length) { var pts = pending; pending = []; emit('draw:move', { pts: pts }); }
  }
  function cancelLocalStroke(sendEnd) {
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (drawing) { flush(); if (sendEnd) emit('draw:end'); }
    drawing = false; activePointer = null; localOp = null; pending = [];
  }
  function onPointerDown(e) {
    if (!ctx || !canDraw()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (drawing) return;
    e.preventDefault();
    var pt = toLogical(e), x = pt[0], y = pt[1];
    if (tool === 'fill') {
      var op = { type: 'fill', x: x, y: y, color: color };
      ops.push(op); floodFill(x, y, color);
      emit('draw:fill', { x: x, y: y, color: color });
      return;
    }
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    drawing = true; activePointer = e.pointerId;
    var t = tool === 'eraser' ? 'eraser' : 'pen';
    var c = t === 'eraser' ? '#ffffff' : color;
    localOp = { type: 'stroke', tool: t, color: c, size: size, points: [[x, y]] };
    ops.push(localOp);
    drawStroke(localOp, 0);
    emit('draw:start', { tool: t, color: c, size: size, x: x, y: y });
    pending = [];
    flushTimer = setInterval(flush, 20);
  }
  function onPointerMove(e) {
    if (!drawing || !localOp || e.pointerId !== activePointer) return;
    e.preventDefault();
    var events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
    if (!events || !events.length) events = [e];
    var from = localOp.points.length;
    for (var i = 0; i < events.length; i++) {
      var pt = toLogical(events[i]);
      var last = localOp.points[localOp.points.length - 1];
      if (last && last[0] === pt[0] && last[1] === pt[1]) continue;
      localOp.points.push(pt); pending.push(pt);
    }
    if (localOp.points.length > from) drawStroke(localOp, from);
  }
  function onPointerUp(e) {
    if (!drawing || (e && e.pointerId != null && activePointer != null && e.pointerId !== activePointer)) return;
    cancelLocalStroke(true);
  }
  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('lostpointercapture', onPointerUp);
    canvas.addEventListener('contextmenu', function (e) { if (canDraw()) e.preventDefault(); });
  }

  function doUndo() {
    if (!canDraw() || drawing) return;
    if (!ops.length) return;
    ops.pop(); redrawAll(); emit('draw:undo');
  }
  function doClear() {
    if (!canDraw()) return;
    cancelLocalStroke(true);
    ops = []; clearCanvas(); emit('draw:clear');
  }

  // --- 툴바 ---
  function setTool(t) { tool = t; renderToolbarState(); }
  function setColor(c) { if (isHex(c)) { color = c; if (tool === 'eraser') tool = 'pen'; renderToolbarState(); } }
  var customColorEl = null;
  function setSize(s) { size = clamp(num(s, 10), 1, 60); renderToolbarState(); }
  function renderToolbarState() {
    var tb = $('toolbar'); if (!tb) return;
    tb.querySelectorAll('.tool[data-tool]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-tool') === tool); });
    tb.querySelectorAll('.swatch[data-color]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-color') === color); });
    if (customColorEl) {
      var isCustom = PALETTE.indexOf(color) === -1 && isHex(color);
      customColorEl.classList.toggle('active', isCustom);
      if (isCustom) { customColorEl.classList.add('chosen'); customColorEl.style.setProperty('--custom-color', color); }
    }
    tb.querySelectorAll('.size-btn').forEach(function (b) { b.classList.toggle('active', Number(b.getAttribute('data-size')) === size); });
    var cur = $('current-color'); if (cur) cur.style.background = tool === 'eraser' ? '#ffffff' : color;
  }
  function buildToolbar() {
    var tb = $('toolbar'); if (!tb) return;
    tb.querySelectorAll('.tool[data-tool]').forEach(function (b) {
      b.addEventListener('click', function () { setTool(b.getAttribute('data-tool')); });
    });
    var pal = $('palette');
    if (pal) PALETTE.forEach(function (c) {
      var b = el('button', 'swatch'); b.type = 'button'; b.title = c; b.setAttribute('data-color', c); b.style.background = c;
      b.addEventListener('click', function () { setColor(c); });
      pal.insertBefore(b, $('swatch-custom'));
    });
    customColorEl = $('swatch-custom');
    var customInput = $('custom-color-input');
    if (customInput) {
      customInput.addEventListener('input', function () { setColor(customInput.value); });
      customInput.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    var sz = $('sizes');
    if (sz) SIZES.forEach(function (s) {
      var b = el('button', 'size-btn'); b.type = 'button'; b.title = s + 'px'; b.setAttribute('data-size', String(s));
      var dot = el('i'); var d = clamp(Math.round(s * 0.6) + 4, 6, 26); dot.style.width = d + 'px'; dot.style.height = d + 'px';
      b.appendChild(dot);
      b.addEventListener('click', function () { setSize(s); });
      sz.appendChild(b);
    });
    var undo = $('btn-undo'); if (undo) undo.addEventListener('click', doUndo);
    var clr = $('btn-clear'); if (clr) clr.addEventListener('click', doClear);
    renderToolbarState();
  }
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!canDraw()) return;
    var k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); doUndo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'b') setTool('pen');
    else if (k === 'e') setTool('eraser');
    else if (k === 'f') setTool('fill');
  });

  // ------------------------------------------------------------------
  // Socket
  // ------------------------------------------------------------------
  function emit(ev, payload, ack) {
    if (!socket) return;
    try {
      if (typeof ack === 'function') socket.emit(ev, payload, ack);
      else if (payload === undefined) socket.emit(ev);
      else socket.emit(ev, payload);
    } catch (e) { console.error('[emit]', ev, e); }
  }
  function on(ev, fn) {
    socket.on(ev, function (p) { try { fn(p); } catch (e) { console.error('[client]', ev, e); } });
  }
  var connectErrorToasted = false;

  function connect() {
    if (typeof io !== 'function') { toast('서버에 연결할 수 없어요 (socket.io 로드 실패)', 'error'); return; }
    try { socket = io(); } catch (e) { toast('서버 연결에 실패했어요', 'error'); return; }

    on('connect', function () {
      connectErrorToasted = false;
      var target = rejoinTarget || (!inRoom ? loadLastRoom() : null);
      if (target) { tryRejoin(target); return; }
      if (!inRoom) myId = socket.id || myId;
    });
    on('connect_error', function () { if (!connectErrorToasted) { connectErrorToasted = true; toast('서버에 연결하는 중이에요…'); } });
    on('disconnect', function () {
      // 방 안에서 끊기면 화면을 유지한 채 재접속을 기다린다 (서버가 유예 시간 동안 자리를 비워둔다)
      if (inRoom && state.roomCode) { rejoinTarget = state.roomCode; toast('연결이 끊어졌어요. 다시 연결 중…', 'error'); }
    });
    on('react:show', onReactShow);
    // 같은 브라우저(토큰)의 다른 탭/새로고침이 이 자리를 넘겨받았다 → 이 화면은 조용히 물러난다(재접속 시도 금지)
    on('session:replaced', function (p) {
      rejoinTarget = null;
      clearLastRoom();
      toast(p && p.message ? p.message : '다른 곳에서 접속해 이 화면은 종료됐어요');
      resetToLanding(false);
    });

    // 배포 후 재접속 시 서버 버전이 이 페이지의 버전과 다르면 새 코드를 받기 위해 새로고침한다.
    on('server:version', function (p) {
      var meta = document.querySelector('meta[name="asset-version"]');
      var pageVersion = meta ? meta.getAttribute('content') : null;
      if (!pageVersion || !p || typeof p.version !== 'string' || p.version === pageVersion) return;
      toast('새 버전이 배포되어 새로고침합니다');
      if (inRoom && state.roomCode) saveLastRoom(state.roomCode); // 새로고침 뒤 같은 방으로 자동 복귀
      setTimeout(function () { location.reload(); }, 1200);
    });
    on('room:state', onRoomState);
    on('game:choosing', onChoosing);
    on('game:drawing', onDrawing);
    on('game:hint', onHint);
    on('game:timer', function (p) { if (p && p.timeLeft != null) setTimeLeft(num(p.timeLeft, 0), true); });
    on('game:turnEnd', onTurnEnd);
    on('game:over', onGameOver);
    on('chat:message', onChatMessage);
    on('player:guessed', function (p) {
      var pl = p && findPlayer(p.id); if (pl) { pl.hasGuessed = true; renderPlayers(); renderChatInput(); }
    });
    on('error:msg', function (p) { toast(p && p.message ? p.message : '오류가 발생했어요', 'error'); SFX.play('error'); });

    on('draw:start', onDrawStart);
    on('draw:move', onDrawMove);
    on('draw:end', onDrawEnd);
    on('draw:fill', onDrawFill);
    on('draw:clear', onDrawClear);
    on('draw:undo', onDrawUndo);
    on('draw:sync', onDrawSync);
  }

  // ------------------------------------------------------------------
  // Game event handlers
  // ------------------------------------------------------------------
  function onRoomState(s) {
    if (!s || typeof s !== 'object') return;
    if (inRoom && state.roomCode) saveLastRoom(state.roomCode);
    var prevPhase = state.phase;
    if (s.roomCode != null) state.roomCode = String(s.roomCode);
    state.hostId = s.hostId != null ? s.hostId : state.hostId;
    if (typeof s.phase === 'string') state.phase = s.phase;
    state.round = num(s.round, state.round); state.totalRounds = num(s.totalRounds, state.totalRounds);
    state.drawerId = s.drawerId == null ? null : s.drawerId;
    if (s.settings && typeof s.settings === 'object') state.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings);
    if (Array.isArray(s.players)) {
      state.players = s.players.filter(function (p) { return p && typeof p === 'object' && p.id != null; }).map(function (p) {
        return { id: p.id, name: String(p.name || '?'), avatar: safeAvatar(p.avatar), score: num(p.score, 0), isDrawing: !!p.isDrawing, hasGuessed: !!p.hasGuessed, connected: p.connected !== false };
      });
    }
    if (inRoom && myId && state.players.length && !findPlayer(myId)) {
      // 강퇴 등으로 방에서 빠진 경우
      toast('방에서 나가게 되었어요', 'error'); resetToLanding(false); return;
    }
    state.nextDrawerId = s.nextDrawerId == null ? null : s.nextDrawerId;
    if (s.lobbyStep === 'mode' || s.lobbyStep === 'settings') state.lobbyStep = s.lobbyStep;
    state.fixedDrawerId = s.fixedDrawerId == null ? null : s.fixedDrawerId;
    if (state.phase === 'lobby' && prevPhase !== 'lobby') {
      resetCanvasState(); ui.wordMask = ''; ui.word = null; ui.wordOptions = null; ui.chosenWord = null;
      ui.turnEnd = null; ui.ranking = null; setTimeLeft(null);
    }
    if (state.phase !== 'choosing') { ui.wordOptions = null; ui.chosenWord = null; }
    if (state.phase !== 'drawing' && drawing) cancelLocalStroke(false);
    renderAll();
  }

  function onChoosing(p) {
    if (!p || typeof p !== 'object') return;
    state.phase = 'choosing';
    if (p.drawerId != null) state.drawerId = p.drawerId;
    ui.drawerName = p.drawerName ? String(p.drawerName) : playerName(state.drawerId, '출제자');
    ui.wordOptions = Array.isArray(p.wordOptions) ? p.wordOptions.map(String) : null;
    if (ui.wordOptions && ui.wordOptions.length) SFX.play('myTurn');
    ui.chosenWord = null;
    ui.word = null; ui.wordMask = ''; ui.category = null; ui.turnEnd = null; ui.ranking = null;
    resetCanvasState();
    setTimeLeft(p.timeLeft != null ? num(p.timeLeft, 15) : 15, true);
    renderAll();
  }

  function onDrawing(p) {
    if (!p || typeof p !== 'object') return;
    state.phase = 'drawing';
    if (p.drawerId != null) state.drawerId = p.drawerId;
    if (p.round != null) state.round = num(p.round, state.round);
    if (p.totalRounds != null) state.totalRounds = num(p.totalRounds, state.totalRounds);
    ui.wordMask = typeof p.wordMask === 'string' ? p.wordMask : '';
    ui.category = typeof p.category === 'string' ? p.category : null;
    ui.wordLength = num(p.wordLength, 0);
    ui.word = typeof p.word === 'string' ? p.word : null;
    ui.wordOptions = null; ui.chosenWord = null; ui.turnEnd = null;
    ui.drawerName = playerName(state.drawerId, ui.drawerName);
    setTimeLeft(p.timeLeft != null ? num(p.timeLeft, 0) : num(state.settings.drawTime, 80), true);
    state.players.forEach(function (pl) { pl.hasGuessed = false; pl.isDrawing = pl.id === state.drawerId; });
    renderAll();
    if (isDrawer()) { setTool(tool === 'eraser' ? 'pen' : tool); }
    else { var ci = $('chat-input'); if (ci && document.activeElement !== ci && window.innerWidth >= 1100) ci.focus(); }
  }

  function onHint(p) {
    if (!p || typeof p.wordMask !== 'string') return;
    ui.wordMask = p.wordMask;
    if (typeof p.category === 'string') ui.category = p.category;
    renderWordArea();
  }

  function onTurnEnd(p) {
    if (!p || typeof p !== 'object') return;
    state.phase = 'turnEnd';
    cancelLocalStroke(false);
    ui.turnEnd = {
      word: p.word != null ? String(p.word) : '—',
      reason: typeof p.reason === 'string' ? p.reason : 'time',
      deltas: Array.isArray(p.deltas) ? p.deltas.filter(function (d) { return d && d.id != null; }) : []
    };
    // 델타를 players 점수에 미리 반영하진 않는다 (room:state가 곧 갱신함)
    SFX.play('turnEnd');
    setTimeLeft(p.timeLeft != null ? num(p.timeLeft, 5) : 5, false);
    renderAll();
  }

  function onGameOver(p) {
    state.phase = 'gameOver';
    SFX.play('gameOver');
    cancelLocalStroke(false);
    var ranking = p && Array.isArray(p.ranking) ? p.ranking : [];
    ui.ranking = ranking.filter(function (r) { return r && typeof r === 'object'; }).map(function (r) {
      return { id: r.id, name: String(r.name || playerName(r.id, '?')), avatar: safeAvatar(r.avatar), score: num(r.score, 0) };
    }).sort(function (a, b) { return b.score - a.score; });
    ui.turnEnd = null;
    ui.gameOverDrawer = p && p.drawer && typeof p.drawer === 'object' ? { name: String(p.drawer.name || '?'), avatar: safeAvatar(p.drawer.avatar) } : null;
    if (Array.isArray(p && p.gallery)) {
      ui.gallery = p.gallery.filter(function (g) { return g && typeof g === 'object' && typeof g.word === 'string'; }).map(function (g) {
        return {
          round: num(g.round, 0), word: String(g.word), category: g.category ? String(g.category) : '',
          drawerId: g.drawerId, drawerName: String(g.drawerName || playerName(g.drawerId, '?')), guessed: num(g.guessed, 0),
          ops: Array.isArray(g.ops) ? g.ops.map(sanitizeOp).filter(Boolean) : [], trimmed: !!g.trimmed
        };
      });
      ui.galleryThumbs = [];
    }
    setTimeLeft(10, false);
    renderAll();
  }

  // ------------------------------------------------------------------
  // 그림 갤러리 (게임 종료 후) — ops 를 오프스크린 캔버스에 재생해 PNG 로 만든다
  // ------------------------------------------------------------------
  /** 기존 그리기 함수들(drawStroke/floodFill/clearCanvas)은 전역 ctx 를 쓰므로, 잠시 바꿔 끼워 재사용한다 */
  function withCtx(tmpCtx, fn) {
    var saved = ctx; ctx = tmpCtx;
    try { fn(); } finally { ctx = saved; }
  }
  function renderOpsToCanvas(opsList) {
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var c2 = cv.getContext('2d', { willReadFrequently: true });
    withCtx(c2, function () {
      clearCanvas();
      for (var i = 0; i < opsList.length; i++) renderOp(opsList[i]);
    });
    return cv;
  }
  function galleryThumb(i) {
    if (!ui.gallery || !ui.gallery[i]) return '';
    if (!ui.galleryThumbs[i]) {
      try { ui.galleryThumbs[i] = renderOpsToCanvas(ui.gallery[i].ops).toDataURL('image/png'); } catch (e) { ui.galleryThumbs[i] = ''; }
    }
    return ui.galleryThumbs[i];
  }
  function galleryCaption(g) {
    return (g.round ? g.round + '라운드 · ' : '') + '정답 ' + g.word + ' · ✏️ ' + g.drawerName + ' · ' + g.guessed + '명 맞힘';
  }
  function safeFile(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
  function downloadDataUrl(dataUrl, filename) {
    var a = document.createElement('a'); a.href = dataUrl; a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 0);
  }
  /** 그림 + 아래 캡션 띠를 합친 PNG */
  function galleryItemPng(i) {
    var g = ui.gallery[i];
    var src = renderOpsToCanvas(g.ops);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H + 72;
    var c2 = cv.getContext('2d');
    c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, cv.width, cv.height);
    c2.drawImage(src, 0, 0);
    c2.fillStyle = '#f3ecff'; c2.fillRect(0, H, W, 72);
    c2.fillStyle = '#2b2d42'; c2.font = 'bold 26px "Pretendard", "Malgun Gothic", sans-serif'; c2.textBaseline = 'middle';
    c2.fillText(g.word + (g.category ? '  (' + g.category + ')' : ''), 20, H + 26);
    c2.fillStyle = '#6c6f85'; c2.font = '16px "Pretendard", "Malgun Gothic", sans-serif';
    c2.fillText('✏️ ' + g.drawerName + ' · ' + g.guessed + '명 맞힘 · ' + (g.round ? g.round + '라운드 · ' : '') + '서버가 터져서 도망친 곳에 낙원은 있나?', 20, H + 54);
    return cv.toDataURL('image/png');
  }
  /** 전체를 한 장에 모은 시트 PNG (3열) */
  function gallerySheetPng() {
    var items = ui.gallery || [];
    var cols = Math.min(3, Math.max(1, items.length)), cellW = 400, cellH = 300, cap = 44, pad = 16, head = 64;
    var rows = Math.ceil(items.length / cols);
    var cv = document.createElement('canvas');
    cv.width = pad + cols * (cellW + pad); cv.height = head + rows * (cellH + cap + pad) + pad;
    var c2 = cv.getContext('2d');
    c2.fillStyle = '#fdf6ec'; c2.fillRect(0, 0, cv.width, cv.height);
    c2.fillStyle = '#2b2d42'; c2.font = 'bold 26px "Pretendard", "Malgun Gothic", sans-serif'; c2.textBaseline = 'middle';
    c2.fillText('🖼 그림 갤러리 · 방 ' + (state.roomCode || '') + ' · ' + items.length + '장', pad, head / 2);
    items.forEach(function (g, i) {
      var col = i % cols, row = Math.floor(i / cols);
      var x = pad + col * (cellW + pad), y = head + row * (cellH + cap + pad);
      c2.fillStyle = '#ffffff'; c2.fillRect(x, y, cellW, cellH + cap);
      c2.drawImage(renderOpsToCanvas(g.ops), x, y, cellW, cellH);
      c2.fillStyle = '#f3ecff'; c2.fillRect(x, y + cellH, cellW, cap);
      c2.fillStyle = '#2b2d42'; c2.font = 'bold 17px "Pretendard", "Malgun Gothic", sans-serif';
      c2.fillText(g.word, x + 12, y + cellH + cap / 2);
      c2.fillStyle = '#6c6f85'; c2.font = '13px "Pretendard", "Malgun Gothic", sans-serif'; c2.textAlign = 'right';
      c2.fillText('✏️ ' + g.drawerName + ' · ' + g.guessed + '명 맞힘', x + cellW - 12, y + cellH + cap / 2);
      c2.textAlign = 'left';
    });
    return cv.toDataURL('image/png');
  }
  function openGallery() { if (!ui.gallery || !ui.gallery.length) { toast('아직 갤러리에 담을 그림이 없어요'); return; } ui.galleryOpen = true; renderGallery(); }
  function closeGallery() { ui.galleryOpen = false; renderGallery(); }
  function renderGallery() {
    var m = $('overlay-gallery'); if (!m) return;
    var items = ui.gallery || [];
    m.hidden = !ui.galleryOpen || !items.length;
    var bo = $('btn-gallery-open'); if (bo) bo.hidden = !items.length;
    var bl = $('btn-gallery-lobby'); if (bl) bl.hidden = !(items.length && state.phase === 'lobby');
    if (m.hidden) return;
    var cnt = $('gallery-count'); if (cnt) cnt.textContent = items.length + '장';
    var grid = $('gallery-grid'); if (!grid) return;
    grid.innerHTML = '';
    items.forEach(function (g, i) {
      var card = el('div', 'gallery-item');
      card.setAttribute('data-index', String(i));
      if (g.ops.length || !g.trimmed) {
        var img = document.createElement('img'); img.alt = g.word + ' 그림'; img.src = galleryThumb(i); img.loading = 'lazy';
        card.appendChild(img);
      } else {
        card.appendChild(el('div', 'gallery-empty', '그림 데이터가 너무 커서 생략됐어요'));
      }
      var meta = el('div', 'gallery-meta');
      var wd = el('div', 'gallery-word', g.word);
      if (g.category) wd.appendChild(el('span', 'gallery-cat', g.category));
      meta.appendChild(wd);
      var sub = el('div', 'gallery-sub');
      sub.appendChild(el('span', '', (g.round ? g.round + 'R · ' : '') + '✏️ ' + g.drawerName + ' · ' + g.guessed + '명 맞힘'));
      var dl = el('button', 'btn btn-secondary btn-sm', 'PNG 저장'); dl.type = 'button';
      dl.addEventListener('click', function () {
        try { downloadDataUrl(galleryItemPng(i), safeFile('그림맞추기_' + (state.roomCode || '') + '_' + (i + 1) + '_' + g.word) + '.png'); }
        catch (e) { toast('이미지를 만들지 못했어요', 'error'); }
      });
      sub.appendChild(dl);
      meta.appendChild(sub);
      card.appendChild(meta);
      grid.appendChild(card);
    });
  }

  function onChatMessage(m) {
    if (!m || typeof m !== 'object') return;
    appendChat(m);
  }

  // ------------------------------------------------------------------
  // Timer (server ticks; local fallback keeps counting if ticks stop)
  // ------------------------------------------------------------------
  var tickTimer = null;
  function setTimeLeft(t, serverDriven) {
    applyTimeLeft(t == null ? null : Math.max(0, Math.round(num(t, 0))));
    renderTimers();
    armLocalTick(serverDriven ? 1500 : 1000);
  }
  function armLocalTick(delay) {
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    if (ui.timeLeft == null || state.phase === 'lobby' || !inRoom) return;
    tickTimer = setTimeout(function () {
      tickTimer = null;
      if (ui.timeLeft == null || ui.timeLeft <= 0) return;
      applyTimeLeft(ui.timeLeft - 1); renderTimers(); armLocalTick(1000);
    }, delay);
  }
  // 남은 시간이 실제로 바뀔 때만 갱신하고, choosing/drawing 중 5초 이하로 내려가면 째깍 소리를 낸다.
  function applyTimeLeft(t) {
    var changed = t !== ui.timeLeft;
    ui.timeLeft = t;
    if (changed && t != null && t >= 1 && t <= 5 && (state.phase === 'choosing' || state.phase === 'drawing')) SFX.play('tick');
  }
  function renderTimers() {
    var t = ui.timeLeft;
    var main = $('timer');
    if (main) {
      var show = t != null && state.phase !== 'lobby';
      main.textContent = show ? String(t) : '–';
      main.classList.toggle('urgent', show && t < 10);
      main.classList.toggle('idle', !show);
    }
    ['choosing-timer', 'turnend-timer', 'gameover-timer'].forEach(function (id) {
      var n = $(id); if (!n) return;
      n.textContent = t == null ? '' : String(t);
      n.classList.toggle('urgent', t != null && t < 10 && id === 'choosing-timer');
    });
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function renderAll() {
    renderTopbar(); renderPlayers(); renderCenter(); renderOverlays(); renderTimers(); renderChatInput(); renderGallery();
  }

  function renderTopbar() {
    var rc = $('room-code'); if (rc) rc.textContent = state.roomCode || '----';
    var ri = $('round-indicator');
    if (ri) {
      if (state.phase === 'lobby') ri.textContent = '대기실';
      else if (state.phase === 'gameOver') ri.textContent = '게임 종료';
      else ri.textContent = '라운드 ' + (state.round || 1) + ' / ' + (state.totalRounds || state.settings.rounds || '?');
    }
    renderWordArea();
  }

  function renderWordArea() {
    var wa = $('word-area'); if (!wa) return;
    wa.innerHTML = '';
    var ph = state.phase;
    if (ph === 'choosing') {
      wa.appendChild(el('span', 'word-hint', isDrawer() ? '단어를 골라주세요!' : '단어를 고르고 있어요…'));
    } else if (ph === 'drawing') {
      if (isDrawer() && ui.word) {
        var s = el('span', 'word-secret'); s.appendChild(el('span', 'label', '내 단어')); s.appendChild(el('span', 'word', ui.word));
        if (ui.category) s.appendChild(el('span', 'word-category', ui.category));
        wa.appendChild(s);
      } else if (ui.wordMask) {
        var maskEl = maskNode(ui.wordMask, ui.wordLength);
        var me = findPlayer(myId);
        if (me && me.hasGuessed) maskEl.classList.add('solved');
        if (ui.category && !(me && me.hasGuessed)) {
          var cat = el('span', 'word-category hint'); cat.appendChild(el('span', 'cat-label', '카테고리')); cat.appendChild(el('span', 'cat-name', ui.category));
          maskEl.appendChild(cat);
        }
        wa.appendChild(maskEl);
      } else {
        wa.appendChild(el('span', 'word-hint', '그리는 중…'));
      }
    } else if (ph === 'turnEnd' && ui.turnEnd) {
      wa.appendChild(el('span', 'word-answer', '정답: ' + ui.turnEnd.word));
    }
  }

  // wordMask: 글자 사이 공백 1개, 단어 사이 공백 3개 → 토큰 분해 (빈 토큰 = 단어 경계)
  function maskNode(mask, wordLength) {
    var wrap = el('span', 'mask-wrap');
    var m = el('span', 'mask');
    var tokens = String(mask).split(' ');
    var gapPending = false, boxes = 0, words = 1;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t === '') { if (boxes) gapPending = true; continue; }
      if (gapPending) { m.appendChild(el('span', 'mask-gap')); gapPending = false; words++; }
      var box = el('span', 'mask-box' + (t === '_' ? '' : ' revealed'), t === '_' ? '' : t);
      m.appendChild(box); boxes++;
    }
    wrap.appendChild(m);
    var len = wordLength || boxes;
    if (len) wrap.appendChild(el('span', 'mask-len', '(' + len + '글자' + (words > 1 ? ' · ' + words + '단어' : '') + ')'));
    return wrap;
  }

  function renderPlayers() {
    var list = $('player-list'); if (!list) return;
    var count = $('player-count'); if (count) count.textContent = state.players.length ? state.players.length + ' / 12' : '';
    var sorted = state.players.slice().sort(function (a, b) { return b.score - a.score; });
    list.innerHTML = '';
    var prevScore = null, rank = 0;
    sorted.forEach(function (p, i) {
      if (p.score !== prevScore) { rank = i + 1; prevScore = p.score; }
      var fixedId = fixedDrawerId();
      var isMe = p.id === myId, isDr = (p.id === state.drawerId && state.phase !== 'lobby') || (state.phase === 'lobby' && fixedId === p.id);
      var isNext = !isDr && state.phase !== 'lobby' && state.phase !== 'gameOver' && p.id === state.nextDrawerId;
      var li = el('li', 'player' + (isMe ? ' me' : '') + (p.hasGuessed ? ' guessed' : '') + (isDr ? ' drawing' : '') + (isNext ? ' next' : '') + (p.connected === false ? ' offline' : ''));
      li.setAttribute('data-id', p.id);
      li.appendChild(el('span', 'rank', '#' + rank));
      var av = avatarNode(p.avatar);
      if (isDr) av.appendChild(el('span', 'badge-drawer', '✏️'));
      else if (isNext) av.appendChild(el('span', 'badge-next', '⏭'));
      li.appendChild(av);
      var info = el('span', 'pinfo');
      var name = el('span', 'pname');
      name.appendChild(document.createTextNode(p.name));
      if (isMe) { name.appendChild(document.createTextNode(' ')); name.appendChild(el('span', 'me-tag', '(나)')); }
      if (p.id === state.hostId) { name.appendChild(document.createTextNode(' ')); var crown = el('span', 'host-tag', '👑'); crown.title = '호스트'; name.appendChild(crown); }
      if (isNext) { name.appendChild(document.createTextNode(' ')); var nt = el('span', 'next-tag', '다음 차례'); nt.title = '다음 턴에 그릴 차례예요'; name.appendChild(nt); }
      if (p.connected === false) { name.appendChild(document.createTextNode(' ')); var ot = el('span', 'offline-tag', '연결 끊김'); ot.title = '잠시 후 돌아올 수 있어요'; name.appendChild(ot); }
      info.appendChild(name);
      info.appendChild(el('span', 'pscore', (fixedId === p.id ? '출제자' : p.score + '점') + (p.hasGuessed ? ' · 정답!' : '')));
      li.appendChild(info);
      if (isHost() && !isMe) {
        var k = el('button', 'kick', '✕'); k.type = 'button'; k.title = p.name + ' 강퇴'; k.setAttribute('aria-label', p.name + ' 강퇴');
        k.addEventListener('click', function () {
          if (window.confirm(p.name + '님을 강퇴할까요?')) emit('player:kick', { playerId: p.id });
        });
        li.appendChild(k);
      }
      list.appendChild(li);
    });
  }

  function renderCenter() {
    var lobby = state.phase === 'lobby';
    var sp = $('settings-panel'), mp = $('mode-panel'), cw = $('canvas-wrap'), tb = $('toolbar'), ds = $('draw-status');
    if (mp) mp.hidden = !(lobby && state.lobbyStep === 'mode');
    if (sp) sp.hidden = !(lobby && state.lobbyStep !== 'mode');
    if (cw) cw.hidden = lobby;
    var drawer = isDrawer();
    if (tb) { tb.hidden = lobby || !drawer; tb.setAttribute('aria-disabled', canDraw() ? 'false' : 'true'); }
    if (ds) {
      ds.hidden = lobby || drawer || state.phase === 'gameOver';
      if (!ds.hidden) {
        var dn = playerName(state.drawerId, ui.drawerName || '출제자');
        var txt = state.phase === 'drawing' ? '✏️ ' + dn + '님이 그리고 있어요'
          : state.phase === 'choosing' ? '✏️ ' + dn + '님의 차례예요'
          : '⏳ 다음 턴을 준비하고 있어요';
        ds.innerHTML = '';
        ds.appendChild(el('span', 'draw-status-text', txt));
        if (state.phase === 'drawing') {
          var rb = el('span', 'react-bar');
          [['up', '👍', '좋아요'], ['down', '👎', '아쉬워요']].forEach(function (d) {
            var b = el('button', 'react-btn react-' + d[0], d[1]); b.type = 'button'; b.title = d[2]; b.setAttribute('aria-label', d[2]);
            b.addEventListener('click', function () { sendReact(d[0]); });
            rb.appendChild(b);
          });
          ds.appendChild(rb);
        }
      }
    }
    if (canvas) canvas.classList.toggle('can-draw', canDraw());
    if (lobby) { renderModePanel(); renderSettings(); }
  }

  function renderModePanel() {
    var mp = $('mode-panel'); if (!mp) return;
    var host = isHost();
    mp.querySelectorAll('.mode-card').forEach(function (b) {
      b.classList.toggle('selected', b.getAttribute('data-mode') === state.settings.mode);
      b.disabled = !host;
    });
    var hint = $('mode-hint');
    if (hint) hint.textContent = host ? '어떤 방식으로 놀지 골라주세요. 고르면 게임 설정으로 넘어가요.' : '호스트가 게임 모드를 고르고 있어요…';
  }

  function renderSettings() {
    var s = state.settings, editable = isHost() && state.phase === 'lobby';
    function setVal(id, v) {
      var n = $(id); if (!n) return;
      if (document.activeElement === n && editable) return; // 입력 중엔 덮어쓰지 않음
      if (n.type === 'checkbox') n.checked = !!v; else n.value = String(v);
    }
    setVal('set-rounds', s.rounds); setVal('set-drawTime', s.drawTime); setVal('set-wordCount', s.wordCount);
    setVal('set-hints', s.hints); setVal('set-hintEndAt', s.hintEndAt);
    setVal('set-customWords', s.customWords || ''); setVal('set-customWordsOnly', s.customWordsOnly);
    var fixed = s.mode === 'fixed';
    var badge = $('mode-badge'); if (badge) badge.textContent = MODE_NAMES[s.mode] || s.mode;
    var back = $('btn-mode-back'); if (back) back.hidden = !isHost();
    var rl = $('set-rounds-label'); if (rl) rl.textContent = fixed ? '단어 수' : '라운드';
    var fw = $('set-fixedDrawer-wrap'); if (fw) fw.hidden = !fixed;
    var fsel = $('set-fixedDrawer');
    if (fsel && fixed) {
      var want = fixedDrawerId();
      var key = state.players.map(function (p) { return p.id + ':' + p.name; }).join('|');
      if (fsel.getAttribute('data-key') !== key) {
        fsel.setAttribute('data-key', key); fsel.innerHTML = '';
        state.players.forEach(function (p) {
          var o = el('option', null, p.name + (p.id === myId ? ' (나)' : '') + (p.connected === false ? ' · 연결 끊김' : '')); o.value = p.id; fsel.appendChild(o);
        });
      }
      if (document.activeElement !== fsel) fsel.value = want || '';
    }
    ['set-rounds', 'set-drawTime', 'set-wordCount', 'set-hints', 'set-hintEndAt', 'set-customWords', 'set-customWordsOnly', 'set-fixedDrawer'].forEach(function (id) {
      var n = $(id); if (n) n.disabled = !editable;
    });
    var btn = $('btn-start'), hint = $('start-hint');
    var enough = state.players.length >= 2;
    var fd = fixed ? findPlayer(fixedDrawerId()) : null;
    var drawerOk = !fixed || (fd && fd.connected !== false);
    if (btn) {
      btn.disabled = !(isHost() && enough && drawerOk);
      btn.textContent = isHost() ? '게임 시작' : '호스트를 기다리는 중…';
    }
    if (hint) {
      hint.textContent = !enough ? '플레이어가 2명 이상이어야 시작할 수 있어요'
        : !drawerOk ? '출제자가 접속 중이어야 시작할 수 있어요'
        : (isHost() ? (fixed && fd ? '✏️ ' + fd.name + '님이 ' + s.rounds + '개의 단어를 그려요' : '') : '호스트가 게임을 시작하면 바로 시작돼요');
    }
  }

  function renderOverlays() {
    var ph = state.phase;
    var oc = $('overlay-choosing'), ot = $('overlay-turnend'), og = $('overlay-gameover');
    if (oc) {
      oc.hidden = ph !== 'choosing';
      if (!oc.hidden) {
        var mine = isDrawer() && ui.wordOptions && ui.wordOptions.length;
        var title = $('choosing-title'), opts = $('word-options'), wait = $('choosing-wait');
        var dn = playerName(state.drawerId, ui.drawerName || '출제자');
        if (title) title.textContent = mine ? '단어를 골라주세요!' : dn + '님이 단어를 고르고 있어요';
        if (wait) wait.hidden = !!mine;
        if (opts) {
          opts.hidden = !mine;
          if (!mine && opts.childElementCount) opts.innerHTML = ''; // 이전 턴 후보 버튼 잔존 방지
          var key = mine ? ui.wordOptions.join('\u0001') : '';
          if (key !== ui.optionsKey) {
            ui.optionsKey = key; opts.innerHTML = '';
            if (mine) ui.wordOptions.forEach(function (w) {
              var b = el('button', 'word-option', w); b.type = 'button';
              b.addEventListener('click', function () {
                if (ui.chosenWord) return;
                ui.chosenWord = w; emit('word:choose', { word: w });
                opts.querySelectorAll('.word-option').forEach(function (x) { x.disabled = true; x.classList.toggle('chosen', x === b); });
              });
              opts.appendChild(b);
            });
          }
        }
      } else { ui.optionsKey = ''; }
    }
    if (ot) {
      ot.hidden = !(ph === 'turnEnd' && ui.turnEnd);
      if (!ot.hidden) {
        var te = ui.turnEnd;
        var r = $('turnend-reason'); if (r) r.textContent = REASON_TEXT[te.reason] || '턴 종료';
        var w = $('turnend-word'); if (w) w.textContent = te.word;
        var dl = $('turnend-deltas');
        if (dl) {
          dl.innerHTML = '';
          te.deltas.slice().sort(function (a, b) { return num(b.delta, 0) - num(a.delta, 0); }).forEach(function (d) {
            var p = findPlayer(d.id), delta = num(d.delta, 0);
            var row = el('li', 'delta-row');
            row.appendChild(avatarNode(p ? p.avatar : null));
            var nm = el('span', 'dname', (p ? p.name : '(나간 플레이어)') + (d.id === myId ? ' (나)' : ''));
            row.appendChild(nm);
            row.appendChild(el('span', 'delta' + (delta > 0 ? ' pos' : ''), '+' + delta));
            dl.appendChild(row);
          });
        }
      }
    }
    if (og) {
      og.hidden = !(ph === 'gameOver' && ui.ranking);
      if (!og.hidden) {
        var gd = $('gameover-drawer');
        if (gd) { gd.hidden = !ui.gameOverDrawer; if (ui.gameOverDrawer) gd.textContent = '✏️ 출제자: ' + ui.gameOverDrawer.name + ' (순위에 포함되지 않아요)'; }
        var pod = $('podium'), rl = $('ranking-list');
        var rk = ui.ranking, medals = ['🥇', '🥈', '🥉'];
        if (pod) {
          pod.innerHTML = '';
          var order = [1, 0, 2];
          order.forEach(function (idx) {
            var slot = el('div', 'podium-slot p' + (idx + 1));
            var pl = rk[idx];
            if (pl) {
              slot.appendChild(el('div', 'medal', medals[idx]));
              slot.appendChild(avatarNode(pl.avatar));
              slot.appendChild(el('div', 'pname', pl.name + (pl.id === myId ? ' (나)' : '')));
              slot.appendChild(el('div', 'pscore', pl.score + '점'));
            }
            slot.appendChild(el('div', 'podium-bar'));
            pod.appendChild(slot);
          });
        }
        if (rl) {
          rl.innerHTML = '';
          rk.forEach(function (pl, i) {
            var row = el('li', 'ranking-row');
            row.appendChild(el('span', 'rank', i < 3 ? medals[i] : '#' + (i + 1)));
            row.appendChild(avatarNode(pl.avatar));
            row.appendChild(el('span', 'rname', pl.name + (pl.id === myId ? ' (나)' : '')));
            row.appendChild(el('span', 'rscore', pl.score + '점'));
            rl.appendChild(row);
          });
        }
      }
    }
  }

  function renderChatInput() {
    var ci = $('chat-input'); if (!ci) return;
    if (state.phase === 'drawing' && !isDrawer()) {
      var me = findPlayer(myId);
      ci.placeholder = me && me.hasGuessed ? '정답자들과 채팅…' : '정답을 입력하세요…';
    } else ci.placeholder = '메시지를 입력하세요…';
  }

  // ------------------------------------------------------------------
  // Chat
  // ------------------------------------------------------------------
  function appendChat(m) {
    var list = $('chat-list'); if (!list) return;
    var kind = typeof m.kind === 'string' ? m.kind : 'chat';
    var text = m.text == null ? '' : String(m.text);
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    var node;
    if (kind === 'system') {
      node = el('div', 'msg msg-system', text);
      if (text.indexOf('입장했습니다') !== -1) SFX.play('join');
      else if (text.indexOf('나갔습니다') !== -1 || text.indexOf('강퇴되었습니다') !== -1) SFX.play('leave');
    } else if (kind === 'correct') {
      node = el('div', 'msg msg-correct'); node.appendChild(el('span', 'msg-icon', '🎉')); node.appendChild(el('span', 'msg-text', text));
      SFX.play(m.id === myId ? 'correctSelf' : 'correctOther');
    } else if (kind === 'close') {
      node = el('div', 'msg msg-close'); node.appendChild(el('span', 'msg-icon', '🔥')); node.appendChild(el('span', 'msg-text', text)); node.appendChild(el('span', 'msg-note', '거의 맞았어요!'));
      SFX.play('close');
    }
    else if (kind === 'guessed-chat') {
      node = el('div', 'msg msg-guessed'); node.appendChild(el('span', 'msg-icon', '🔒'));
      if (m.name) node.appendChild(el('span', 'msg-name', String(m.name)));
      node.appendChild(el('span', 'msg-text', text));
    } else {
      node = el('div', 'msg msg-chat' + (m.id && m.id === myId ? ' msg-mine' : ''));
      node.appendChild(avatarNode(m.avatar));
      if (m.name) node.appendChild(el('span', 'msg-name', String(m.name)));
      node.appendChild(el('span', 'msg-text', text));
    }
    list.appendChild(node);
    while (list.children.length > 300) list.removeChild(list.firstChild);
    if (atBottom) list.scrollTop = list.scrollHeight;
  }
  function clearChat() { var list = $('chat-list'); if (list) list.innerHTML = ''; }

  // ------------------------------------------------------------------
  // Landing / room navigation
  // ------------------------------------------------------------------
  function loadProfile() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (typeof p.name === 'string') profile.name = p.name.slice(0, 12);
          if (EMOJIS.indexOf(p.emoji) !== -1) profile.emoji = p.emoji;
          if (isHex(p.color)) profile.color = p.color;
        }
      }
    } catch (e) { /* ignore */ }
  }
  function saveProfile() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profile)); } catch (e) { /* ignore */ }
  }
  function renderProfile() {
    var pv = $('avatar-preview'), pe = $('avatar-preview-emoji');
    if (pv) pv.style.setProperty('--av', profile.color);
    if (pe) pe.textContent = profile.emoji;
    var strip = $('emoji-strip');
    if (strip) strip.querySelectorAll('.emoji-btn').forEach(function (b) { b.setAttribute('aria-checked', b.textContent === profile.emoji ? 'true' : 'false'); });
    var row = $('color-row');
    if (row) row.querySelectorAll('.color-btn').forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-color') === profile.color ? 'true' : 'false'); });
  }
  function buildLanding() {
    var strip = $('emoji-strip');
    if (strip) EMOJIS.forEach(function (em) {
      var b = el('button', 'emoji-btn', em); b.type = 'button'; b.setAttribute('role', 'radio');
      b.addEventListener('click', function () { profile.emoji = em; saveProfile(); renderProfile(); });
      strip.appendChild(b);
    });
    var row = $('color-row');
    if (row) AV_COLORS.forEach(function (c) {
      var b = el('button', 'color-btn'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('data-color', c); b.style.background = c; b.title = c;
      b.addEventListener('click', function () { profile.color = c; saveProfile(); renderProfile(); });
      row.appendChild(b);
    });
    var nick = $('nick');
    if (nick) {
      nick.value = profile.name;
      nick.addEventListener('input', function () { profile.name = nick.value.slice(0, 12); saveProfile(); });
      nick.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var code = codeInput(); if (code.length === 4) joinRoom(); else createRoom(); } });
    }
    var codeIn = $('room-code-input');
    if (codeIn) {
      codeIn.addEventListener('input', function () {
        var v = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
        if (v !== codeIn.value) codeIn.value = v;
      });
      codeIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); joinRoom(); } });
    }
    var bc = $('btn-create'); if (bc) bc.addEventListener('click', createRoom);
    var bj = $('btn-join'); if (bj) bj.addEventListener('click', joinRoom);

    // ?room=CODE 프리필
    try {
      var qs = new URLSearchParams(location.search);
      var rc = (qs.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
      if (rc && codeIn) { codeIn.value = rc; if (nick) nick.focus(); }
    } catch (e) { /* ignore */ }
    renderProfile();
  }
  function codeInput() { var n = $('room-code-input'); return n ? n.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) : ''; }
  function currentProfile() {
    var nick = $('nick');
    var name = (nick ? nick.value : profile.name).trim().slice(0, 12);
    return { name: name, avatar: { emoji: profile.emoji, color: profile.color } };
  }
  function validName() {
    var p = currentProfile();
    if (!p.name) { toast('닉네임을 입력해주세요', 'error'); var n = $('nick'); if (n) n.focus(); return null; }
    return p;
  }
  var busy = false;
  function setBusy(v) {
    busy = v;
    ['btn-create', 'btn-join'].forEach(function (id) { var b = $(id); if (b) b.disabled = v; });
  }
  // onFail(errorText)를 주면 실패 시 기본 토스트 대신 그 콜백을 호출한다(재접속 흐름용).
  function withAck(ev, payload, done, onFail) {
    if (!socket) { if (onFail) onFail('서버에 연결되어 있지 않아요'); else toast('서버에 연결되어 있지 않아요', 'error'); return; }
    if (busy) return;
    setBusy(true);
    var finished = false;
    var failWith = function (msg) { if (onFail) onFail(msg); else toast(msg, 'error'); };
    var timer = setTimeout(function () { if (!finished) { finished = true; setBusy(false); failWith('서버 응답이 없어요. 잠시 후 다시 시도해주세요'); } }, 7000);
    emit(ev, payload, function (ack) {
      if (finished) return; finished = true; clearTimeout(timer); setBusy(false);
      if (!ack || ack.ok !== true) { failWith(ack && ack.error ? ack.error : '요청에 실패했어요'); return; }
      done(ack);
    });
  }
  function createRoom() {
    var p = validName(); if (!p) return;
    profile.name = p.name; saveProfile();
    p.token = getToken();
    withAck('room:create', p, function (ack) { setToken(ack.token); enterRoom(ack.roomCode, ack.playerId); });
  }
  function joinRoom() {
    var code = codeInput();
    if (code.length !== 4) { toast('방 코드는 영문 4글자예요', 'error'); var c = $('room-code-input'); if (c) c.focus(); return; }
    var p = validName(); if (!p) return;
    profile.name = p.name; saveProfile();
    withAck('room:join', { roomCode: code, name: p.name, avatar: p.avatar, token: getToken() }, function (ack) { setToken(ack.token); enterRoom(ack.roomCode || code, ack.playerId); });
  }

  /** 끊긴 방에 같은 자리로 복귀 시도. 실패하면 랜딩으로. */
  function tryRejoin(code) {
    var wasInRoom = inRoom;
    rejoinTarget = null;
    withAck('room:rejoin', { roomCode: code, token: getToken() }, function (ack) {
      setToken(ack.token);
      if (!wasInRoom) { enterRoom(ack.roomCode || code, ack.playerId); }
      else { myId = ack.playerId || myId; renderAll(); }
      toast('다시 연결되었어요', 'ok');
    }, function (err) {
      clearLastRoom();
      if (wasInRoom) { toast(err || '이어서 참가할 수 없어요', 'error'); resetToLanding(false); }
      else { myId = socket && socket.id ? socket.id : myId; }
    });
  }

  /** 반응(👍/👎)을 보낸 사람의 아바타 위에 1초간 띄운다. 연타하면 겹쳐서 여러 개 뜬다. */
  function onReactShow(p) {
    if (!p || !p.id) return;
    var li = document.querySelector('#player-list li[data-id="' + String(p.id).replace(/"/g, '') + '"]');
    var av = li && li.querySelector('.avatar');
    if (!av) return;
    var pop = el('span', 'react-pop ' + (p.kind === 'down' ? 'down' : 'up'), p.kind === 'down' ? '👎' : '👍');
    pop.style.left = (30 + Math.round((Math.random() - 0.5) * 36)) + 'px';
    pop.style.setProperty('--rot', ((Math.random() - 0.5) * 30).toFixed(1) + 'deg');
    av.appendChild(pop);
    setTimeout(function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1000);
  }
  function sendReact(kind) {
    if (state.phase !== 'drawing' || isDrawer()) return;
    emit('react:send', { kind: kind });
  }

  function enterRoom(code, playerId) {
    inRoom = true;
    rejoinTarget = null;
    myId = playerId || (socket && socket.id) || myId;
    state.roomCode = String(code || '').toUpperCase();
    saveLastRoom(state.roomCode);
    clearChat(); resetCanvasState();
    ui.wordMask = ''; ui.word = null; ui.wordOptions = null; ui.turnEnd = null; ui.ranking = null; ui.timeLeft = null;
    var vl = $('view-landing'), vr = $('view-room');
    if (vl) vl.hidden = true; if (vr) vr.hidden = false;
    try {
      var qs = new URLSearchParams(location.search); qs.set('room', state.roomCode);
      history.replaceState(null, '', location.pathname + '?' + qs.toString());
    } catch (e) { /* file:// 등 */ }
    renderAll();
    var ci = $('chat-input'); if (ci && window.innerWidth >= 1100) ci.focus();
  }

  function resetToLanding(sendLeave) {
    if (sendLeave) emit('room:leave');
    inRoom = false;
    rejoinTarget = null;
    clearLastRoom();
    cancelLocalStroke(false);
    state.roomCode = null; state.hostId = null; state.phase = 'lobby'; state.round = 0; state.totalRounds = 0;
    state.drawerId = null; state.players = []; state.settings = Object.assign({}, DEFAULT_SETTINGS);
    ui.wordMask = ''; ui.word = null; ui.wordOptions = null; ui.turnEnd = null; ui.ranking = null; ui.optionsKey = '';
    ui.gallery = null; ui.galleryThumbs = []; ui.galleryOpen = false;
    state.lobbyStep = 'mode'; state.fixedDrawerId = null;
    setTimeLeft(null);
    resetCanvasState(); clearChat();
    var vl = $('view-landing'), vr = $('view-room');
    if (vr) vr.hidden = true; if (vl) vl.hidden = false;
    try {
      var qs = new URLSearchParams(location.search); qs.delete('room');
      var q = qs.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
    } catch (e) { /* ignore */ }
    renderAll();
  }

  function copyInvite() {
    if (!state.roomCode) return;
    var url = location.origin + location.pathname + '?room=' + state.roomCode;
    function ok() { toast('초대 링크를 복사했어요!', 'ok'); }
    function fallback() {
      try {
        var ta = document.createElement('textarea'); ta.value = url; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
        var done = document.execCommand && document.execCommand('copy'); document.body.removeChild(ta);
        if (done) ok(); else toast('복사에 실패했어요. 방 코드: ' + state.roomCode, 'error');
      } catch (e) { toast('복사에 실패했어요. 방 코드: ' + state.roomCode, 'error'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, fallback);
    else fallback();
  }

  // ------------------------------------------------------------------
  // Room UI wiring
  // ------------------------------------------------------------------
  function fillSelect(id, values, fmt) {
    var s = $(id); if (!s) return;
    s.innerHTML = '';
    values.forEach(function (v) { var o = el('option', null, fmt ? fmt(v) : String(v)); o.value = String(v); s.appendChild(o); });
  }
  function collectSettings() {
    var s = Object.assign({}, state.settings);
    var g = function (id) { return $(id); };
    if (g('set-rounds')) s.rounds = clamp(num(g('set-rounds').value, 3), 1, 10);
    if (g('set-drawTime')) s.drawTime = clamp(num(g('set-drawTime').value, 80), 30, 180);
    if (g('set-wordCount')) s.wordCount = clamp(num(g('set-wordCount').value, 3), 2, 5);
    if (g('set-hints')) s.hints = clamp(num(g('set-hints').value, 2), 0, 5);
    if (g('set-hintEndAt')) s.hintEndAt = clamp(num(g('set-hintEndAt').value, 15), 5, 60);
    if (g('set-customWords')) s.customWords = String(g('set-customWords').value || '').slice(0, 2000);
    if (g('set-customWordsOnly')) s.customWordsOnly = !!g('set-customWordsOnly').checked;
    if (s.mode === 'fixed' && g('set-fixedDrawer') && g('set-fixedDrawer').value) s.fixedDrawerId = g('set-fixedDrawer').value;
    return s;
  }
  function sendSettings() {
    if (!isHost() || state.phase !== 'lobby') return;
    var s = collectSettings();
    state.settings = s;
    emit('room:settings', { settings: s });
  }
  var sendSettingsDebounced = debounce(sendSettings, 300);

  function buildRoom() {
    var range = function (a, b, step) { var r = []; for (var v = a; v <= b; v += (step || 1)) r.push(v); return r; };
    fillSelect('set-rounds', range(1, 10), function (v) { return v + ' 라운드'; });
    fillSelect('set-drawTime', range(30, 180, 10), function (v) { return v + '초'; });
    fillSelect('set-wordCount', range(2, 5), function (v) { return v + '개'; });
    fillSelect('set-hints', range(0, 5), function (v) { return v === 0 ? '없음' : v + '회'; });
    fillSelect('set-hintEndAt', [5, 10, 15, 20, 30, 45, 60], function (v) { return '종료 ' + v + '초 전'; });

    ['set-rounds', 'set-drawTime', 'set-wordCount', 'set-hints', 'set-hintEndAt', 'set-customWordsOnly', 'set-fixedDrawer'].forEach(function (id) {
      var n = $(id); if (n) n.addEventListener('change', sendSettings);
    });
    document.querySelectorAll('#mode-panel .mode-card').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!isHost() || state.phase !== 'lobby') return;
        var mode = b.getAttribute('data-mode');
        state.settings = Object.assign({}, state.settings, { mode: mode });
        emit('room:settings', { settings: state.settings });
        emit('lobby:step', { step: 'settings' });
        state.lobbyStep = 'settings'; renderAll();
      });
    });
    var mb = $('btn-mode-back');
    if (mb) mb.addEventListener('click', function () {
      if (!isHost() || state.phase !== 'lobby') return;
      emit('lobby:step', { step: 'mode' });
      state.lobbyStep = 'mode'; renderAll();
    });
    var cw = $('set-customWords');
    if (cw) { cw.addEventListener('input', sendSettingsDebounced); cw.addEventListener('blur', sendSettings); }

    var bs = $('btn-start');
    if (bs) bs.addEventListener('click', function () {
      if (!isHost()) return;
      if (state.players.length < 2) { toast('플레이어가 2명 이상이어야 시작할 수 있어요', 'error'); return; }
      emit('game:start');
    });
    var bc = $('btn-copy'); if (bc) bc.addEventListener('click', copyInvite);
    var bl = $('btn-leave'); if (bl) bl.addEventListener('click', function () { resetToLanding(true); });
    var bs = $('btn-sound'); if (bs) { renderSoundButton(bs); bs.addEventListener('click', function () { SFX.toggle(); renderSoundButton(bs); }); }
    var go = $('btn-gallery-open'); if (go) go.addEventListener('click', openGallery);
    var gl = $('btn-gallery-lobby'); if (gl) gl.addEventListener('click', openGallery);
    var gc = $('btn-gallery-close'); if (gc) gc.addEventListener('click', closeGallery);
    var gs = $('btn-gallery-sheet'); if (gs) gs.addEventListener('click', function () {
      try { downloadDataUrl(gallerySheetPng(), safeFile('그림맞추기_' + (state.roomCode || '') + '_전체') + '.png'); }
      catch (e) { toast('이미지를 만들지 못했어요', 'error'); }
    });
    var gm = $('overlay-gallery'); if (gm) gm.addEventListener('click', function (e) { if (e.target === gm) closeGallery(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ui.galleryOpen) closeGallery(); });

    var form = $('chat-form'), input = $('chat-input');
    if (form && input) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = input.value.trim().slice(0, 100);
        if (!text) { input.focus(); return; }
        emit('chat:message', { text: text });
        input.value = ''; input.focus();
      });
    }
    buildToolbar();
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function boot() {
    loadProfile();
    buildLanding();
    buildRoom();
    clearCanvas();
    renderAll();
    connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 디버깅용 (콘솔에서 상태 확인)
  window.__dg = { state: state, ui: ui, ops: function () { return ops; }, redrawAll: redrawAll, myId: function () { return myId; } };
})();
