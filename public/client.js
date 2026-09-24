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
  // 프로필 사진(avatar.img): https(카카오 http 는 https 로) · 개발 모크용 data:image/ · blob: 만. 한 번 로드에 실패한 주소는 다시 시도하지 않는다
  var badImgs = {};
  function avatarImgUrl(u) {
    if (typeof u !== 'string' || !u || u.length > 2048) return null;
    if (/^http:\/\//i.test(u)) u = 'https://' + u.slice(7);
    if (!/^(https:\/\/|data:image\/|blob:)/i.test(u) || badImgs[u]) return null;
    return u;
  }
  function safeAvatar(a) {
    var emoji = a && typeof a.emoji === 'string' && a.emoji ? a.emoji : '🙂';
    var color = a && isHex(a.color) ? a.color : '#d6d6d6';
    var img = a ? avatarImgUrl(a.img) : null;
    return img ? { emoji: emoji, color: color, img: img } : { emoji: emoji, color: color };
  }
  /**
   * node 안을 아바타로 채운다: img 가 있으면 둥근 사진(<img class="avatar-img">), 없거나 로드에 실패하면 emoji + 배경색(--av).
   * node 의 다른 자식(배지·반응 팝업)은 이 함수를 부른 뒤에 붙인다. 같은 사진이면 다시 그리지 않는다(깜빡임 방지).
   */
  function paintAvatar(node, a) {
    if (!node) return;
    var av = safeAvatar(a);
    node.style.setProperty('--av', av.color);
    var cur = node.firstElementChild && node.firstElementChild.classList.contains('avatar-img') ? node.firstElementChild : null;
    if (av.img && cur && cur.getAttribute('src') === av.img) return;
    node.textContent = '';
    node.classList.toggle('has-img', !!av.img);
    if (!av.img) { node.textContent = av.emoji; return; }
    var img = document.createElement('img');
    img.className = 'avatar-img'; img.alt = ''; img.decoding = 'async'; img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer'; img.setAttribute('referrerpolicy', 'no-referrer'); // Google 프로필 사진은 referrer 가 있으면 403
    img.onerror = function () {
      badImgs[av.img] = 1;
      if (img.parentNode !== node) return;
      node.removeChild(img); node.classList.remove('has-img');
      node.insertBefore(document.createTextNode(av.emoji), node.firstChild);
    };
    img.src = av.img;
    node.appendChild(img);
  }
  function avatarNode(a, extraCls) {
    var n = el('span', 'avatar' + (extraCls ? ' ' + extraCls : ''));
    paintAvatar(n, a);
    return n;
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var state = {
    roomCode: null, hostId: null, phase: 'lobby', round: 0, totalRounds: 0,
    drawerId: null, settings: Object.assign({}, DEFAULT_SETTINGS), players: [],
    lobbyStep: 'mode', fixedDrawerId: null,
    allowSolo: false // 서버가 ALLOW_SOLO=1 로 떠 있으면 true(최소 인원 1명). room:state 로 내려온다
  };
  function minPlayers() { return state.allowSolo ? 1 : 2; }
  var MODE_NAMES = { classic: '돌아가며 그리기', fixed: '한 명이 그리기', blitz: '속도전' };
  // 모드 카드를 고를 때 함께 적용되는 프리셋 (그 뒤엔 설정 화면에서 자유롭게 바꿀 수 있다)
  var MODE_PRESETS = { blitz: { drawTime: 25, hints: 0, rounds: 5 }, classic: { drawTime: 80, hints: 2, rounds: 3 }, fixed: { drawTime: 80, hints: 2, rounds: 5 } };
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
    galleryThumbs: [],  // 렌더링한 썸네일 dataURL 캐시 (gallery와 같은 인덱스)
    recentChat: []      // 최근 채팅 3개 { kind, name, text, mine } — 모바일 티커/말풍선/접힌 채팅 바용
  };

  var profile = { name: '', emoji: EMOJIS[0], color: AV_COLORS[4] };
  // 로그인 사용자의 사진 설정(프로필 설정 단계). mode: 'photo' | 'emoji', url: 지금 사진, social: 소셜 로그인 기본 사진
  var photo = { mode: 'emoji', url: null, social: null, uploading: false };

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
    try { socket = io({ auth: { token: acctToken() || undefined } }); } catch (e) { toast('서버 연결에 실패했어요', 'error'); return; }

    on('connect', function () {
      connectErrorToasted = false;
      if (acct.lastToken) emit('auth:token', { token: acct.lastToken });
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
        return { id: p.id, name: String(p.name || '?'), avatar: safeAvatar(p.avatar), score: num(p.score, 0), isDrawing: !!p.isDrawing, hasGuessed: !!p.hasGuessed, connected: p.connected !== false, atResults: !!p.atResults, loggedIn: !!p.loggedIn };
      });
    }
    if (inRoom && myId && state.players.length && !findPlayer(myId)) {
      // 강퇴 등으로 방에서 빠진 경우
      toast('방에서 나가게 되었어요', 'error'); resetToLanding(false); return;
    }
    state.nextDrawerId = s.nextDrawerId == null ? null : s.nextDrawerId;
    if (s.lobbyStep === 'mode' || s.lobbyStep === 'settings') state.lobbyStep = s.lobbyStep;
    state.fixedDrawerId = s.fixedDrawerId == null ? null : s.fixedDrawerId;
    if (typeof s.allowSolo === 'boolean') state.allowSolo = s.allowSolo;
    if (state.phase === 'lobby' && prevPhase !== 'lobby') {
      resetCanvasState(); ui.wordMask = ''; ui.word = null; ui.wordOptions = null; ui.chosenWord = null;
      ui.turnEnd = null; setTimeLeft(null);
      // ui.ranking 은 유지 — 결과 화면은 내가 "대기실로 돌아가기"를 누를 때까지 보여야 한다
    }
    var meNow = findPlayer(myId);
    if (meNow && !meNow.atResults && ui.ranking && !ui.resultsPending) ui.ranking = null; // 서버가 결과 확인을 반영하면 정리
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
    ui.resultsPending = true; // room:state 의 atResults 가 도착하기 전까지는 결과 화면 유지
    setTimeout(function () { ui.resultsPending = false; }, 1500);
    setTimeLeft(null);
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
      sub.appendChild(el('span', 'gallery-by', (g.round ? g.round + 'R · ' : '') + '✏️ ' + g.drawerName + ' · ' + g.guessed + '명 맞힘'));
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
    // 모바일 CSS가 단계/역할별로 레이아웃을 바꿀 수 있도록 루트에 표시한다 (JS 레이아웃 코드 없이 CSS만으로 전환)
    var vr = $('view-room');
    if (vr) { vr.setAttribute('data-phase', state.phase); vr.setAttribute('data-role', isDrawer() ? 'drawer' : 'guesser'); }
    placeMobileChrome();
    if (roomProfile.open && (!inRoom || state.phase !== 'lobby')) { closeRoomProfile(); if (inRoom) toast('게임이 시작돼 프로필 수정을 닫았어요'); }
    var rpb = $('btn-room-profile');
    if (rpb) { rpb.disabled = inRoom && state.phase !== 'lobby'; rpb.title = rpb.disabled ? '대기실에서 바꿀 수 있어요' : '닉네임·아바타 바꾸기'; }
    renderTopbar(); renderPlayers(); renderCenter(); renderOverlays(); renderTimers(); renderChatInput(); renderGallery(); renderChatPeek(); renderAccount();
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
    // 모바일 CSS 가 글자 수에 따라 칸 크기를 줄일 수 있게 표시한다 (≤8 s, 9~14 m, 15+ l)
    wrap.setAttribute('data-len', String(boxes));
    wrap.setAttribute('data-size', boxes <= 8 ? 's' : boxes <= 14 ? 'm' : 'l');
    if (len) wrap.appendChild(el('span', 'mask-len', '(' + len + '글자' + (words > 1 ? ' · ' + words + '단어' : '') + ')'));
    return wrap;
  }

  function renderPlayers() {
    var list = $('player-list'); if (!list) return;
    var countText = state.players.length ? state.players.length + ' / 12' : '';
    var count = $('player-count'); if (count) count.textContent = countText;
    var sheetCount = $('sheet-player-count'); if (sheetCount) sheetCount.textContent = countText;
    renderPlayerList(list);
    // 모바일 플레이어 시트가 열려 있으면 같은 렌더링으로 그 안의 목록도 갱신한다
    var sheet = $('sheet-players'), sheetList = $('sheet-player-list');
    if (sheet && sheetList) { if (!sheet.hidden) renderPlayerList(sheetList); else sheetList.innerHTML = ''; }
    renderTurnStrip();
    updatePlayerStripFade();
  }
  /** 순위 정렬된 플레이어 <li> 들을 list 에 채운다 (데스크톱 목록과 모바일 시트가 공유) */
  function renderPlayerList(list) {
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
  /** 모바일 게임 중 턴 띠: "✏️ 민수 그리는 중 · 다음 지은 · 정답 2/4" (fixed 모드는 '다음' 없음) */
  function renderTurnStrip() {
    var t = $('turn-strip-text'); if (!t) return;
    t.innerHTML = '';
    if (state.phase === 'lobby') return;
    function sep() { t.appendChild(el('span', 'ts-sep', '·')); }
    var dn = playerName(state.drawerId, ui.drawerName || '출제자');
    if (state.phase === 'gameOver') { t.appendChild(document.createTextNode('🏁 게임 종료')); return; }
    if (state.phase === 'turnEnd') { t.appendChild(document.createTextNode('⏳ ')); t.appendChild(el('b', null, dn)); t.appendChild(document.createTextNode(' 턴 종료')); }
    else {
      t.appendChild(document.createTextNode('✏️ ')); t.appendChild(el('b', null, dn + (state.drawerId === myId ? '(나)' : '')));
      t.appendChild(document.createTextNode(state.phase === 'choosing' ? ' 단어 고르는 중' : ' 그리는 중'));
    }
    if (state.settings.mode !== 'fixed' && state.nextDrawerId && state.nextDrawerId !== state.drawerId) {
      var np = findPlayer(state.nextDrawerId);
      if (np) { sep(); var nx = el('span', 'ts-muted', '다음 '); nx.appendChild(el('b', null, np.name)); t.appendChild(nx); }
    }
    if (state.phase === 'drawing') {
      var guessers = state.players.filter(function (p) { return p.id !== state.drawerId && p.connected !== false; });
      var got = guessers.filter(function (p) { return p.hasGuessed; }).length;
      sep(); t.appendChild(el('span', 'ts-guessed', '정답 ' + got + '/' + guessers.length));
    }
  }
  /** 모바일 가로 스크롤 플레이어 띠: 오른쪽에 더 있으면 패널에 .has-more 를 붙여 CSS 페이드로 힌트를 준다 */
  function updatePlayerStripFade() {
    var list = $('player-list'); var panel = list && list.parentNode; if (!panel || !panel.classList) return;
    var more = list.scrollWidth - list.clientWidth - list.scrollLeft > 4;
    panel.classList.toggle('has-more', more);
  }

  function renderCenter() {
    requestAnimationFrame(fitDrawerCanvas); // 레이아웃 확정 후 출제자 캔버스 크기 맞춤(모바일)
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
        // 자식은 정적(#draw-status-text, #react-bar [+ 모바일에서 옮겨 온 #btn-chat-expand]) — innerHTML 로 갈아엎지 않는다
        var dst = $('draw-status-text'); if (dst) dst.textContent = txt;
        var rb = $('react-bar');
        if (rb) {
          var wantReact = state.phase === 'drawing';
          if (!wantReact) rb.innerHTML = '';
          else if (!rb.childElementCount) {
            [['up', '👍', '좋아요'], ['down', '👎', '아쉬워요']].forEach(function (d) {
              var b = el('button', 'react-btn react-' + d[0], d[1]); b.type = 'button'; b.title = d[2]; b.setAttribute('aria-label', d[2]);
              b.addEventListener('click', function () { sendReact(d[0]); });
              rb.appendChild(b);
            });
          }
        }
      } else { var rb0 = $('react-bar'); if (rb0) rb0.innerHTML = ''; }
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
    // 속도전: 단어 후보·힌트 설정은 의미가 없으므로 숨긴다
    var blitz = s.mode === 'blitz';
    ['set-wordCount', 'set-hints', 'set-hintEndAt'].forEach(function (id) {
      var n = $(id); var wrap = n && n.closest ? n.closest('.setting') : null; if (wrap) wrap.hidden = blitz;
    });
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
    var need = minPlayers();
    var enough = state.players.length >= need;
    var fd = fixed ? findPlayer(fixedDrawerId()) : null;
    var drawerOk = !fixed || (fd && fd.connected !== false);
    var viewing = state.players.filter(function (p) { return p.connected !== false && p.atResults; }).map(function (p) { return p.name + (p.id === myId ? '(나)' : ''); });
    if (btn) {
      btn.disabled = !(isHost() && enough && drawerOk && !viewing.length);
      btn.textContent = isHost() ? '게임 시작' : '호스트를 기다리는 중…';
    }
    if (hint) {
      hint.textContent = viewing.length ? '결과 화면을 보고 있는 사람이 있어요: ' + viewing.join(', ')
        : !enough ? '플레이어가 ' + need + '명 이상이어야 시작할 수 있어요'
        : !drawerOk ? '출제자가 접속 중이어야 시작할 수 있어요'
        : (isHost() ? (fixed && fd ? '✏️ ' + fd.name + '님이 ' + s.rounds + '개의 단어를 그려요' : blitz ? '⚡ 단어는 자동으로 정해지고 ' + s.drawTime + '초씩, 힌트 없음. 1등 400 · 2등 300 · 3등 200점' : '') : '호스트가 게임을 시작하면 바로 시작돼요');
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
      var meR = findPlayer(myId);
      og.hidden = !(ui.ranking && (ph === 'gameOver' || (meR && meR.atResults) || ui.resultsPending));
      if (!og.hidden) {
        var rw = $('results-waiting');
        if (rw) {
          var others = state.players.filter(function (p) { return p.id !== myId && p.connected !== false && p.atResults; }).map(function (p) { return p.name; });
          rw.textContent = others.length ? '아직 결과를 보는 중: ' + others.join(', ') : '';
        }
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
    // 모바일 요약(티커 · 말풍선 · 접힌 채팅 바)용 최근 메시지
    ui.recentChat.push({ kind: kind, name: m.name ? String(m.name) : '', text: text, mine: !!(m.id && m.id === myId) });
    while (ui.recentChat.length > 3) ui.recentChat.shift();
    renderChatPeek(true);
  }
  function clearChat() { var list = $('chat-list'); if (list) list.innerHTML = ''; ui.recentChat = []; renderChatPeek(false); }
  function scrollChatBottom() { var list = $('chat-list'); if (list) list.scrollTop = list.scrollHeight; }

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
    var logged = acctLoggedIn(), photoMode = logged && photo.mode === 'photo';
    var sp = $('landing-step-profile'); if (sp) sp.classList.toggle('is-photo', photoMode);
    var seg = $('avatar-mode'); if (seg) seg.hidden = !logged;
    ['btn-mode-photo', 'btn-mode-emoji'].forEach(function (id) {
      var b = $(id); if (b) b.setAttribute('aria-checked', b.getAttribute('data-mode') === (photoMode ? 'photo' : 'emoji') ? 'true' : 'false');
    });
    var pp = $('photo-panel'); if (pp) pp.hidden = !photoMode;
    var ep = $('emoji-pickers'); if (ep) ep.hidden = photoMode;
    paintAvatar($('photo-preview'), { emoji: profile.emoji, color: profile.color, img: photo.url });
    var ph = $('photo-hint'); if (ph) ph.hidden = !!(photo.url && avatarImgUrl(photo.url));
    var pr = $('btn-photo-reset'); if (pr) { pr.hidden = !(photo.social && photo.url !== photo.social); pr.disabled = photo.uploading; }
    var pu = $('btn-photo-upload'); if (pu) { pu.disabled = photo.uploading; pu.textContent = photo.uploading ? '올리는 중…' : '사진 올리기'; }
    var pv = $('avatar-preview'), pe = $('avatar-preview-emoji');
    if (pv) pv.style.setProperty('--av', profile.color);
    if (pe) pe.textContent = profile.emoji;
    var strip = $('emoji-strip');
    if (strip) strip.querySelectorAll('.emoji-btn').forEach(function (b) { b.setAttribute('aria-checked', b.textContent === profile.emoji ? 'true' : 'false'); });
    var row = $('color-row');
    if (row) row.querySelectorAll('.color-btn').forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-color') === profile.color ? 'true' : 'false'); });
  }
  // ------------------------------------------------------------------
  // 랜딩 3화면 = 3주소: /login(시작: Google/카카오/게스트) · /profile(프로필 설정) · /(메인: 만들기 / 코드로 참가 / 초대받은 방)
  //   한 페이지 안에서 주소만 바꾼다(pushState) → 소켓·로그인 상태가 끊기지 않는다. 서버는 세 주소 모두 index.html 을 준다.
  //   들어갈 조건(resolveStep): 게스트는 이 탭에서 "게스트로 시작하기"를 지나야(sessionStorage) 프로필/메인에 들어간다 → 새로 오면 늘 /login.
  //     로그인 기능이 꺼져 있으면 /login 대신 /profile 이 첫 화면. 로그인 사용자는 /login 에 오면 메인(처음이면 /profile)으로.
  //     메인은 닉네임이 있어야 하고, 로그인 사용자는 이 브라우저에서 프로필을 확정("저장")한 적이 있어야 한다.
  //   뒤로가기 = 들어온 곳: 메인 → 프로필 수정/로그인 은 { from: 'room' } 을 붙여 push, "저장"·로그인 완료는 history.back() 으로 메인에 돌아간다.
  //     시작 → 프로필 → 저장 은 /profile 항목을 / 로 바꿔(replace) 뒤로가기가 /login 으로 가게 한다.
  //   ?room=CODE(초대)·?mock= 같은 쿼리는 화면을 옮겨도 그대로 따라간다.
  //   세션을 복원하는 중(localStorage 에 sb-…-auth-token 이 있거나 OAuth 복귀 URL)이면 결과가 나올 때까지 화면을 그리지 않는다(깜빡임 방지).
  // ------------------------------------------------------------------
  var STEPS = ['start', 'profile', 'room', 'me'];
  var CONFIRMED_KEY = 'drawguess.profileConfirmed'; // { [userId]: ts } — 이 브라우저에서 프로필 설정을 마친 로그인 사용자
  var landing = { step: null, invite: null, ready: false, authReady: false, readyTimer: null, nickEdited: false }; // nickEdited: 로그인 후 사용자가 닉네임을 직접 고쳤는가
  function cleanCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); }
  function nickValue() { var n = $('nick'); return (n ? n.value : profile.name).trim().slice(0, 12); }
  function updateNextBtn() { var b = $('btn-profile-next'); if (b) b.disabled = !nickValue() || photo.uploading; }
  function focusNode(n) { if (n) { try { n.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
  function authConfigured() {
    var c = window.APP_CONFIG;
    return !!(c && typeof c.supabaseUrl === 'string' && c.supabaseUrl && typeof c.supabaseAnonKey === 'string' && c.supabaseAnonKey);
  }
  /** 로그인 기능을 쓸 수 있는가(초기화 결과가 나오기 전에는 설정 유무로 짐작) */
  function loginAvailable() { return landing.authReady ? acct.on : authConfigured(); }
  /** 로그인 세션을 복원하는 중일 수 있는가: supabase-js 가 남긴 세션 키 또는 OAuth 복귀 파라미터 */
  function maybeRestoringSession() {
    if (!authConfigured()) return false;
    try {
      if (/(^#|&)(access_token|error)=/.test(location.hash || '') || new URLSearchParams(location.search).has('code')) return true;
      for (var i = 0; i < localStorage.length; i++) if (/^sb-.+-auth-token$/.test(localStorage.key(i) || '')) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  function confirmedMap() {
    try { var m = JSON.parse(localStorage.getItem(CONFIRMED_KEY) || '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch (e) { return {}; }
  }
  function isConfirmed(uid) { return !!(uid && confirmedMap()[uid]); }
  function forgetConfirmed(uid) {
    if (!uid) return;
    var m = confirmedMap(); delete m[uid];
    try { localStorage.setItem(CONFIRMED_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }
  function setConfirmed(uid) {
    if (!uid) return;
    var m = confirmedMap(); m[uid] = Date.now();
    try { localStorage.setItem(CONFIRMED_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
  }
  /** 지금 방에 들고 갈 아바타: { emoji, color, img? } — img 는 로그인 + 사진 모드 + 사진이 있을 때만 */
  function myAvatar() {
    var a = { emoji: profile.emoji, color: profile.color };
    if (acctLoggedIn() && photo.mode === 'photo' && avatarImgUrl(photo.url)) a.img = photo.url;
    return a;
  }
  /** parent 의 자식 순서를 nodes 순서로 맞춘다(이미 그 자리면 건드리지 않아 포커스 유지) */
  function orderChildren(parent, nodes) {
    if (!parent) return;
    nodes = nodes.filter(Boolean);
    for (var i = 0; i < nodes.length; i++) {
      var ref = parent.children[i] || null;
      if (ref !== nodes[i]) parent.insertBefore(nodes[i], ref);
    }
  }
  function renderLanding() {
    if (inRoom) return;
    STEPS.forEach(function (s) { var n = $('landing-step-' + s); if (n) n.hidden = landing.step !== s; });
    var ld = $('landing-loading'); if (ld) ld.hidden = !!landing.step;
    var lc = document.querySelector('.landing-card'); if (lc) lc.classList.toggle('is-wide', landing.step === 'me');
    updateNextBtn();
    renderMePage();
    var logged = acctLoggedIn();
    var sr = $('landing-step-room');
    paintAvatar($('me-avatar'), myAvatar());
    var nm = $('me-name'); if (nm) nm.textContent = nickValue() || '플레이어';
    var stt = $('me-status'); if (stt) stt.textContent = logged ? providerLabel(acct.user && acct.user.provider) + ' 계정' : '게스트';
    var ml = $('btn-me-login'); if (ml) ml.hidden = !(loginAvailable() && !logged);
    var ma = $('me-account'); if (ma) ma.hidden = !logged;
    // 참가가 우선: 코드 입력 + [참가하기](주 버튼) → 또는 → [+ 방 만들기](보조).
    // 초대받은 방: 코드 카드 안에 #btn-join("이 방에 참가하기")을 두고, "새 방 만들기"는 보조로 아래에
    var inv = landing.invite;
    var card = $('invite-card'), bc = $('btn-create'), bj = $('btn-join'), dv = $('join-divider'), jr = $('join-row'), dm = $('btn-invite-dismiss');
    var meCard = sr ? sr.querySelector('.me-card') : null, head = card ? card.querySelector('.invite-head') : null;
    if (inv) { orderChildren(card, [head, jr]); orderChildren(sr, [meCard, card, dv, bc, dm]); }
    else { orderChildren(sr, [meCard, card, jr, dv, bc, dm]); }
    if (card) card.hidden = !inv;
    var ic = $('invite-code'); if (ic) ic.textContent = inv || '';
    if (sr) sr.classList.toggle('is-invite', !!inv);
    if (bj) { bj.textContent = inv ? '이 방에 참가하기' : '참가하기'; bj.className = 'btn btn-lg btn-primary' + (inv ? ' btn-block' : ''); }
    if (bc) { bc.textContent = inv ? '새 방 만들기' : '방 만들기'; bc.className = 'btn btn-lg btn-block btn-outline btn-plus'; }
    var dt = $('join-divider-text'); if (dt) dt.textContent = '또는';
    if (dm) dm.hidden = !inv;
  }
  function showLandingStep(step, animate) {
    var prev = landing.step; landing.step = step;
    // 내 정보 화면이 보이는 동안 acct.open(단어 세트 목록을 그린다)
    acct.open = step === 'me';
    if (step !== 'me') { acct.formOpen = false; acct.editing = null; }
    else if (!acct.setsLoaded) refreshWordSets();
    renderProfile();
    renderLanding();
    if (step === 'me') renderAccountPanel();
    var node = $('landing-step-' + step);
    if (animate && prev && prev !== step && node) {
      node.classList.remove('step-fwd', 'step-back'); void node.offsetWidth;
      node.classList.add(STEPS.indexOf(step) > STEPS.indexOf(prev) ? 'step-fwd' : 'step-back');
    }
  }
  var ROUTES = { start: '/login', profile: '/profile', room: '/', me: '/me' };
  var GUEST_STARTED_KEY = 'drawguess.guestStarted'; // sessionStorage: 이 탭에서 게스트로 시작했는가
  function guestStarted() { try { return sessionStorage.getItem(GUEST_STARTED_KEY) === '1'; } catch (e) { return false; } }
  function setGuestStarted(v) { try { if (v) sessionStorage.setItem(GUEST_STARTED_KEY, '1'); else sessionStorage.removeItem(GUEST_STARTED_KEY); } catch (e) { /* ignore */ } }
  function stepFromPath(p) {
    p = String(p || '/').replace(/\/+$/, '') || '/';
    if (p === '/login') return 'start';
    if (p === '/profile') return 'profile';
    if (p === '/me') return 'me';
    return 'room';
  }
  /** 화면 주소 + 지금 쿼리(?room= · ?mock= 등). ?tab= 은 내 정보에서만 */
  function routeUrl(step) {
    var q = '';
    try {
      var qs = new URLSearchParams(location.search || '');
      if (step !== 'me') qs.delete('tab');
      q = qs.toString(); q = q ? '?' + q : '';
    } catch (e) { /* ignore */ }
    return ROUTES[step] + q;
  }
  /** 가려는 화면 → 지금 상태로 들어갈 수 있는 화면 */
  function resolveStep(step) {
    var logged = acctLoggedIn(), canLogin = loginAvailable();
    if (STEPS.indexOf(step) < 0) step = 'room';
    if (logged) {
      var ok = isConfirmed(acct.user.id) && !!nickValue();
      if (step === 'start') return ok ? 'room' : 'profile';
      if ((step === 'room' || step === 'me') && !ok) return 'profile';
      return step;
    }
    if (!guestStarted()) return canLogin ? 'start' : 'profile';
    if (step === 'me') step = canLogin ? 'start' : 'room'; // 내 정보는 로그인 사용자만
    if (step === 'start' && !canLogin) step = 'profile';
    if (step === 'room' && !nickValue()) return 'profile';
    return step;
  }
  /**
   * 랜딩 화면 이동(+주소). opts.mode: 'push'(기본) | 'replace'. opts.from: 이 화면을 끝내면 돌아갈 화면(returnTo 가 쓴다).
   * 들어갈 수 없는 화면이면 resolveStep 이 고른 화면으로. 실제로 보여 준 화면을 돌려준다
   */
  function goStep(step, animate, opts) {
    if (inRoom) return landing.step;
    opts = opts || {};
    step = resolveStep(step);
    showLandingStep(step, animate);
    var mode = opts.mode || 'push', from = opts.from;
    afterHistory(function () {
      if (inRoom || landing.step !== step) return;
      try {
        var st = { landing: step }; if (from) st.from = from;
        var cur = history.state, same = cur && cur.landing === step && stepFromPath(location.pathname) === step;
        if (mode === 'push' && !same) history.pushState(st, '', routeUrl(step));
        else history.replaceState(st, '', routeUrl(step));
      } catch (e) { /* file:// 등 */ }
    });
    if (animate && step === 'profile' && !mobileMq.matches) focusNode($('nick'));
    return step;
  }
  /** 화면을 끝내고 step 으로: 지금 항목이 step 에서 넘어온 것이면 뒤로 가서(스택 되돌림), 아니면 지금 항목을 step 으로 바꾼다 */
  function returnTo(step, animate) {
    if (inRoom) return landing.step;
    var st = history.state;
    step = resolveStep(step);
    if (st && st.landing && st.from === step) {
      showLandingStep(step, animate);
      histBack();
      afterHistory(function () {
        if (inRoom || landing.step !== step) return;
        try { if (stepFromPath(location.pathname) !== step || !history.state || history.state.landing !== step) history.replaceState({ landing: step }, '', routeUrl(step)); } catch (e) { /* ignore */ }
      });
      return step;
    }
    return goStep(step, animate, { mode: 'replace' });
  }
  /** 첫 화면을 정한다(한 번만). 주소가 가리키는 화면에서 시작한다. 방에 먼저 들어갔으면(재접속) 나올 때 resetToLanding 이 정한다 */
  function startLanding() {
    if (landing.ready) return;
    landing.ready = true;
    clearTimeout(landing.readyTimer); landing.readyTimer = null;
    if (inRoom) return;
    var want = stepFromPath(location.pathname), hs = history.state;
    var step = goStep(want, false, { mode: 'replace', from: hs && hs.landing === want ? hs.from : undefined });
    if (step === 'profile' && !mobileMq.matches) focusNode($('nick'));
  }
  /** 기기 뒤로가기/앞으로가기(시트와 무관한 popstate): 주소가 가리키는 화면으로(들어갈 수 없으면 대신 갈 화면으로 주소도 고친다) */
  function onLandingPopstate() {
    if (inRoom) {
      // 대기실·게임 중 뒤로가기: 방 항목을 다시 쌓고(방은 그대로) 나갈지 묻는다. 대화상자가 떠 있으면 뒤로가기 = 취소
      pushRoomEntry();
      if (leaveDialogOpen()) closeLeaveDialog(); else openLeaveDialog();
      return;
    }
    if (!landing.ready) return;
    var st = history.state;
    if (st && st.inRoom) { // 나간 방의 항목(앞으로가기 등): 방 주소를 지우고 메인으로 본다
      try { var rq = new URLSearchParams(location.search); rq.delete('room'); var rqs = rq.toString(); history.replaceState(null, '', location.pathname + (rqs ? '?' + rqs : '')); } catch (e) { /* ignore */ }
      st = null;
    }
    var want = st && st.landing ? st.landing : stepFromPath(location.pathname);
    var step = resolveStep(want);
    if (step !== want || stepFromPath(location.pathname) !== step || !(st && st.landing)) {
      try { var ns = { landing: step }; if (st && st.from && step === want) ns.from = st.from; history.replaceState(ns, '', routeUrl(step)); } catch (e) { /* ignore */ }
    }
    if (landing.step !== step) showLandingStep(step, true);
  }
  /** 프로필 설정 "저장": 닉네임·아바타 확정 → 저장(로그인 상태면 프로필에도, 이 브라우저에 확정 표시) → 방 단계 */
  function submitProfile() {
    var name = nickValue();
    if (!name) { toast('닉네임을 입력해주세요', 'error'); focusNode($('nick')); return; }
    if (photo.uploading) return;
    var n = $('nick'); if (n) n.value = name;
    profile.name = name; saveProfile();
    if (acctLoggedIn()) {
      if (photo.mode === 'photo' && !avatarImgUrl(photo.url)) photo.mode = 'emoji'; // 사진이 없으면 이모지로
      syncAccountProfile(true);
      setConfirmed(acct.user.id);
    } else setGuestStarted(true);
    if (roomProfile.open) { submitRoomProfile(name); return; }
    var hsp = history.state;
    if (hsp && hsp.from === 'me') { returnTo('me', true); return; }
    returnTo('room', true);
    // 키보드면 바로 이어서: 초대 → "이 방에 참가하기", 아니면 방 코드 입력(모바일은 키보드가 튀어나오지 않게 포커스하지 않는다)
    if (landing.invite) focusNode($('btn-join'));
    else if (!mobileMq.matches) focusNode($('room-code-input'));
  }
  function dismissInvite() {
    landing.invite = null;
    try {
      var qs = new URLSearchParams(location.search);
      if (qs.has('room')) { qs.delete('room'); var q = qs.toString(); history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '')); }
    } catch (e) { /* ignore */ }
    renderLanding();
    var c = $('room-code-input'); if (c) { focusNode(c); try { c.select(); } catch (e) { /* ignore */ } }
  }
  function setPhotoMode(mode) {
    if (!acctLoggedIn()) return;
    photo.mode = mode === 'photo' ? 'photo' : 'emoji';
    renderProfile(); renderLanding();
  }
  /** "사진 올리기": 파일 → (account.js) 정사각형 256px webp 로 줄여 Storage 업로드 → 공개 URL 을 지금 사진으로 */
  function onPhotoFile(e) {
    var input = e.target, file = input && input.files && input.files[0];
    if (input) input.value = ''; // 같은 파일을 다시 골라도 change 가 오게
    if (!file || !acctLoggedIn() || !Account) return;
    if (file.type && !/^image\//.test(file.type)) { toast('이미지 파일만 올릴 수 있어요', 'error'); return; }
    var uid = acct.user.id;
    photo.uploading = true; renderProfile(); updateNextBtn();
    Account.uploadAvatar(file)
      .then(function (url) {
        if (!acct.user || acct.user.id !== uid) return;
        photo.url = url; photo.mode = 'photo';
        toast('사진을 올렸어요', 'ok');
      })
      .catch(function (err) { acctErr(err, '사진을 올리지 못했어요'); })
      .then(function () { photo.uploading = false; renderProfile(); renderLanding(); });
  }
  function resetPhoto() {
    if (!photo.social) return;
    photo.url = photo.social; photo.mode = 'photo';
    renderProfile(); renderLanding();
  }

  function buildLanding() {
    var strip = $('emoji-strip');
    if (strip) EMOJIS.forEach(function (em) {
      var b = el('button', 'emoji-btn', em); b.type = 'button'; b.setAttribute('role', 'radio');
      b.addEventListener('click', function () { profile.emoji = em; saveProfile(); renderProfile(); renderLanding(); });
      strip.appendChild(b);
    });
    var row = $('color-row');
    if (row) AV_COLORS.forEach(function (c) {
      var b = el('button', 'color-btn'); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('data-color', c); b.style.background = c; b.title = c;
      b.addEventListener('click', function () { profile.color = c; saveProfile(); renderProfile(); renderLanding(); });
      row.appendChild(b);
    });
    var nick = $('nick');
    if (nick) {
      nick.value = profile.name;
      // 닉네임은 "저장"(또는 방 만들기/참가) 때 확정·저장한다 → 저장된 닉네임 유무로 첫 화면을 고른다
      nick.addEventListener('input', function () { landing.nickEdited = true; updateNextBtn(); });
      nick.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitProfile(); } });
    }
    var bn = $('btn-profile-next'); if (bn) bn.addEventListener('click', submitProfile);
    var bg = $('btn-start-guest'); if (bg) bg.addEventListener('click', function () { setGuestStarted(true); goStep('profile', true, { from: 'start' }); });
    var be = $('btn-profile-edit'); if (be) be.addEventListener('click', function () { goStep('profile', true, { from: 'room' }); });
    var mb = $('btn-me-back'); if (mb) mb.addEventListener('click', function () { returnTo('room', true); });
    var mpp = $('btn-mp-profile'); if (mpp) mpp.addEventListener('click', function () { goStep('profile', true, { from: 'me' }); });
    ['tab-sets', 'tab-gallery'].forEach(function (id) {
      var b = $(id); if (b) b.addEventListener('click', function () { setMeTab(b.getAttribute('data-tab')); });
    });
    var md = $('btn-mp-delete'); if (md) md.addEventListener('click', openDeleteDialog);
    var dc = $('btn-delete-cancel'); if (dc) dc.addEventListener('click', closeDeleteDialog);
    var dk = $('btn-delete-confirm'); if (dk) dk.addEventListener('click', doDeleteAccount);
    var dov = $('overlay-delete'); if (dov) dov.addEventListener('click', function (e) { if (e.target === dov) closeDeleteDialog(); });
    var bl = $('btn-me-login'); if (bl) bl.addEventListener('click', function () { goStep('start', true, { from: 'room' }); });
    ['btn-mode-photo', 'btn-mode-emoji'].forEach(function (id) {
      var b = $(id); if (b) b.addEventListener('click', function () { setPhotoMode(b.getAttribute('data-mode')); });
    });
    var pf = $('photo-file'); if (pf) pf.addEventListener('change', onPhotoFile);
    var pu = $('btn-photo-upload'); if (pu) pu.addEventListener('click', function () { if (pf && !photo.uploading) pf.click(); });
    var pr = $('btn-photo-reset'); if (pr) pr.addEventListener('click', resetPhoto);
    var bd = $('btn-invite-dismiss'); if (bd) bd.addEventListener('click', dismissInvite);
    STEPS.forEach(function (s) {
      var n = $('landing-step-' + s); if (n) n.addEventListener('animationend', function () { n.classList.remove('step-fwd', 'step-back'); });
    });
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

    // ?room=CODE → 초대받은 방. 없으면 OAuth 리다이렉트 전에 임시 저장해 둔 코드(redirectTo 에는 쿼리가 없다)
    var rc = '';
    try { rc = cleanCode(new URLSearchParams(location.search).get('room')); } catch (e) { /* ignore */ }
    try {
      var pendingRoom = sessionStorage.getItem(PENDING_ROOM_KEY);
      if (pendingRoom) { sessionStorage.removeItem(PENDING_ROOM_KEY); if (!rc) rc = cleanCode(pendingRoom); }
    } catch (e) { /* ignore */ }
    if (rc && codeIn) codeIn.value = rc;
    landing.invite = rc.length === 4 ? rc : null;
    renderProfile();

    // 첫 화면. 새로고침 전 남은 시트 항목(history.state.sheet)은 비운다(시트는 닫힌 채로 시작). 랜딩 항목의 from 은 이어 쓴다
    try { if (history.state && history.state.sheet) history.replaceState(null, ''); } catch (e) { /* ignore */ }
    installOAuthBackSkip();
    if (maybeRestoringSession()) {
      // 로그인 세션 복원 결과(initAccount)를 기다린다. 라이브러리 로드가 멈춰도 4초 뒤에는 게스트 기준으로 보여 준다
      renderLanding();
      landing.readyTimer = setTimeout(startLanding, 4000);
    } else startLanding();
  }
  function codeInput() { var n = $('room-code-input'); return n ? n.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) : ''; }
  function currentProfile() {
    var nick = $('nick');
    var name = (nick ? nick.value : profile.name).trim().slice(0, 12);
    return { name: name, avatar: myAvatar() };
  }
  function validName() {
    var p = currentProfile();
    if (!p.name) { toast('닉네임을 입력해주세요', 'error'); goStep('profile', true, { from: 'room' }); focusNode($('nick')); return null; }
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
    syncAccountProfile(false);
    p.token = getToken();
    withAck('room:create', p, function (ack) { setToken(ack.token); enterRoom(ack.roomCode, ack.playerId); });
  }
  function joinRoom() {
    var code = codeInput();
    if (code.length !== 4) { toast('방 코드는 영문 4글자예요', 'error'); var c = $('room-code-input'); if (c) c.focus(); return; }
    var p = validName(); if (!p) return;
    profile.name = p.name; saveProfile();
    syncAccountProfile(false);
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
    var sel = 'li[data-id="' + String(p.id).replace(/"/g, '') + '"] .avatar';
    var targets = [document.querySelector('#player-list ' + sel), document.querySelector('#sheet-player-list ' + sel)];
    // 모바일 게임 중에는 플레이어 목록이 숨겨져 있으므로 턴 띠 위에도 띄운다
    var strip = $('turn-strip'); if (strip && mobileMq.matches && state.phase !== 'lobby') targets.push(strip);
    targets.forEach(function (av) {
      if (!av) return;
      var pop = el('span', 'react-pop ' + (p.kind === 'down' ? 'down' : 'up'), p.kind === 'down' ? '👎' : '👍');
      if (av !== strip) pop.style.left = (30 + Math.round((Math.random() - 0.5) * 36)) + 'px';
      pop.style.setProperty('--rot', ((Math.random() - 0.5) * 30).toFixed(1) + 'deg');
      av.appendChild(pop);
      setTimeout(function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1000);
    });
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
    if (!acctLoggedIn()) setGuestStarted(true); // 방에 들어간 게스트는 이 탭에서 시작을 지난 것으로 본다
    // 메인 위에 방 항목(/?room=CODE)을 쌓는다 → 뒤로가기는 방 항목을 벗어나며 "나갈까요?"를 띄운다. 걷어내는 중인 항목이 있으면 그 뒤에
    afterHistory(pushRoomEntry);
    renderAll();
    var ci = $('chat-input'); if (ci && window.innerWidth >= 1100) ci.focus();
  }

  function resetToLanding(sendLeave) {
    if (sendLeave) emit('room:leave');
    inRoom = false;
    rejoinTarget = null;
    closeSheet(true);
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
    closeLeaveDialog();
    closeRoomProfile();
    // 방에서 나오면 메인. 방 항목을 걷어내고(→ 메인 항목), 주소에서 ?room= 을 뺀다
    landing.invite = null; landing.ready = true;
    afterHistory(function () { try { if (history.state && history.state.inRoom) histBack(); } catch (e) { /* ignore */ } });
    afterHistory(function () {
      if (inRoom) return;
      try {
        var qs = new URLSearchParams(location.search); qs.delete('room');
        var q = qs.toString();
        history.replaceState(history.state, '', location.pathname + (q ? '?' + q : ''));
      } catch (e) { /* ignore */ }
    });
    goStep('room', false, { mode: 'replace' });
    renderAll();
  }

  /** 방 항목: 지금 항목이 방 항목이면 주소만 맞추고, 아니면 위에 쌓는다 */
  function pushRoomEntry() {
    if (!inRoom || !state.roomCode) return;
    try {
      var qs = new URLSearchParams(location.search); qs.set('room', state.roomCode);
      var url = '/?' + qs.toString(), st = { inRoom: state.roomCode }, hs = history.state;
      if (hs && hs.inRoom) history.replaceState(st, '', url); else history.pushState(st, '', url);
    } catch (e) { /* file:// 등 */ }
  }
  // 뒤로가기로 방을 나가려 할 때 묻는 대화상자
  function leaveDialogOpen() { var d = $('overlay-leave'); return !!(d && !d.hidden); }
  var leaveIntent = null; // null = 방 나가기(메인) · 'me' = 방에서 나가 내 정보로
  function openLeaveDialog(intent) {
    var d = $('overlay-leave'); if (!d || !inRoom) return;
    leaveIntent = intent === 'me' ? 'me' : null;
    var game = state.phase !== 'lobby';
    var title = $('leave-title'), desc = $('leave-desc'), ok0 = $('btn-leave-confirm');
    if (leaveIntent === 'me') {
      if (title) title.textContent = '내 정보로 이동할까요?';
      if (desc) desc.textContent = '내 정보는 방 밖에서 볼 수 있어요. ' + (game ? '진행 중인 게임에서 빠지고 점수는 사라져요.' : '대기실에서 나가 내 정보로 이동해요.');
      if (ok0) ok0.textContent = '나가고 이동';
    } else {
      if (title) title.textContent = '방을 나갈까요?';
      if (desc) desc.textContent = game ? '진행 중인 게임에서 빠지고 메인 화면으로 돌아가요. 점수는 사라져요.' : '대기실에서 나가 메인 화면으로 돌아가요.';
      if (ok0) ok0.textContent = '나가기';
    }
    d.hidden = false;
    var ok = $('btn-leave-confirm'); if (ok) { try { ok.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function closeLeaveDialog() { var d = $('overlay-leave'); if (d) d.hidden = true; }

  // OAuth(카카오/Google) 복귀 뒤 뒤로가기가 카카오 로그인·동의 화면으로 가지 않게:
  //   로그인 버튼을 누를 때 history 길이(와 앞으로 항목 수)를 적어 두고, 돌아오면 지금 항목을 "바닥"으로 바꾸고 그 위에 같은 화면을 쌓는다.
  //   바닥으로 내려오면(popstate) 로그인 화면으로 오기 전 항목으로 한 번에 건너뛴다.
  var OAUTH_HIST_KEY = 'drawguess.oauthHist';
  function rememberHistoryForOAuth() {
    try {
      var fwd = 0, nav = window.navigation;
      if (nav && nav.currentEntry && typeof nav.entries === 'function') fwd = Math.max(0, nav.entries().length - 1 - nav.currentEntry.index);
      sessionStorage.setItem(OAUTH_HIST_KEY, JSON.stringify({ len: history.length, fwd: fwd, ts: Date.now() }));
    } catch (e) { /* ignore */ }
  }
  function forgetHistoryForOAuth() { try { sessionStorage.removeItem(OAUTH_HIST_KEY); } catch (e) { /* ignore */ } }
  function installOAuthBackSkip() {
    var raw = null;
    try { raw = sessionStorage.getItem(OAUTH_HIST_KEY); } catch (e) { return; }
    if (!raw) return;
    forgetHistoryForOAuth();
    var returned = false;
    try { returned = /(^#|&)(access_token|error)=/.test(location.hash || '') || /[?&](code|error)=/.test(location.search || ''); } catch (e) { /* ignore */ }
    if (!returned) return;
    try {
      var m = JSON.parse(raw);
      if (!m || typeof m.len !== 'number' || Date.now() - (m.ts || 0) > 30 * 60 * 1000) return;
      var at = m.len - 1 - (m.fwd || 0);           // 로그인 버튼을 누른 항목(/login)
      var target = Math.max(0, at - 1);            // 그 앞 = 로그인 화면으로 오기 전
      var d = target - (history.length - 1);       // 지금(복귀) 항목에서의 거리
      if (d >= 0) return;
      var url = location.pathname + location.search + location.hash;
      history.replaceState({ oauthBase: d }, '', url);
      history.pushState(null, '', url);
    } catch (e) { /* ignore */ }
  }

  function copyInvite() {
    if (!state.roomCode) return;
    var url = location.origin + '/?room=' + state.roomCode;
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
    if (g('set-drawTime')) s.drawTime = clamp(num(g('set-drawTime').value, 80), 15, 180);
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
    fillSelect('set-drawTime', [15, 20, 25].concat(range(30, 180, 10)), function (v) { return v + '초'; });
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
        state.settings = Object.assign({}, state.settings, MODE_PRESETS[mode] || {}, { mode: mode });
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
      if (state.players.length < minPlayers()) { toast('플레이어가 ' + minPlayers() + '명 이상이어야 시작할 수 있어요', 'error'); return; }
      emit('game:start');
    });
    var bc = $('btn-copy'); if (bc) bc.addEventListener('click', copyInvite);
    var bl = $('btn-leave'); if (bl) bl.addEventListener('click', function () { resetToLanding(true); });
    var bs = $('btn-sound'); if (bs) { renderSoundButton(bs); bs.addEventListener('click', function () { SFX.toggle(); renderSoundButton(bs); }); }
    var go = $('btn-gallery-open'); if (go) go.addEventListener('click', openGallery);
    var rd = $('btn-results-done'); if (rd) rd.addEventListener('click', function () {
      ui.resultsPending = false; ui.ranking = null; emit('results:done'); renderAll();
    });
    var gl = $('btn-gallery-lobby'); if (gl) gl.addEventListener('click', openGallery);
    var gc = $('btn-gallery-close'); if (gc) gc.addEventListener('click', closeGallery);
    var gs = $('btn-gallery-sheet'); if (gs) gs.addEventListener('click', function () {
      try { downloadDataUrl(gallerySheetPng(), safeFile('그림맞추기_' + (state.roomCode || '') + '_전체') + '.png'); }
      catch (e) { toast('이미지를 만들지 못했어요', 'error'); }
    });
    var gm = $('overlay-gallery'); if (gm) gm.addEventListener('click', function (e) { if (e.target === gm) closeGallery(); });
    var lc = $('btn-leave-cancel'); if (lc) lc.addEventListener('click', closeLeaveDialog);
    var lo = $('btn-leave-confirm'); if (lo) lo.addEventListener('click', function () {
      var intent = leaveIntent;
      closeLeaveDialog();
      if (!inRoom) return;
      resetToLanding(true);
      if (intent === 'me') goStep('me', true, { from: 'room' });
    });
    var rpb = $('btn-room-profile'); if (rpb) rpb.addEventListener('click', function () { closeSheet(true); openRoomProfile(); });
    var rpc = $('btn-room-profile-close'); if (rpc) rpc.addEventListener('click', function () { closeRoomProfile(); });
    var rpo = $('overlay-profile'); if (rpo) rpo.addEventListener('click', function (e) { if (e.target === rpo) closeRoomProfile(); });
    var ld = $('overlay-leave'); if (ld) ld.addEventListener('click', function (e) { if (e.target === ld) closeLeaveDialog(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (leaveDialogOpen()) { closeLeaveDialog(); return; }
      var dd = $('overlay-delete'); if (dd && !dd.hidden) { closeDeleteDialog(); return; }
      if (openSheetId) { closeSheet(false); return; }
      if (roomProfile.open) { closeRoomProfile(); return; }
      if (ui.galleryOpen) closeGallery();
    });
    buildMobileChrome();

    var plist = $('player-list'); if (plist) plist.addEventListener('scroll', updatePlayerStripFade, { passive: true });
    window.addEventListener('resize', updatePlayerStripFade);

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
  // Mobile chrome (≤767px) — 바텀 시트 · 노드 재배치 · visualViewport 추적 · 채팅 티커/말풍선
  //   데스크톱/태블릿에서는 아무 노드도 옮기지 않고 시트도 열리지 않는다(CSS 가 모바일 전용 요소를 display:none 처리).
  // ------------------------------------------------------------------
  var mobileMq = window.matchMedia ? window.matchMedia('(max-width: 767px)') : { matches: false, addEventListener: null, addListener: null };
  var COMPACT_MAX_H = 520; // visualViewport 높이가 이보다 짧으면(키보드) 컴팩트 모드
  var openSheetId = null, sheetTimer = null, tickerTimer = null, lastCompact = false;

  /** node 를 parent 안(before 앞, 없으면 끝)으로 옮긴다. 이미 그 자리면 건드리지 않는다(포커스 유지). */
  function placeNode(node, parent, before) {
    if (!node || !parent) return;
    if (node.parentNode === parent && (before ? node.nextElementSibling === before : node.nextElementSibling === null)) return;
    if (before && before.parentNode === parent) parent.insertBefore(node, before); else parent.appendChild(node);
  }
  /**
   * 브레이크포인트/단계/역할에 맞게 헤더 노드와 채팅 펼치기 버튼을 옮긴다.
   *  - 모바일: 효과음·나가기는 항상 메뉴 시트. 방 코드·초대 링크는 게임 중에만 메뉴 시트(대기실에서는 헤더에 남겨 공유하기 쉽게).
   *  - 모바일 게임 중 관전자: #btn-chat-expand 를 상태 띠(#draw-status)로. 그 외에는 채팅 바(#chat-bar).
   *  - 데스크톱: 모두 원래 자리로, 열린 시트는 닫는다.
   */
  function placeMobileChrome() {
    var mobile = mobileMq.matches, game = state.phase !== 'lobby';
    var chip = document.querySelector('.room-code-chip');
    var copy = $('btn-copy'), sound = $('btn-sound'), leave = $('btn-leave'), menu = $('btn-menu');
    var left = document.querySelector('.topbar-left'), right = document.querySelector('.topbar-right');
    if (mobile && game) { placeNode(chip, $('menu-slot-code')); placeNode(copy, $('menu-slot-copy')); }
    else { placeNode(chip, left, copy && copy.parentNode === left ? copy : null); placeNode(copy, left); }
    if (mobile) { placeNode(sound, $('menu-slot-sound')); placeNode(leave, $('menu-slot-leave')); }
    else { placeNode(sound, right, leave && leave.parentNode === right ? leave : menu); placeNode(leave, right, menu); }
    var profBtn = $('btn-room-profile');
    if (mobile) placeNode(profBtn, $('menu-slot-profile'));
    else placeNode(profBtn, right, sound && sound.parentNode === right ? sound : (leave && leave.parentNode === right ? leave : menu));
    var acctBtn = $('btn-account-top');
    if (mobile) placeNode(acctBtn, $('menu-slot-account'));
    else placeNode(acctBtn, right, sound && sound.parentNode === right ? sound : (leave && leave.parentNode === right ? leave : menu));
    var expand = $('btn-chat-expand');
    if (mobile && game && !isDrawer()) placeNode(expand, $('draw-status')); else placeNode(expand, $('chat-bar'));
    if (!mobile && openSheetId) closeSheet(true);
    // 게임 셸(position:fixed)이 떠 있는 동안 문서 자체는 스크롤/바운스되지 않게 (iOS 주소창·키보드 대응)
    document.body.classList.toggle('game-shell', mobile && game && inRoom);
  }

  /** #chat-list / #chat-form 을 컨테이너(채팅 시트 본문 또는 채팅 패널)로 옮긴다 */
  function moveChatInto(container) {
    if (!container) return;
    placeNode($('chat-list'), container); placeNode($('chat-form'), container);
  }

  // 기기 뒤로가기로 시트 닫기: 열 때 history 항목을 하나 넣고, popstate 가 오면 닫는다.
  // UI(✕·배경·드래그·ESC)로 닫을 때는 우리가 넣은 항목을 history.back() 으로 걷어내며, 그때 오는 popstate 는 무시한다.
  // 랜딩 단계 항목도 같은 방식(histBack). history.back() 은 비동기라, 그 사이의 replaceState/pushState 는 afterHistory 로 미룬다.
  var histGuard = 0, histQueue = [], histTimer = null;
  function flushHistQueue() {
    clearTimeout(histTimer); histTimer = null;
    // 실행한 fn 이 다시 histBack 을 부르면(histGuard > 0) 나머지는 그 popstate 뒤에 이어서 실행한다
    while (histQueue.length && !histGuard) {
      var fn = histQueue.shift();
      try { fn(); } catch (e) { console.error('[history]', e); }
    }
  }
  /** 우리가 넣은 항목 n개(기본 1)를 걷어낸다. 그 결과로 오는 popstate(한 번)는 무시한다 */
  function histBack(n) {
    n = Math.max(1, n || 1);
    histGuard++;
    clearTimeout(histTimer);
    histTimer = setTimeout(function () { if (histGuard) { histGuard = 0; flushHistQueue(); } }, 800); // popstate 가 오지 않는 경우 대비
    try { if (n > 1) history.go(-n); else history.back(); } catch (e) { histGuard = Math.max(0, histGuard - 1); if (!histGuard) flushHistQueue(); }
  }
  /** 걷어내는 중인 항목이 있으면 그 popstate 뒤에, 없으면 바로 fn 을 실행한다 */
  function afterHistory(fn) { if (histGuard) histQueue.push(fn); else fn(); }
  function sheetHistoryPush(id) {
    try {
      if (history.state && history.state.sheet) history.replaceState({ sheet: id }, '');
      else history.pushState({ sheet: id }, '');
    } catch (e) { /* ignore */ }
  }
  function sheetHistoryPop() {
    try {
      if (history.state && history.state.sheet) histBack();
    } catch (e) { /* ignore */ }
  }
  window.addEventListener('popstate', function () {
    if (histGuard) { histGuard--; if (!histGuard) flushHistQueue(); return; }
    var hs = history.state;
    if (hs && typeof hs.oauthBase === 'number') { try { history.go(hs.oauthBase); } catch (e) { /* ignore */ } return; } // 카카오/Google 화면을 건너뛴다
    if (openSheetId) { closeSheet(false, true); return; }
    onLandingPopstate();
  });

  function openSheet(id) {
    if (!mobileMq.matches) return;
    var s = $(id); if (!s) return;
    if (openSheetId && openSheetId !== id) closeSheet(true, true);
    if (sheetTimer) { clearTimeout(sheetTimer); sheetTimer = null; }
    openSheetId = id;
    sheetHistoryPush(id);
    var panel0 = s.querySelector('.sheet-panel'); if (panel0) { panel0.style.transform = ''; panel0.classList.remove('dragging'); }
    if (id === 'sheet-chat') moveChatInto($('sheet-chat-body'));
    s.hidden = false;
    document.body.classList.add('sheet-open');
    if (id === 'sheet-players') renderPlayers();
    requestAnimationFrame(function () { s.classList.add('open'); });
    if (id === 'sheet-chat') { scrollChatBottom(); setTimeout(scrollChatBottom, 250); }
    var cb = s.querySelector('.sheet-close');
    if (cb) { try { cb.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function closeSheet(immediate, fromHistory) {
    var id = openSheetId; if (!id) return;
    var s = $(id); openSheetId = null;
    if (id === 'sheet-profile' && roomProfile.open) closeRoomProfile(true);
    document.body.classList.remove('sheet-open');
    if (!fromHistory) sheetHistoryPop();
    if (!s) return;
    var panel = s.querySelector('.sheet-panel');
    if (panel) { panel.classList.remove('dragging'); panel.style.transform = ''; }
    s.classList.remove('open');
    var done = function () {
      sheetTimer = null; s.hidden = true;
      if (id === 'sheet-chat') { moveChatInto($('chat-panel')); scrollChatBottom(); }
      if (id === 'sheet-players') { var sl = $('sheet-player-list'); if (sl) sl.innerHTML = ''; }
    };
    if (immediate) done(); else sheetTimer = setTimeout(done, 220);
  }

  /**
   * 시트를 아래로 끌어 닫기. 손잡이·머리는 어디서든, 본문은 맨 위(scrollTop 0)에서 아래로 끌 때만 잡는다.
   * 90px 이상 내리거나 빠르게 튕기면 닫고, 아니면 제자리로.
   */
  function bindSheetDrag(panel) {
    var handle = panel.querySelector('.sheet-handle'), head = panel.querySelector('.sheet-head'), body = panel.querySelector('.sheet-body');
    var startY = 0, lastY = 0, lastT = 0, dy = 0, active = false, fromBody = false;
    /** e.target 에서 panel 까지 올라가며 실제로 스크롤되는 요소를 찾는다 (채팅 시트는 #chat-list 가 스크롤러) */
    function scrollerAt(target) {
      var n = target;
      while (n && n !== panel) {
        if (n.nodeType === 1) {
          var oy = getComputedStyle(n).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return n;
        }
        n = n.parentNode;
      }
      return null;
    }
    function onDown(e) {
      if (!openSheetId || e.button > 0) return;
      fromBody = !!(body && body.contains(e.target));
      if (fromBody) {
        var sc = scrollerAt(e.target);
        if (sc && sc.scrollTop > 0) return; // 아직 위로 볼 내용이 남아 있으면 스크롤에 맡긴다 (맨 위까지 올린 뒤 끌면 닫힘)
      }
      if (e.target.closest && e.target.closest('button, input, textarea, select, a')) return;
      active = true; dy = 0; startY = lastY = e.clientY; lastT = e.timeStamp;
      try { panel.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      panel.classList.add('dragging');
    }
    function onMove(e) {
      if (!active) return;
      var d = e.clientY - startY;
      if (fromBody && d < 0) { cancel(); return; } // 본문에서 위로 = 스크롤 의도
      dy = Math.max(0, d); lastY = e.clientY; lastT = e.timeStamp;
      panel.style.transform = 'translateY(' + dy + 'px)';
      if (dy > 0 && e.cancelable) e.preventDefault();
    }
    function onUp(e) {
      if (!active) return;
      active = false;
      var dt = Math.max(1, e.timeStamp - lastT), v = (e.clientY - lastY) / dt; // px/ms (아래 방향 +)
      panel.classList.remove('dragging');
      if (dy > 90 || (dy > 24 && v > 0.5)) { closeSheet(false); return; }
      panel.style.transform = '';
    }
    function cancel() { active = false; panel.classList.remove('dragging'); panel.style.transform = ''; }
    [handle, head, body].forEach(function (el) { if (el) el.addEventListener('pointerdown', onDown); });
    panel.addEventListener('pointermove', onMove);
    panel.addEventListener('pointerup', onUp);
    panel.addEventListener('pointercancel', cancel);
    // 본문에서 아래로 끌 때 브라우저의 당겨서-새로고침/스크롤을 막는다
    if (body) body.addEventListener('touchmove', function (e) { if (active && dy > 0 && e.cancelable) e.preventDefault(); }, { passive: false });
  }

  /** --vvh/--vvt(visualViewport) 갱신 + 컴팩트 모드 판정 */
  function updateViewportVars() {
    var vv = window.visualViewport;
    var h = vv && vv.height ? vv.height : window.innerHeight;
    var top = vv && vv.offsetTop ? vv.offsetTop : 0;
    var rs = document.documentElement.style;
    rs.setProperty('--vvh', Math.round(h) + 'px');
    rs.setProperty('--vvt', Math.round(top) + 'px');
    var compact = mobileMq.matches && h < COMPACT_MAX_H;
    var vr = $('view-room');
    if (vr) { if (compact) vr.setAttribute('data-compact', '1'); else vr.removeAttribute('data-compact'); }
    if (compact !== lastCompact) { lastCompact = compact; if (!compact) setTimeout(scrollChatBottom, 0); renderChatPeek(false); }
    fitDrawerCanvas();
  }

  /**
   * 출제자(모바일): 툴바를 화면 하단에 두고 캔버스는 그 위 남는 높이에 4:3 최대 크기로 맞춘다.
   * room-grid 높이에서 턴 띠 카드·채팅 버블 카드 최소 높이·패널 패딩·툴바·간격을 뺀 것이 캔버스 최대 높이
   * → 너비 = min(패널 너비, 높이 × 4/3). 결과를 --dw 로 넘긴다. (채팅 카드는 남는 높이를 flex 로 채운다)
   */
  function fitDrawerCanvas() {
    var vr = $('view-room'), cp = document.querySelector('.center-panel'), cw = $('canvas-wrap'), tb = $('toolbar');
    if (!vr || !cp || !cw) return;
    var on = mobileMq.matches && state.phase !== 'lobby' && isDrawer();
    if (!on) { cw.style.removeProperty('--dw'); return; }
    var cs = getComputedStyle(cp);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var gap = parseFloat(cs.rowGap || cs.gap) || 8;
    var innerW = cp.clientWidth - padX;
    var grid = cp.parentElement, gs = grid ? getComputedStyle(grid) : null;
    var gridGap = gs ? (parseFloat(gs.rowGap || gs.gap) || 8) : 8;
    var players = grid ? grid.querySelector('.players-panel') : null;
    var dc = $('drawer-chat');
    var dcH = dc && dc.offsetParent ? dc.offsetHeight : 44; // 채팅 버블 카드는 내용 크기(핏) — 실제 높이를 뺀다
    var gridH = grid ? grid.clientHeight : cp.clientHeight;
    var availH = gridH - (players ? players.offsetHeight + gridGap : 0) - (dcH + gridGap) - padY - (tb && !tb.hidden ? tb.offsetHeight + gap : 0);
    if (innerW <= 0 || availH <= 0) return;
    var w = Math.max(120, Math.min(innerW, Math.floor(availH * 4 / 3)));
    cw.style.setProperty('--dw', w + 'px');
  }

  /** 채팅 요약: 접힌 채팅 바(마지막 메시지) · 출제자 티커(최신 1개) · 컴팩트 말풍선(최근 3개). fresh=true 면 티커를 4초간 진하게 */
  function summarize(m) { return (m.kind === 'chat' || m.kind === 'guessed-chat') && m.name ? m.name + ': ' + m.text : m.text; }
  function kindClass(kind) { return kind === 'correct' ? 'kind-correct' : kind === 'close' ? 'kind-close' : kind === 'system' ? 'kind-system' : kind === 'guessed-chat' ? 'kind-guessed' : 'kind-chat'; }
  function renderChatPeek(fresh) {
    var recent = ui.recentChat, last = recent[recent.length - 1];
    var bar = $('chat-bar-last'); if (bar) bar.textContent = last ? summarize(last) : '아직 채팅이 없어요';
    var tk = $('chat-ticker');
    if (tk) {
      tk.className = 'chat-ticker ' + (last ? kindClass(last.kind) : 'kind-system') + (tk.classList.contains('fresh') ? ' fresh' : '');
      tk.innerHTML = '';
      tk.appendChild(el('span', 'tk-icon', last ? (last.kind === 'correct' ? '🎉' : last.kind === 'close' ? '🔥' : last.kind === 'guessed-chat' ? '🔒' : '💬') : '💬'));
      var tt = el('span', 'tk-text');
      if (last && (last.kind === 'chat' || last.kind === 'guessed-chat') && last.name) { tt.appendChild(el('span', 'tk-name', last.name)); tt.appendChild(document.createTextNode(last.text)); }
      else tt.textContent = last ? last.text : '채팅 열기';
      tk.appendChild(tt);
      if (fresh && last) {
        tk.classList.add('fresh');
        if (tickerTimer) clearTimeout(tickerTimer);
        tickerTimer = setTimeout(function () { tickerTimer = null; tk.classList.remove('fresh'); }, 4000);
      }
    }
    var dc = $('drawer-chat');
    if (dc) {
      requestAnimationFrame(fitDrawerCanvas); // 버블 수가 바뀌면 카드 높이가 바뀌므로 캔버스 크기 재계산
      dc.innerHTML = '';
      if (mobileMq.matches) {
        if (!recent.length) dc.appendChild(el('span', 'dc-empty', '💬 채팅 열기 ›'));
        recent.forEach(function (m) {
          var b = el('div', 'chat-bubble ' + kindClass(m.kind) + (m.mine ? ' mine' : ''));
          if ((m.kind === 'chat' || m.kind === 'guessed-chat') && m.name) b.appendChild(el('span', 'bb-name', m.name));
          b.appendChild(document.createTextNode(m.text));
          dc.appendChild(b);
        });
      }
    }
    var bb = $('chat-bubbles');
    if (bb) {
      bb.innerHTML = '';
      if (mobileMq.matches) recent.forEach(function (m) {
        var b = el('div', 'chat-bubble ' + kindClass(m.kind) + (m.mine ? ' mine' : ''));
        if ((m.kind === 'chat' || m.kind === 'guessed-chat') && m.name) b.appendChild(el('span', 'bb-name', m.name));
        b.appendChild(document.createTextNode(m.text));
        bb.appendChild(b);
      });
    }
  }

  function buildMobileChrome() {
    var bm = $('btn-menu'); if (bm) bm.addEventListener('click', function () { openSheet('sheet-menu'); });
    var ts = $('turn-strip'); if (ts) ts.addEventListener('click', function () { openSheet('sheet-players'); });
    var tk = $('chat-ticker'); if (tk) tk.addEventListener('click', function () { openSheet('sheet-chat'); });
    var dc = $('drawer-chat'); if (dc) dc.addEventListener('click', function () { openSheet('sheet-chat'); });
    var ce = $('btn-chat-expand'); if (ce) ce.addEventListener('click', function () { openSheet('sheet-chat'); });
    // 대기실(모바일) 미니 채팅: 목록/입력창을 터치하면 시트로 (입력창은 키보드가 먼저 뜨지 않게 pointerdown 을 가로챈다)
    var inLobbyMini = function (node) { return mobileMq.matches && state.phase === 'lobby' && !openSheetId && node && $('chat-panel') && $('chat-panel').contains(node); };
    var cl = $('chat-list'); if (cl) cl.addEventListener('click', function () { if (inLobbyMini(cl)) openSheet('sheet-chat'); });
    var cin = $('chat-input');
    if (cin) {
      var openFromInput = function (e) {
        if (!inLobbyMini(cin)) return;
        if (e && e.cancelable) e.preventDefault();
        openSheet('sheet-chat');
        setTimeout(function () { var i = $('chat-input'); if (i) { try { i.focus({ preventScroll: true }); } catch (err) { /* ignore */ } } }, 260);
      };
      cin.addEventListener('pointerdown', openFromInput);
      cin.addEventListener('focus', function (e) { if (inLobbyMini(cin)) { cin.blur(); openFromInput(e); } });
    }
    document.querySelectorAll('.sheet [data-sheet-close]').forEach(function (n) { n.addEventListener('click', function () { closeSheet(false); }); });
    document.querySelectorAll('.sheet .sheet-panel').forEach(bindSheetDrag);
    // 메뉴 시트에서 나가기/초대 복사를 누르면 시트를 닫는다
    var bl = $('btn-leave'); if (bl) bl.addEventListener('click', function () { closeSheet(true); });
    var bc = $('btn-copy'); if (bc) bc.addEventListener('click', function () { if (openSheetId === 'sheet-menu') closeSheet(false); });
    var onMq = function () { placeMobileChrome(); updateViewportVars(); renderChatPeek(false); };
    if (mobileMq.addEventListener) mobileMq.addEventListener('change', onMq); else if (mobileMq.addListener) mobileMq.addListener(onMq);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportVars);
      window.visualViewport.addEventListener('scroll', updateViewportVars);
    }
    window.addEventListener('resize', updateViewportVars);
    if (window.ResizeObserver) { var cpEl = document.querySelector('.center-panel'); if (cpEl) new ResizeObserver(function () { fitDrawerCanvas(); }).observe(cpEl); }
    window.addEventListener('orientationchange', function () { setTimeout(updateViewportVars, 60); });
    updateViewportVars();
    placeMobileChrome();
  }

  // ------------------------------------------------------------------
  // 계정 — 로그인 · 내 정보(프로필 / 단어 세트) UI. 세션·DB 호출은 account.js(window.Account)가 맡는다.
  //   로그인 기능이 꺼져 있으면(APP_CONFIG 비어 있음) 관련 DOM 은 전부 hidden 으로 남고 아무 것도 하지 않는다.
  //   토큰 계약: 접속 시 io({ auth: { token } }), 로그인/로그아웃/토큰 갱신 시 'auth:token' { token | null }.
  // ------------------------------------------------------------------
  var Account = window.Account || null;
  var ACCT_MAX_SETS = (Account && Account.MAX_SETS) || 20, ACCT_MAX_WORDS = (Account && Account.MAX_WORDS) || 500;
  var PENDING_ROOM_KEY = 'drawguess.pendingRoom'; // OAuth 리다이렉트 전에 입력해 둔 방 코드(돌아오면 다시 채운다)
  var acct = {
    on: false, user: null, profile: null, sets: [], setsLoaded: false, loadingSets: false,
    open: false, formOpen: false, editing: null,
    lastToken: null, lastUid: null, appliedKey: ''
  };
  function acctLoggedIn() { return !!(acct.on && acct.user); }
  function acctToken() { return Account && typeof Account.getToken === 'function' ? Account.getToken() : null; }
  function acctName() { return (acct.profile && acct.profile.nickname) || (acct.user && acct.user.name) || '플레이어'; }
  function providerLabel(p) { return p === 'google' ? 'Google' : p === 'kakao' ? '카카오' : (p ? String(p) : '소셜'); }
  function acctErr(e, fallback) { toast(e && e.message ? e.message : fallback, 'error'); }
  function canApplySet() { return inRoom && isHost() && state.phase === 'lobby'; }
  function parseWords(text) {
    if (Account && typeof Account.parseWords === 'function') return Account.parseWords(text);
    var words = String(text || '').split(',').map(function (w) { return w.trim().replace(/\s+/g, ' '); }).filter(Boolean);
    return { words: words, invalid: [] };
  }
  function fmtDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || isNaN(d.getTime())) return '';
    var md = (d.getMonth() + 1) + '/' + d.getDate();
    return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '.' + md;
  }

  function initAccount() {
    if (!Account || typeof Account.init !== 'function') return;
    Account.onChange(onAccountChange);
    Account.init().then(function (ok) {
      if (!ok && window.APP_CONFIG && window.APP_CONFIG.supabaseUrl) toast('로그인 기능을 불러오지 못했어요. 게스트로 계속할 수 있어요', 'error');
      landing.authReady = true;
      if (!landing.ready) startLanding();                                              // 세션 복원 결과로 첫 화면을 정한다
      else if (!inRoom && landing.step === 'start' && !loginAvailable()) goStep('profile', false, { mode: 'replace' }); // 로그인을 못 켰으면 시작 화면을 건너뛴다
      renderAccount();
    });
  }
  function onAccountChange(snap) {
    acct.on = !!(snap && snap.enabled);
    acct.user = snap && snap.user ? snap.user : null;
    acct.profile = snap && snap.profile ? snap.profile : null;
    var uid = acct.user ? acct.user.id : null;
    var token = snap && snap.token ? snap.token : null;
    var loginChanged = false;
    if (uid !== acct.lastUid) {
      acct.lastUid = uid; acct.sets = []; acct.setsLoaded = false; acct.formOpen = false; acct.editing = null; acct.appliedKey = '';
      photo.mode = 'emoji'; photo.url = null; photo.social = null; photo.uploading = false; landing.nickEdited = false;
      if (!uid && acct.open) closeAccount();
      if (uid) refreshWordSets();
      loginChanged = true;
    }
    if (token !== acct.lastToken) {
      acct.lastToken = token;
      if (socket) {
        try { socket.auth = { token: token || undefined }; } catch (e) { /* ignore */ } // 재접속 핸드셰이크에도 실린다
        if (socket.connected) emit('auth:token', { token: token });
      }
    }
    applyProfileToLanding();
    // 로그인/로그아웃(첫 화면을 정한 뒤, 방 밖): 로그인 → 이 브라우저에서 확정한 적 있으면 메인(메인에서 왔으면 뒤로), 처음이면 프로필 설정
    //   (/login 항목을 바꾼다. 메인에서 왔으면 저장 뒤 메인으로 돌아가게 from 을 넘긴다) / 로그아웃 → 시작(지금 항목을 바꾼다)
    if (uid && loginChanged) forgetHistoryForOAuth(); // 이 문서 안에서 로그인됨(리다이렉트 없음) → 적어 둔 길이는 쓰지 않는다
    if (loginChanged && landing.ready && !inRoom) {
      if (uid) {
        if (isConfirmed(uid) && nickValue()) returnTo('room', true);
        else { var hs0 = history.state; goStep('profile', true, { mode: 'replace', from: hs0 && hs0.from === 'room' ? 'room' : undefined }); }
      } else {
        setGuestStarted(false);
        goStep('start', true, { mode: 'replace' });
      }
    }
    renderAccount();
  }
  /**
   * 로그인 프로필(닉네임·아바타·사진)을 프로필 설정에 채운다. 사용자가 닉네임을 입력 중이면 그 값은 건드리지 않는다.
   * 프로필 행이 아직 없으면 소셜 사진(user metadata)으로 먼저 채운다.
   * 사진: 기본(소셜) = social_avatar_url → user metadata 사진 / 지금 사진 = avatar_url → 기본 사진 / 모드 = avatar_mode(사진이 없으면 emoji)
   */
  function applyProfileToLanding() {
    if (!acctLoggedIn()) return;
    var pr = acct.profile, u = acct.user;
    var key = pr ? ['p', pr.user_id, pr.nickname, pr.avatar_emoji || '', pr.avatar_color || '', pr.avatar_mode || '', pr.avatar_url || '', pr.social_avatar_url || ''].join('|') : 'u|' + u.id;
    if (acct.appliedKey === key || (!pr && acct.appliedKey)) return;
    acct.appliedKey = key;
    photo.social = (pr && pr.social_avatar_url) || u.avatarUrl || null;
    photo.url = (pr && pr.avatar_url) || photo.social;
    photo.mode = pr && pr.avatar_mode === 'emoji' ? 'emoji' : (photo.url ? 'photo' : 'emoji');
    // 프로필 행이 오기 전(새로고침 직후)에는 지난번에 본 사진 상태를 먼저 쓴다 → 소셜 사진이 잠깐 비쳤다 바뀌는 깜빡임 방지
    var PHOTO_CACHE_KEY = 'drawguess.photoCache';
    if (pr) {
      try { localStorage.setItem(PHOTO_CACHE_KEY, JSON.stringify({ uid: u.id, mode: photo.mode, url: photo.url })); } catch (e) { /* ignore */ }
    } else {
      try {
        var pc = JSON.parse(localStorage.getItem(PHOTO_CACHE_KEY) || 'null');
        if (pc && pc.uid === u.id) {
          photo.mode = pc.mode === 'photo' ? 'photo' : 'emoji';
          if (pc.url && avatarImgUrl(pc.url)) photo.url = pc.url;
          if (photo.mode === 'photo' && !avatarImgUrl(photo.url)) photo.mode = 'emoji';
        }
      } catch (e) { /* ignore */ }
    }
    if (pr) {
      var nick = $('nick');
      if (pr.nickname) {
        profile.name = String(pr.nickname).slice(0, 12);
        if (nick && !(landing.nickEdited && document.activeElement === nick && nick.value.trim())) nick.value = profile.name;
      }
      if (EMOJIS.indexOf(pr.avatar_emoji) !== -1) profile.emoji = pr.avatar_emoji;
      if (AV_COLORS.indexOf(pr.avatar_color) !== -1) profile.color = pr.avatar_color;
      saveProfile();
    }
    renderProfile();
  }
  /**
   * 지금 프로필 설정(닉네임 · 사진/이모지 모드 · 사진 · 얼굴 · 색상)을 로그인 프로필에 저장한다. 바뀐 칸만 보낸다.
   * 프로필 행을 아직 못 받았으면 보내지 않는다(모르는 값으로 덮어쓰지 않게). loud=true 면 실패를 토스트로 알린다.
   */
  function syncAccountProfile(loud) {
    if (!acctLoggedIn() || !acct.profile || !Account) return;
    var pr = acct.profile;
    var want = {
      nickname: profile.name,
      avatar_mode: photo.mode === 'photo' && avatarImgUrl(photo.url) ? 'photo' : 'emoji',
      avatar_url: photo.url || null,
      avatar_emoji: profile.emoji,
      avatar_color: profile.color
    };
    var patch = {};
    Object.keys(want).forEach(function (k) {
      if (k === 'nickname' && !want[k]) return;
      if ((want[k] || null) !== (pr[k] || null)) patch[k] = want[k];
    });
    if (!Object.keys(patch).length) return;
    Account.updateProfile(patch).catch(function (e) {
      console.warn('[account] profile sync failed:', e && e.message);
      if (loud) acctErr(e, '프로필을 저장하지 못했어요');
    });
  }


  function renderAccount() {
    var logged = acctLoggedIn();
    renderProfile();
    renderLanding();
    var top = $('btn-account-top'); if (top) top.hidden = !logged;
    var slot = $('menu-slot-account'); if (slot) slot.hidden = !logged;
    // 대기실 설정: 내 세트 불러오기 / 현재 단어를 세트로 저장
    var tools = $('wordset-tools'); if (tools) tools.hidden = !logged;
    var sel = $('wordset-load');
    if (sel) {
      sel.hidden = !acct.sets.length;
      var key = acct.sets.map(function (s) { return s.id + ':' + s.name + ':' + s.words.length; }).join('|');
      if (sel.getAttribute('data-key') !== key) {
        sel.setAttribute('data-key', key); sel.innerHTML = '';
        var o0 = el('option', null, '내 세트 불러오기…'); o0.value = ''; sel.appendChild(o0);
        acct.sets.forEach(function (s) { var o = el('option', null, s.name + ' (' + s.words.length + '개)'); o.value = String(s.id); sel.appendChild(o); });
      }
      sel.disabled = !canApplySet();
    }
    if (acct.open) renderAccountPanel();
    renderMePage();
  }

  /** 내 정보(/me) 열기. 방 안이면 "방에서 나가고 이동할까요?"를 먼저 묻는다 */
  function openAccount() {
    if (!acctLoggedIn()) return;
    if (inRoom) { closeSheet(true); openLeaveDialog('me'); return; }
    goStep('me', true, { from: 'room' });
  }
  /** 단어 세트 편집 폼 닫기(내 정보 화면 자체는 주소로 오간다) */
  function closeAccount() { acct.formOpen = false; acct.editing = null; renderAccountPanel(); }
  function meTab() { try { return new URLSearchParams(location.search).get('tab') === 'gallery' ? 'gallery' : 'sets'; } catch (e) { return 'sets'; } }
  function setMeTab(tab) {
    try {
      var qs = new URLSearchParams(location.search);
      if (tab === 'gallery') qs.set('tab', 'gallery'); else qs.delete('tab');
      var q = qs.toString();
      history.replaceState(history.state, '', ROUTES.me + (q ? '?' + q : ''));
    } catch (e) { /* ignore */ }
    renderMePage();
  }
  function renderMePage() {
    if (landing.step !== 'me' || inRoom) return;
    paintAvatar($('mp-avatar'), myAvatar());
    var nm = $('mp-name'); if (nm) nm.textContent = nickValue() || acctName();
    var pv = $('mp-provider');
    if (pv) pv.textContent = acctLoggedIn() ? providerLabel(acct.user && acct.user.provider) + ' 계정' + (acct.user && acct.user.email ? ' · ' + acct.user.email : '') : '';
    var tab = meTab();
    ['sets', 'gallery'].forEach(function (t) {
      var b = $('tab-' + t); if (b) { b.setAttribute('aria-selected', t === tab ? 'true' : 'false'); b.tabIndex = t === tab ? 0 : -1; }
      var p = $('me-panel-' + t); if (p) p.hidden = t !== tab;
    });
  }
  // 회원 탈퇴
  function openDeleteDialog() {
    if (!acctLoggedIn()) return;
    var d = $('overlay-delete'); if (!d) return;
    d.hidden = false;
    var b = $('btn-delete-cancel'); if (b) { try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  }
  function closeDeleteDialog() { var d = $('overlay-delete'); if (d) d.hidden = true; }
  function doDeleteAccount() {
    if (!acctLoggedIn() || !Account || !Account.deleteAccount) return;
    var uid = acct.user.id, btn = $('btn-delete-confirm');
    if (btn) { btn.disabled = true; btn.textContent = '탈퇴하는 중…'; }
    Account.deleteAccount()
      .then(function () {
        forgetConfirmed(uid);
        try { localStorage.removeItem('drawguess.photoCache'); } catch (e) { /* ignore */ }
        closeDeleteDialog();
        toast('탈퇴했어요. 게스트로는 언제든 다시 놀 수 있어요', 'ok');
      })
      .catch(function (e) { acctErr(e, '탈퇴 처리에 실패했어요'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = '탈퇴하기'; } });
  }
  function renderAccountPanel() {
    if (!acct.open) return;
    var cnt = $('wordset-count'); if (cnt) cnt.textContent = acct.setsLoaded ? acct.sets.length + ' / ' + ACCT_MAX_SETS : '';
    var loading = $('wordset-loading'); if (loading) loading.hidden = acct.setsLoaded;
    var empty = $('wordset-empty'); if (empty) empty.hidden = !acct.setsLoaded || !!acct.sets.length;
    var list = $('wordset-list');
    if (list) {
      list.innerHTML = '';
      acct.sets.forEach(function (s) {
        var li = el('li', 'wordset-item'); li.setAttribute('data-id', String(s.id));
        var head = el('div', 'ws-head');
        head.appendChild(el('strong', 'ws-name', s.name));
        head.appendChild(el('span', 'ws-meta', s.words.length + '개' + (s.updated_at ? ' · ' + fmtDate(s.updated_at) : '')));
        li.appendChild(head);
        li.appendChild(el('div', 'ws-preview', s.words.slice(0, 8).join(', ') + (s.words.length > 8 ? ' …' : '')));
        var acts = el('div', 'ws-actions');
        var ed = el('button', 'btn btn-ghost btn-sm ws-edit', '수정'); ed.type = 'button';
        ed.addEventListener('click', function () { openWordSetForm(s); });
        var dl = el('button', 'btn btn-ghost btn-sm ws-delete', '삭제'); dl.type = 'button';
        dl.addEventListener('click', function () { deleteWordSet(s); });
        acts.appendChild(ed); acts.appendChild(dl);
        li.appendChild(acts);
        list.appendChild(li);
      });
    }
    var form = $('wordset-form'); if (form) form.hidden = !acct.formOpen;
    var nb = $('btn-wordset-new');
    if (nb) { nb.hidden = acct.formOpen; nb.disabled = acct.sets.length >= ACCT_MAX_SETS; nb.title = nb.disabled ? '단어 세트는 ' + ACCT_MAX_SETS + '개까지 만들 수 있어요' : ''; }
    var ft = $('ws-form-title'); if (ft) ft.textContent = acct.editing ? '세트 수정' : '새 세트';
    updateWordCount();
  }
  function refreshWordSets() {
    if (!acctLoggedIn() || acct.loadingSets) return Promise.resolve();
    acct.loadingSets = true;
    return Account.listWordSets().then(function (rows) { acct.sets = rows || []; })
      .catch(function (e) { acctErr(e, '단어 세트를 불러오지 못했어요'); })
      .then(function () { acct.loadingSets = false; acct.setsLoaded = true; renderAccount(); });
  }
  function openWordSetForm(set, prefillWords) {
    acct.formOpen = true; acct.editing = set || null;
    var n = $('ws-name'), w = $('ws-words'), err = $('ws-error');
    if (n) n.value = set ? set.name : '';
    if (w) w.value = set ? set.words.join(', ') : (prefillWords || '');
    if (err) err.textContent = '';
    renderAccountPanel();
    setTimeout(function () { if (n) { try { n.focus(); } catch (e) { /* ignore */ } } }, 60);
  }
  function updateWordCount() {
    var w = $('ws-words'), c = $('ws-count'); if (!w || !c) return;
    var r = parseWords(w.value);
    var txt = r.words.length + '개';
    if (r.invalid.length) txt += ' · 제외 ' + r.invalid.length + '개(1~20자만)';
    if (r.words.length > ACCT_MAX_WORDS) txt += ' · 최대 ' + ACCT_MAX_WORDS + '개';
    c.textContent = txt;
    c.classList.toggle('over', r.words.length > ACCT_MAX_WORDS);
  }
  function submitWordSet() {
    var n = $('ws-name'), w = $('ws-words'), err = $('ws-error'), btn = $('btn-ws-submit');
    var name = n ? n.value.trim() : '', r = parseWords(w ? w.value : '');
    var msg = !name ? '세트 이름을 입력해주세요'
      : Array.from(name).length > 30 ? '세트 이름은 30자까지예요'
      : !r.words.length ? '단어를 1개 이상 입력해주세요 (쉼표로 구분, 각 1~20자)'
      : r.words.length > ACCT_MAX_WORDS ? '단어는 세트당 ' + ACCT_MAX_WORDS + '개까지 저장할 수 있어요' : '';
    if (msg) { if (err) err.textContent = msg; return; }
    if (btn) btn.disabled = true;
    var editing = acct.editing;
    Account.saveWordSet({ id: editing ? editing.id : undefined, name: name, words: r.words })
      .then(function () { toast(editing ? '세트를 수정했어요' : '세트를 저장했어요', 'ok'); acct.formOpen = false; acct.editing = null; return refreshWordSets(); })
      .catch(function (e) { if (err) err.textContent = e && e.message ? e.message : '저장에 실패했어요'; acctErr(e, '저장에 실패했어요'); return refreshWordSets(); }) // 실패 원인이 서버 상태(개수 제한 등)일 수 있으니 목록도 새로 고친다
      .then(function () { if (btn) btn.disabled = false; renderAccountPanel(); });
  }
  function deleteWordSet(s) {
    if (!window.confirm('"' + s.name + '" 세트를 삭제할까요?')) return;
    Account.deleteWordSet(s.id)
      .then(function () {
        toast('세트를 삭제했어요', 'ok');
        if (acct.editing && acct.editing.id === s.id) { acct.formOpen = false; acct.editing = null; }
        return refreshWordSets();
      })
      .catch(function (e) { acctErr(e, '삭제에 실패했어요'); });
  }
  /** 세트의 단어를 방 설정(사용자 단어 + "사용자 단어만 사용")에 넣고 전송. 호스트·대기실에서만 */
  function applyWordSet(s) {
    if (!canApplySet()) { toast('호스트로 대기실에 있을 때 적용할 수 있어요', 'error'); return; }
    var ta = $('set-customWords'), cb = $('set-customWordsOnly');
    if (ta) ta.value = s.words.join(', ');
    if (cb) cb.checked = true;
    sendSettings();
    toast('"' + s.name + '" 세트를 방 설정에 적용했어요', 'ok');
  }
  /** 방 설정: 지금 사용자 단어를 이름만 받아 새 세트로 저장 */
  function openQuickSave() {
    if (!acctLoggedIn()) return;
    var ta = $('set-customWords'), r = parseWords(ta ? ta.value : '');
    if (!r.words.length) { toast('저장할 사용자 단어가 없어요', 'error'); return; }
    if (acct.setsLoaded && acct.sets.length >= ACCT_MAX_SETS) { toast('단어 세트는 ' + ACCT_MAX_SETS + '개까지 만들 수 있어요', 'error'); return; }
    var row = $('wordset-quick'), sv = $('btn-wordset-save'), n = $('ws-quick-name');
    if (row) row.hidden = false; if (sv) sv.hidden = true;
    if (n) { n.value = ''; focusNode(n); }
  }
  function closeQuickSave() {
    var row = $('wordset-quick'), sv = $('btn-wordset-save');
    if (row) row.hidden = true; if (sv) sv.hidden = false;
  }
  function submitQuickSave() {
    var n = $('ws-quick-name'), ta = $('set-customWords'), b = $('btn-ws-quick-save');
    var name = n ? n.value.trim() : '', r = parseWords(ta ? ta.value : '');
    if (!name) { toast('세트 이름을 입력해주세요', 'error'); focusNode(n); return; }
    if (Array.from(name).length > 30) { toast('세트 이름은 30자까지예요', 'error'); return; }
    if (!r.words.length) { toast('저장할 사용자 단어가 없어요', 'error'); return; }
    if (r.words.length > ACCT_MAX_WORDS) { toast('단어는 세트당 ' + ACCT_MAX_WORDS + '개까지 저장할 수 있어요', 'error'); return; }
    if (b) b.disabled = true;
    Account.saveWordSet({ name: name, words: r.words })
      .then(function () { toast('"' + name + '" 세트를 저장했어요', 'ok'); closeQuickSave(); return refreshWordSets(); })
      .catch(function (e) { acctErr(e, '저장에 실패했어요'); })
      .then(function () { if (b) b.disabled = false; });
  }

  // ------------------------------------------------------------------
  // 방 안 프로필 수정(대기실에서만): 랜딩의 #landing-step-profile 노드를 모달(데스크톱)/시트(모바일)로 옮겨 쓴다.
  //   저장 → 이 브라우저·계정 프로필에도 저장 + player:update. 닫기(저장 안 함) → 연 순간의 값으로 되돌린다.
  // ------------------------------------------------------------------
  var roomProfile = { open: false, home: null, next: null, snap: null, timer: null };
  function openRoomProfile() {
    if (!inRoom) return;
    if (state.phase !== 'lobby') { toast('프로필은 대기실에서 바꿀 수 있어요', 'error'); return; }
    var node = $('landing-step-profile'); if (!node) return;
    if (!roomProfile.home) { roomProfile.home = node.parentNode; roomProfile.next = node.nextElementSibling; }
    clearTimeout(roomProfile.timer); roomProfile.timer = null;
    var me = state.players.filter(function (p) { return p.id === myId; })[0];
    if (me && me.name) profile.name = me.name; // 방에서 쓰는 이름에서 시작
    var nick = $('nick'); if (nick) nick.value = profile.name;
    roomProfile.snap = { name: profile.name, emoji: profile.emoji, color: profile.color, mode: photo.mode, url: photo.url };
    roomProfile.open = true;
    node.classList.remove('step-fwd', 'step-back');
    node.hidden = false;
    if (mobileMq.matches) { placeNode(node, $('sheet-profile-body')); openSheet('sheet-profile'); }
    else { placeNode(node, $('room-profile-modal-body')); var m = $('overlay-profile'); if (m) m.hidden = false; }
    renderProfile(); updateNextBtn();
    if (!mobileMq.matches) focusNode(nick);
  }
  /** fromSheet: 시트가 스스로 닫히는 중(드래그·뒤로가기·✕) */
  function closeRoomProfile(fromSheet) {
    if (!roomProfile.open) return;
    roomProfile.open = false;
    if (roomProfile.snap) { // 저장하지 않고 닫음 → 되돌린다
      var s = roomProfile.snap;
      profile.name = s.name; profile.emoji = s.emoji; profile.color = s.color; photo.mode = s.mode; photo.url = s.url;
      var nick = $('nick'); if (nick) nick.value = profile.name;
      saveProfile(); renderProfile();
    }
    roomProfile.snap = null;
    var m = $('overlay-profile'); if (m) m.hidden = true;
    if (!fromSheet && openSheetId === 'sheet-profile') closeSheet(false);
    // 시트는 내려가는 동안 내용을 두고, 다 닫힌 뒤 랜딩 자리로 돌려놓는다
    if (fromSheet || mobileMq.matches) roomProfile.timer = setTimeout(restoreProfileNode, 320); else restoreProfileNode();
  }
  function restoreProfileNode() {
    roomProfile.timer = null;
    if (roomProfile.open) return;
    var node = $('landing-step-profile');
    if (node && roomProfile.home) { placeNode(node, roomProfile.home, roomProfile.next); node.hidden = landing.step !== 'profile'; }
  }
  function submitRoomProfile(name) {
    roomProfile.snap = null; // 저장했으니 닫아도 되돌리지 않는다
    var avatar = myAvatar();
    closeRoomProfile();
    emit('player:update', { name: name, avatar: avatar }, function (ack) {
      if (ack && ack.ok) toast('프로필을 바꿨어요', 'ok');
      else toast((ack && ack.error) || '프로필을 바꾸지 못했어요', 'error');
    });
  }

  function startSignIn(provider) {
    if (!Account) return;
    rememberHistoryForOAuth();
    try { var code = landing.invite || codeInput(); if (code) sessionStorage.setItem(PENDING_ROOM_KEY, code); } catch (e) { /* ignore */ }
    var btns = [$('btn-login-google'), $('btn-login-kakao')];
    btns.forEach(function (b) { if (b) b.disabled = true; });
    Account.signIn(provider)
      .catch(function (e) { acctErr(e, '로그인을 시작하지 못했어요'); })
      .then(function () { btns.forEach(function (b) { if (b) b.disabled = false; }); });
  }
  function doSignOut() {
    if (!Account) return;
    Account.signOut().then(function () { toast('로그아웃했어요', 'ok'); }).catch(function (e) { acctErr(e, '로그아웃에 실패했어요'); });
  }
  function buildAccount() {
    var g = $('btn-login-google'); if (g) g.addEventListener('click', function () { startSignIn('google'); });
    var k = $('btn-login-kakao'); if (k) k.addEventListener('click', function () { startSignIn('kakao'); });
    ['btn-account-open', 'btn-account-top'].forEach(function (id) { var b = $(id); if (b) b.addEventListener('click', openAccount); });
    ['btn-logout', 'btn-mp-logout'].forEach(function (id) { var b = $(id); if (b) b.addEventListener('click', doSignOut); });
    var nb = $('btn-wordset-new'); if (nb) nb.addEventListener('click', function () { openWordSetForm(null); });
    var wc = $('btn-ws-cancel'); if (wc) wc.addEventListener('click', function () { acct.formOpen = false; acct.editing = null; renderAccountPanel(); });
    var wf = $('wordset-form'); if (wf) wf.addEventListener('submit', function (e) { e.preventDefault(); submitWordSet(); });
    var ww = $('ws-words'); if (ww) ww.addEventListener('input', updateWordCount);
    var sel = $('wordset-load');
    if (sel) sel.addEventListener('change', function () {
      var id = sel.value; sel.value = '';
      var s = null; acct.sets.forEach(function (x) { if (String(x.id) === id) s = x; });
      if (!s || !canApplySet()) return;
      var ta = $('set-customWords'); if (ta) ta.value = s.words.join(', ');
      sendSettings();
      toast('"' + s.name + '" 세트를 불러왔어요', 'ok');
    });
    var sv = $('btn-wordset-save'); if (sv) sv.addEventListener('click', openQuickSave);
    var qsv = $('btn-ws-quick-save'); if (qsv) qsv.addEventListener('click', submitQuickSave);
    var qcn = $('btn-ws-quick-cancel'); if (qcn) qcn.addEventListener('click', closeQuickSave);
    var qn = $('ws-quick-name');
    if (qn) qn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitQuickSave(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeQuickSave(); }
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function boot() {
    loadProfile();
    buildLanding();
    buildRoom();
    buildAccount();
    clearCanvas();
    renderAll();
    connect();
    initAccount(); // 로그인(선택): 설정이 없으면 즉시 false 로 끝나고 아무 UI 도 켜지 않는다
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 디버깅용 (콘솔에서 상태 확인)
  window.__dg = { state: state, ui: ui, acct: acct, photo: photo, landing: landing, ops: function () { return ops; }, redrawAll: redrawAll, myId: function () { return myId; } };
})();
