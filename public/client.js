/* =====================================================================
   이뭔그 (이게 뭔 그림인데?) — client.js
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
  var DEFAULT_SETTINGS = { rounds: 3, drawTime: 80, wordCount: 3, hints: 2, hintEndAt: 15, customWords: '', customWordsOnly: false, categories: [], mode: 'classic', fixedDrawerId: null };
  // 기본 단어 카테고리 이름(server/words.js CATEGORIES 와 같은 순서). settings.categories 가 비어 있으면 전체
  var CATEGORY_NAMES = ['동물', '음식', '탈것', '옷·장신구', '악기', '스포츠·운동', '사물', '장소·자연', '나라·도시·랜드마크', '직업·사람·캐릭터', '행동·놀이·행사', '신체·건강', '브랜드·캐릭터'];
  // 지금 켜진 카테고리 목록. settings.categories 가 비어 있으면(=전체) 13개 전부
  function selectedCategories() {
    var c = Array.isArray(state.settings.categories) ? state.settings.categories : [];
    return c.length ? CATEGORY_NAMES.filter(function (n) { return c.indexOf(n) !== -1; }) : CATEGORY_NAMES.slice();
  }
  var REASON_TEXT = { time: '시간 종료!', allGuessed: '모두 맞혔어요!', drawerLeft: '출제자가 나갔어요', notEnoughPlayers: '플레이어가 부족해요' };
  // 이어 그리기(relay) 턴 종료 문구. allGuessed 는 맞히는 사람 이름을 넣어 renderOverlays 에서 만든다
  var RELAY_REASON_TEXT = { time: '시간 종료! 못 맞혔어요', guesserLeft: '맞히는 사람이 나가서 다음 문제로', notEnoughPlayers: '플레이어가 부족해요' };
  // 이어 그리기 인원(server/game.js RELAY_MIN_PLAYERS·RELAY_MAX_PLAYERS 와 같음). ALLOW_SOLO 서버는 2명부터
  var RELAY_MIN = 3, RELAY_MAX = 6;
  var STORAGE_KEY = 'drawguess.profile';
  var TOKEN_KEY = 'drawguess.token';      // 재접속용 토큰(브라우저별 1개)
  var LAST_ROOM_KEY = 'drawguess.lastRoom'; // 마지막으로 있던 방 { code, ts }
  // 개인 설정(이 기기): 욕설 가리기 · 방송 모드. 방 설정이 아니라 각자 설정 창(⚙)·내 정보에서 바로 바꾼다
  var PREFS_KEY = 'drawguess.prefs';
  var prefs = { profanityFilter: true, streamerMode: false };
  (function () {
    try {
      var v = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (v && typeof v === 'object') Object.keys(prefs).forEach(function (k) { if (typeof v[k] === 'boolean') prefs[k] = v[k]; });
    } catch (e) { /* ignore */ }
  })();
  function setPref(key, val) {
    if (!(key in prefs)) return;
    prefs[key] = !!val;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
    renderPrefSwitches(); applyProfanityPref();
    if (inRoom) renderAll();
  }
  /** 설정 창·내 정보의 스위치를 현재 값으로 */
  function renderPrefSwitches() {
    document.querySelectorAll('.pref-switch').forEach(function (b) {
      var k = b.getAttribute('data-pref');
      b.setAttribute('aria-checked', prefs[k] ? 'true' : 'false');
    });
  }
  /** 이미 그려진 채팅에도 바로 적용(가린 판 ↔ 원문) */
  function applyProfanityPref() {
    document.querySelectorAll('#chat-list .msg-text[data-safe]').forEach(function (n) {
      n.textContent = prefs.profanityFilter ? n.getAttribute('data-safe') : n.getAttribute('data-raw');
    });
    ui.recentChat.forEach(function (m) { if (m.safe) m.text = prefs.profanityFilter ? m.safe : m.raw; });
    renderChatPeek(false);
  }
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
  // 프로필 사진(avatar.img): https(카카오 http 는 https 로) · 개발 모크용 data:image/ · blob: 만.
  // 로드에 실패한 주소는 BAD_IMG_RETRY_MS 동안 이모지로 보여 주고, 그 뒤 다시 그릴 때 한 번 더 시도한다(일시적 네트워크 오류 대비)
  var badImgs = {}, BAD_IMG_RETRY_MS = 60 * 1000;
  function isBadImg(u) { var t = badImgs[u]; if (!t) return false; if (Date.now() - t < BAD_IMG_RETRY_MS) return true; delete badImgs[u]; return false; }
  function avatarImgUrl(u) {
    if (typeof u !== 'string' || !u || u.length > 2048) return null;
    if (/^http:\/\//i.test(u)) u = 'https://' + u.slice(7);
    if (!/^(https:\/\/|data:image\/|blob:)/i.test(u) || isBadImg(u)) return null;
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
      badImgs[av.img] = Date.now();
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
    allowSolo: false, // 서버가 ALLOW_SOLO=1 로 떠 있으면 true(최소 인원 1명). room:state 로 내려온다
    relay: null // 이어 그리기 문제 진행 중이면 { order:[이번 문제 주자], guesserId, legIndex, legCount } (room:state · game:drawing · game:baton)
  };
  function minPlayers() { return state.allowSolo ? 1 : 2; }
  var MODE_NAMES = { classic: '돌아가며 그리기', fixed: '한 명이 그리기', blitz: '속도전', relay: '이어 그리기' };
  // 모드 카드를 고를 때 함께 적용되는 프리셋 (그 뒤엔 설정 화면에서 자유롭게 바꿀 수 있다)
  var MODE_PRESETS = { blitz: { drawTime: 25, hints: 0, rounds: 5 }, classic: { drawTime: 80, hints: 2, rounds: 3 }, fixed: { drawTime: 80, hints: 2, rounds: 5 }, relay: { drawTime: 20, hints: 3 } };
  /** 게임 길이 빠른 선택(모드별). 보통 = 모드를 고를 때의 기본값(MODE_PRESETS) */
  var LENGTH_PRESETS = {
    classic: { short: { rounds: 2, drawTime: 60, hints: 1 }, normal: { rounds: 3, drawTime: 80, hints: 2 }, long: { rounds: 5, drawTime: 100, hints: 2 } },
    fixed: { short: { rounds: 3, drawTime: 60, hints: 1 }, normal: { rounds: 5, drawTime: 80, hints: 2 }, long: { rounds: 8, drawTime: 100, hints: 2 } },
    blitz: { short: { rounds: 3, drawTime: 20, hints: 0 }, normal: { rounds: 5, drawTime: 25, hints: 0 }, long: { rounds: 8, drawTime: 30, hints: 0 } },
    // 이어 그리기: 라운드가 없다(문제 수 = 인원). drawTime = 한 명당 그리는 시간, hints = 맞히는 사람 힌트 최대 횟수
    relay: { short: { drawTime: 15, hints: 2 }, normal: { drawTime: 20, hints: 3 }, long: { drawTime: 30, hints: 3 } }
  };
  var PRESET_NAMES = { short: '짧게', normal: '보통', long: '길게' };
  // 이어 그리기 단어 후보 수(wordCount) 범위·기본값 — 첫 주자가 이 중 RELAY_PICK(2)개를 골라 제시어를 만든다. 다른 모드는 2~5, 기본 3(서버와 같음)
  var RELAY_WORD_COUNT = { min: 3, max: 8, def: 6 }, RELAY_PICK = 2;
  function wordCountRange(mode) { return mode === 'relay' ? [RELAY_WORD_COUNT.min, RELAY_WORD_COUNT.max] : [2, 5]; }
  function presetsFor(mode) { return LENGTH_PRESETS[mode] || LENGTH_PRESETS.classic; }
  function matchPreset(s) {
    var ps = presetsFor(s.mode), found = null;
    Object.keys(ps).forEach(function (k) {
      var p = ps[k];
      if ((s.mode === 'relay' || p.rounds === s.rounds) && p.drawTime === s.drawTime && (s.mode === 'blitz' || p.hints === s.hints)) found = k;
    });
    return found;
  }
  /** 전체 턴 수와 최대 예상 시간(분). 턴마다 단어 고르기(평균 ~8초, 속도전 0) + 결과 5초를 더한다 */
  function estimateGame(s) {
    var conn = state.players.filter(function (p) { return p.connected !== false; }).length;
    var n = Math.max(2, conn);
    if (s.mode === 'relay') {
      // 최소 인원 미만이면 "최소 인원으로 시작하면" 기준으로 계산한다(기준 표시는 renderSettings)
      var below = conn < relayMin();
      if (below) n = relayMin();
      // 문제 n개, 문제마다 주자 n−1명이 한 명당 drawTime 초 + 제시어 고르기(~8초) + 결과 5초
      return { players: n, turns: n, below: below, minutes: Math.max(1, Math.round(n * (s.drawTime * (n - 1) + 8 + 5) / 60)) };
    }
    var turns = s.mode === 'fixed' ? s.rounds : s.rounds * n;
    var per = s.drawTime + (s.mode === 'blitz' ? 0 : 8) + 5;
    return { players: n, turns: turns, minutes: Math.max(1, Math.round(turns * per / 60)) };
  }
  function presetSub(mode, p) {
    if (mode === 'relay') return '한 명당 ' + p.drawTime + '초'; // 힌트 수까지 넣으면 폰에서 잘린다
    return (mode === 'fixed' ? p.rounds + '문제' : p.rounds + '라운드') + ' · ' + p.drawTime + '초';
  }
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
    wordMask: '', wordLength: 0, word: null, wordOptions: null, chosenWord: null, relayPicks: [], relayAutoTimer: null, category: null,
    // 방송 모드: 방 코드 잠깐 보기 시각 · 내 단어/후보 보기 토글 · 주소 갱신용 이전 값
    codeRevealUntil: 0, wordPeek: false, optionsPeek: false, streamerWas: null,
    wordWin: null, wordKey: '', wordChan: null, wordWatch: null, // 방송 모드 단어 창(팝업) — 방송 캡처 밖에서 후보·내 단어를 본다
    drawerName: '', timeLeft: null, turnEnd: null, ranking: null, optionsKey: '',
    gallery: null,      // 가장 최근 게임의 갤러리 [{ round, word, category, drawerName, guessed, ops }]
    galleryOpen: false,
    galleryThumbs: [],  // 렌더링한 썸네일 dataURL 캐시 (gallery와 같은 인덱스)
    recentChat: [],     // 최근 채팅 3개 { kind, name, text, mine } — 모바일 티커/말풍선/접힌 채팅 바용
    // 이어 그리기: 구간 남은 시간 · 문제 정보(game:drawing.relay) · 내 구간이 시작될 때의 ops 길이(되돌리기 경계) · 내 차례 배너 타이머
    legTimeLeft: null, relayInfo: null, legStartOps: 0, bannerTimer: null,
    // 이어 그리기 맞히는 사람: 힌트 요청 응답 대기 · 막 맞힌 요소(마스크 반짝임 { idx: true, until })
    hintPending: false, hintPendingTimer: null, solvedFlash: null, relayWaitTimer: null
  };

  var profile = { name: '', emoji: EMOJIS[0], color: AV_COLORS[4] };
  // 로그인 사용자의 사진 설정(프로필 설정 단계). mode: 'photo' | 'emoji', url: 지금 사진, social: 소셜 로그인 기본 사진
  var photo = { mode: 'emoji', url: null, social: null, uploading: false };

  function isHost() { return !!myId && state.hostId === myId; }
  function isDrawer() { return !!myId && state.drawerId === myId; }
  function canDraw() { return state.phase === 'drawing' && isDrawer(); }
  // ---- 이어 그리기(relay) ----
  /** relay 문제가 진행 중인지(choosing·drawing·turnEnd). 대기실·게임 종료면 state.relay 가 null */
  function inRelay() { return state.settings.mode === 'relay' && !!state.relay && state.phase !== 'lobby' && state.phase !== 'gameOver'; }
  /** 이번 문제의 주자인지(차례가 아니어도) */
  function isRunner() { return inRelay() && state.relay.order.indexOf(myId) !== -1; }
  /** 이번 문제의 맞히는 사람인지 */
  function isRelayGuesser() { return inRelay() && state.relay.guesserId === myId; }
  /** 그리기 화면 배치를 쓰는지: 출제자, 또는 relay 이번 문제의 주자 전원(차례가 아니면 툴바만 잠긴다). 모바일 data-role 은 문제 단위라 구간이 바뀌어도 깜빡이지 않는다 */
  function drawerLayout() { return isDrawer() || isRunner(); }
  /** 제시어를 화면에 보여도 되는지: 서버가 word 를 준 사람(출제자 · relay 현재·지난 주자) */
  function showsWord() { return !!ui.word && (isDrawer() || isRunner()); }
  /** relay 시작 가능 인원(접속 기준). ALLOW_SOLO 서버는 2명부터 */
  function relayMin() { return state.allowSolo ? 2 : RELAY_MIN; }
  function onlineCount() { return state.players.filter(function (p) { return p.connected !== false; }).length; }
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
    btn.setAttribute('aria-checked', muted ? 'false' : 'true');
    btn.title = muted ? '효과음 켜기' : '효과음 끄기';
    var st = $('sound-state'); if (st) st.textContent = muted ? '꺼짐' : '켜짐';
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
    // 이어 그리기: 현재 주자가 받는 draw:sync 는 문제 시작(빈 판) · 내 전체 지우기 뒤(앞 주자 그림만 남음) · 재접속 catch-up 이다.
    // 앞 두 경우는 지금 길이가 정확히 내 구간 경계이고, catch-up 은 끊기기 전 내 획까지 경계 앞으로 넣는다(되돌리기만 못 할 뿐 서버와 어긋나지 않는다)
    if (inRelay() && isDrawer()) { remoteOp = null; ui.legStartOps = ops.length; }
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
    // relay 구간 보호: 내 구간이 시작될 때의 ops 길이(ui.legStartOps) 앞은 앞 주자 그림이라 서버도 무시한다. 로컬 ops 는 서버 중계를 그대로 따라가므로 같은 경계다
    if (inRelay() && ops.length <= ui.legStartOps) { toast('앞사람 그림은 되돌릴 수 없어요'); return; }
    ops.pop(); redrawAll(); emit('draw:undo');
  }
  function doClear() {
    if (!canDraw()) return;
    cancelLocalStroke(true);
    // relay: 서버가 내 구간 그림만 지우고 남은 ops 를 draw:sync 로 다시 보내 준다(앞 주자 그림 보존). 로컬에서 먼저 지우지 않는다
    if (inRelay()) { emit('draw:clear'); return; }
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

  var update = { pending: false, reloading: false };
  /** 지금 새로고침해도 되는가: 방 밖이거나, 대기실이고 결과 화면 · 설정 창을 닫았고 채팅을 쓰는 중이 아닐 때 */
  function canReloadNow() {
    if (!inRoom) return true;
    if (state.phase !== 'lobby') return false;
    var og = $('overlay-gameover'); if (og && !og.hidden) return false;
    if (roomProfile.open) return false;
    var ci = $('chat-input'); if (ci && document.activeElement === ci && ci.value) return false;
    return true;
  }
  function reloadForUpdate() {
    if (update.reloading) return;
    update.reloading = true; update.pending = false;
    toast('새 버전으로 새로고침합니다');
    if (inRoom && state.roomCode) saveLastRoom(state.roomCode); // 새로고침 뒤 같은 방으로 자동 복귀
    setTimeout(function () { location.reload(); }, 1200);
  }
  function maybeReloadForUpdate() { if (update.pending && !update.reloading && canReloadNow()) reloadForUpdate(); }
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
      // 그리던 획은 버린다(끊긴 동안 쌓인 점을 재접속 뒤 보내지 않게). 돌아오면 draw:sync 로 서버 그림과 맞춰진다
      pending = []; cancelLocalStroke(false);
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
    // 게임 중(대기실이 아님 · 결과 화면을 보는 중 · 프로필 수정 중)이면 미뤘다가 대기실로 돌아오면 새로고침한다
    // → 그리는 사람이 새로고침으로 끊겨 차례가 넘어가거나, 방장이 바뀌는 일을 막는다
    on('server:version', function (p) {
      var meta = document.querySelector('meta[name="asset-version"]');
      var pageVersion = meta ? meta.getAttribute('content') : null;
      if (!pageVersion || !p || typeof p.version !== 'string' || p.version === pageVersion) return;
      if (canReloadNow()) { reloadForUpdate(); return; }
      if (!update.pending) toast('새 버전이 나왔어요. 이번 게임이 끝나면 새로고침돼요');
      update.pending = true;
    });
    on('room:state', onRoomState);
    on('game:choosing', onChoosing);
    on('game:drawing', onDrawing);
    on('game:hint', onHint);
    on('game:timer', function (p) {
      if (p && p.legTimeLeft != null) ui.legTimeLeft = Math.max(0, Math.round(num(p.legTimeLeft, 0)));
      if (p && p.timeLeft != null) setTimeLeft(num(p.timeLeft, 0), true);
      armRelayAutoPick();
    });
    on('game:baton', onBaton);
    on('game:turnEnd', onTurnEnd);
    on('game:over', onGameOver);
    on('game:aborted', onGameAborted);
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
    state.relay = sanitizeRelay(s.relay);
    if (s.lobbyStep === 'mode' || s.lobbyStep === 'settings') state.lobbyStep = s.lobbyStep;
    state.fixedDrawerId = s.fixedDrawerId == null ? null : s.fixedDrawerId;
    if (typeof s.allowSolo === 'boolean') state.allowSolo = s.allowSolo;
    if (state.phase === 'lobby' && prevPhase !== 'lobby') {
      closeGameKeyboard();
      resetCanvasState(); ui.wordMask = ''; ui.word = null; ui.wordOptions = null; ui.chosenWord = null; resetRelayPicks();
      ui.turnEnd = null; setTimeLeft(null);
      ui.legTimeLeft = null; ui.relayInfo = null; ui.legStartOps = 0; hideTurnBanner();
      clearHintPending(); ui.solvedFlash = null;
      // ui.ranking 은 유지 — 결과 화면은 내가 "대기실로 돌아가기"를 누를 때까지 보여야 한다
    }
    var meNow = findPlayer(myId);
    if (meNow && !meNow.atResults && ui.ranking && !ui.resultsPending) ui.ranking = null; // 서버가 결과 확인을 반영하면 정리
    if (state.phase !== 'choosing') { ui.wordOptions = null; ui.chosenWord = null; resetRelayPicks(); }
    if (drawing && (state.phase !== 'drawing' || !isDrawer())) cancelLocalStroke(false);
    if (ui.relayWaitTimer) { clearTimeout(ui.relayWaitTimer); ui.relayWaitTimer = null; } // onChoosing 이 미뤄 둔 그리기를 여기서
    renderAll();
  }
  /** room:state.relay · game:drawing.relay 공통 형식 { order, guesserId, legIndex, legCount } (없거나 이상하면 null) */
  function sanitizeRelay(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.order)) return null;
    return { order: r.order.slice(), guesserId: r.guesserId == null ? null : r.guesserId, legIndex: num(r.legIndex, 0), legCount: num(r.legCount, r.order.length) };
  }

  function onChoosing(p) {
    if (!p || typeof p !== 'object') return;
    state.phase = 'choosing';
    if (p.drawerId != null) state.drawerId = p.drawerId;
    ui.drawerName = p.drawerName ? String(p.drawerName) : playerName(state.drawerId, '출제자');
    ui.wordOptions = Array.isArray(p.wordOptions) ? p.wordOptions.map(String) : null;
    if (ui.wordOptions && ui.wordOptions.length) SFX.play('myTurn');
    ui.chosenWord = null; ui.optionsPeek = false; ui.wordPeek = false; resetRelayPicks();
    ui.word = null; ui.wordMask = ''; ui.category = null; ui.turnEnd = null; ui.ranking = null;
    ui.legTimeLeft = null; ui.relayInfo = null; ui.legStartOps = 0; hideTurnBanner();
    clearHintPending(); ui.solvedFlash = null;
    // 이어 그리기: 서버는 game:choosing 을 새 문제의 room:state(주자 순서·맞히는 사람)보다 먼저 보낸다. 지난 문제(또는 대기실)의
    // relay 로 그리면 배치(data-role)·헤더가 한 번 엇갈렸다가 바로 바뀌어 깜빡이므로, 순서가 아직 이 문제 것이 아니면
    // 곧 올 room:state 가 그리게 둔다(안 오면 0.4초 뒤 그대로 그린다)
    var relayStale = state.settings.mode === 'relay' && (!state.relay || state.relay.order[0] !== state.drawerId);
    if (relayStale) state.relay = null;
    resetCanvasState();
    setTimeLeft(p.timeLeft != null ? num(p.timeLeft, 15) : 15, true);
    armRelayAutoPick();
    if (relayStale) {
      if (ui.relayWaitTimer) clearTimeout(ui.relayWaitTimer);
      ui.relayWaitTimer = setTimeout(function () { ui.relayWaitTimer = null; renderAll(); }, 400);
      return;
    }
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
    ui.wordOptions = null; ui.chosenWord = null; ui.turnEnd = null; ui.wordPeek = false; resetRelayPicks();
    ui.drawerName = playerName(state.drawerId, ui.drawerName);
    var rp = p.relay && typeof p.relay === 'object' ? p.relay : null;
    if (rp) {
      // 이어 그리기: 구간 정보. room:state 가 뒤따르지만 배치(주자/맞히는 사람)가 먼저 맞도록 여기서도 채운다
      state.relay = sanitizeRelay(rp) || state.relay;
      ui.relayInfo = { legTime: num(rp.legTime, state.settings.drawTime), totalTime: num(rp.totalTime, 0), hintsUsed: num(rp.hintsUsed, 0), hintsMax: num(rp.hintsMax, state.settings.hints) };
      ui.legTimeLeft = num(rp.legTimeLeft, ui.relayInfo.legTime);
      ui.legStartOps = 0; // 뒤따르는 draw:sync 가 경계를 다시 잡는다(onDrawSync)
      clearHintPending();
      state.nextDrawerId = state.relay ? (state.relay.order[state.relay.legIndex + 1] || null) : state.nextDrawerId;
    } else { ui.relayInfo = null; ui.legTimeLeft = null; }
    setTimeLeft(p.timeLeft != null ? num(p.timeLeft, 0) : num(state.settings.drawTime, 80), true);
    state.players.forEach(function (pl) { pl.hasGuessed = false; pl.isDrawing = pl.id === state.drawerId; });
    renderAll();
    if (isDrawer()) {
      setTool(tool === 'eraser' ? 'pen' : tool);
      // 이어 그리기 첫 구간이 막 시작됐으면(재접속 catch-up 이 아니면) 내 차례 배너
      if (rp && ui.relayInfo && ui.legTimeLeft >= ui.relayInfo.legTime - 1) showTurnBanner();
    }
    else { var ci = $('chat-input'); if (ci && document.activeElement !== ci && canAutoFocusChat()) ci.focus(); }
  }

  /**
   * game:baton — 이어 그리기 구간 전환. 서버가 앞 주자의 열린 획을 닫고(다른 사람에게 draw:end) drawerId 를 바꾼 뒤 보낸다.
   * 앞 주자였던 나는 그리던 획을 로컬에서 닫는다(이후 입력은 서버가 무시). 새 주자가 나면 배너 + 되돌리기 경계를 지금 ops 길이로.
   */
  function onBaton(p) {
    if (!p || typeof p !== 'object' || state.phase !== 'drawing') return;
    var wasMe = isDrawer();
    if (drawing) cancelLocalStroke(false);
    remoteOp = null;
    if (p.drawerId != null) state.drawerId = p.drawerId;
    if (state.relay) {
      state.relay.legIndex = num(p.legIndex, state.relay.legIndex);
      state.relay.legCount = num(p.legCount, state.relay.legCount);
      state.nextDrawerId = state.relay.order[state.relay.legIndex + 1] || null;
    }
    if (p.legTimeLeft != null) ui.legTimeLeft = Math.max(0, Math.round(num(p.legTimeLeft, 0)));
    if (ui.relayInfo && typeof p.hintsUsed === 'number') ui.relayInfo.hintsUsed = p.hintsUsed;
    if (typeof p.word === 'string') ui.word = p.word; // 새 주자에게만 온다. 그 뒤로는 계속 보인다
    var dn = p.drawerName ? String(p.drawerName) : playerName(state.drawerId, '');
    ui.drawerName = dn;
    state.players.forEach(function (pl) { pl.isDrawing = pl.id === state.drawerId; });
    if (isDrawer()) { ui.legStartOps = ops.length; setTool(tool === 'eraser' ? 'pen' : tool); }
    renderAll();
    if (isDrawer()) showTurnBanner();
    else if (wasMe && dn) toast('다음은 ' + dn + '님');
  }

  /** 이어 그리기: 내 구간이 시작되는 순간 전체 화면 배너 "내 차례! 20초" + 제시어(방송 모드면 제시어는 빼고) 1.5초, 모바일은 진동 */
  function showTurnBanner() {
    var b = $('relay-banner'); if (!b) return;
    var legTime = ui.relayInfo ? ui.relayInfo.legTime : num(state.settings.drawTime, 20);
    var t = $('relay-banner-time'); if (t) t.textContent = (ui.legTimeLeft != null ? ui.legTimeLeft : legTime) + '초';
    var w = $('relay-banner-word');
    if (w) { w.textContent = ui.word && !streamer() ? ui.word : ''; w.hidden = !(ui.word && !streamer()); }
    b.hidden = false;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
    SFX.play('myTurn');
    try { if (navigator.vibrate) navigator.vibrate(200); } catch (e) { /* ignore */ }
    if (ui.bannerTimer) clearTimeout(ui.bannerTimer);
    ui.bannerTimer = setTimeout(hideTurnBanner, 1500);
  }
  function hideTurnBanner() {
    if (ui.bannerTimer) { clearTimeout(ui.bannerTimer); ui.bannerTimer = null; }
    var b = $('relay-banner'); if (b) { b.hidden = true; b.classList.remove('show'); }
  }

  function onHint(p) {
    if (!p || typeof p.wordMask !== 'string') return;
    // 이어 그리기 부분 정답: 새로 글자로 바뀐 요소를 잠깐 반짝이게(본인에게만 오는 game:hint)
    if (inRelay()) {
      var before = solvedParts(ui.wordMask), after = solvedParts(p.wordMask), fresh = {}, any = false;
      after.forEach(function (s, i) { if (s && !before[i]) { fresh[i] = true; any = true; } });
      ui.solvedFlash = any ? { idx: fresh, until: Date.now() + 1200 } : ui.solvedFlash;
    }
    ui.wordMask = p.wordMask;
    if (typeof p.category === 'string') ui.category = p.category;
    if (ui.relayInfo && typeof p.hintsUsed === 'number') ui.relayInfo.hintsUsed = p.hintsUsed;
    clearHintPending();
    renderWordArea();
    renderRelayHint();
    renderChatInput();
  }

  function onTurnEnd(p) {
    if (!p || typeof p !== 'object') return;
    state.phase = 'turnEnd';
    cancelLocalStroke(false);
    hideTurnBanner(); ui.legTimeLeft = null; clearHintPending();
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

  /** 방장이 게임을 즉시 끝냄: 턴·단어·오버레이를 지우고 대기실로(결과 화면 없음). room:state(lobby) 가 곧 뒤따른다 */
  /** 게임 화면을 떠날 때(대기실 · 결과 화면) 모바일에서 채팅 입력 키보드를 닫는다 — 대기실 화면이 키보드 위에서 어긋나 보이지 않게 */
  function closeGameKeyboard() {
    if (!mobileMq.matches) return;
    var ci = $('chat-input');
    if (ci && document.activeElement === ci && !openSheetId) { try { ci.blur(); } catch (e) { /* ignore */ } }
  }
  function onGameAborted(p) {
    closeGameKeyboard();
    cancelLocalStroke(false);
    hideTurnBanner(); ui.legTimeLeft = null; ui.relayInfo = null;
    closeLeaveDialog();
    ui.wordMask = ''; ui.word = null; ui.wordOptions = null; ui.turnEnd = null; ui.ranking = null;
    ui.saveStatus = null; ui.saveJob = null; ui.resultsPending = false;
    setTimeLeft(null);
    resetCanvasState();
    var by = p && p.by ? String(p.by) : '';
    toast(by && !isHost() ? by + '님이 게임을 끝냈어요' : '게임을 끝냈어요');
    renderAll();
  }
  function onGameOver(p) {
    closeGameKeyboard();
    state.phase = 'gameOver';
    SFX.play('gameOver');
    cancelLocalStroke(false);
    hideTurnBanner(); ui.legTimeLeft = null;
    var ranking = p && Array.isArray(p.ranking) ? p.ranking : [];
    ui.ranking = ranking.filter(function (r) { return r && typeof r === 'object'; }).map(function (r) {
      return { id: r.id, name: String(r.name || playerName(r.id, '?')), avatar: safeAvatar(r.avatar), score: num(r.score, 0) };
    }).sort(function (a, b) { return b.score - a.score; });
    ui.turnEnd = null;
    ui.gameOverDrawer = p && p.drawer && typeof p.drawer === 'object' ? { name: String(p.drawer.name || '?'), avatar: safeAvatar(p.drawer.avatar) } : null;
    if (Array.isArray(p && p.gallery)) {
      var relayGame = p.mode === 'relay';
      ui.gallery = p.gallery.filter(function (g) { return g && typeof g === 'object' && typeof g.word === 'string'; }).map(function (g) {
        var drawerName = String(g.drawerName || playerName(g.drawerId, '?'));
        // 이어 그리기: 공동 작가(drawerIds 순서)와 맞히는 사람. 이름은 서버가 문제 끝에 기록한 drawerNames 우선(나간 사람도 남는다)
        var ids = Array.isArray(g.drawerIds) && g.drawerIds.length ? g.drawerIds.slice() : [g.drawerId];
        var names = ids.map(function (id, i) {
          var n = Array.isArray(g.drawerNames) && typeof g.drawerNames[i] === 'string' && g.drawerNames[i] ? g.drawerNames[i] : '';
          return n || (i === 0 ? drawerName : playerName(id, '?'));
        });
        return {
          round: num(g.round, 0), word: String(g.word), category: g.category ? String(g.category) : '',
          drawerId: g.drawerId, drawerName: drawerName, guessed: num(g.guessed, 0),
          relay: relayGame, drawerIds: ids, drawerNames: names,
          guesserId: g.guesserId == null ? null : g.guesserId,
          guesserName: g.guesserId == null ? '' : String(g.guesserName || playerName(g.guesserId, '?')),
          ops: Array.isArray(g.ops) ? g.ops.map(sanitizeOp).filter(Boolean) : [], trimmed: !!g.trimmed
        };
      });
      ui.galleryThumbs = [];
    }
    ui.resultsPending = true; // room:state 의 atResults 가 도착하기 전까지는 결과 화면 유지
    setTimeout(function () { ui.resultsPending = false; }, 1500);
    setTimeLeft(null);
    ui.saveStatus = null; ui.saveJob = null;
    renderAll();
    saveMyDrawings();
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
  /** 갤러리·턴 띠용: 그 사람의 아바타(방에 없으면 게임 결과 순위에서, 그것도 없으면 기본) */
  function avatarOf(id) {
    var p = findPlayer(id); if (p && p.avatar) return p.avatar;
    var r = (ui.ranking || []).filter(function (x) { return x.id === id; })[0]; if (r && r.avatar) return r.avatar;
    return null;
  }
  /** 갤러리 캡션 조각: 그린 사람("✏️ 민수" / 이어 그리기 "🖍 A·B·C"), 맞힘("2명 맞힘" / "🎯 D 맞힘"), 번호("1라운드" / "1번 문제") */
  function galleryByText(g) { return g.relay ? '🖍 ' + g.drawerNames.join('·') : '✏️ ' + g.drawerName; }
  function galleryGuessText(g) { return g.relay ? '🎯 ' + (g.guesserName || '?') + (g.guessed ? ' 맞힘' : ' 못 맞힘') : g.guessed + '명 맞힘'; }
  function galleryRoundText(g) { return g.round ? (g.relay ? g.round + '번 문제' : g.round + '라운드') : ''; }
  function galleryCaption(g) {
    return (g.round ? galleryRoundText(g) + ' · ' : '') + '정답 ' + g.word + ' · ' + galleryByText(g) + ' · ' + galleryGuessText(g);
  }
  function safeFile(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40); }
  function downloadDataUrl(dataUrl, filename) {
    var a = document.createElement('a'); a.href = dataUrl; a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); }, 0);
  }
  // ---------- 저장 이미지의 브랜드 워드마크(F5) ----------
  //   참가자가 올리는 이미지가 유일한 시각 광고. 종이색 바탕에 연필색 "이뭔그"(로고 글꼴), 그림을 가리지 않는 여백에만. 끄는 옵션 없음.
  //   주소는 도메인이 정해진 뒤 워드마크 옆에 굽는다(BACKLOG #2).
  var PAPER = '#fff8ec', PENCIL = '#2b2d42', WORDMARK = '이뭔그';
  function wordmarkFont(px) { return '700 ' + px + 'px "Gaegu", "Pretendard", "Malgun Gothic", sans-serif'; }
  /** 오른쪽 끝(right)·세로 중심(midY)에 맞춰 워드마크를 그리고 너비를 돌려준다 */
  function drawWordmark(c2, right, midY, px) {
    c2.save();
    c2.font = wordmarkFont(px); c2.textAlign = 'right'; c2.textBaseline = 'middle'; c2.fillStyle = PENCIL;
    c2.fillText(WORDMARK, right, midY);
    var w = c2.measureText(WORDMARK).width;
    c2.restore();
    return w;
  }
  /** 로고 글꼴(Gaegu)은 첫 화면에서 쓰여 보통 이미 있지만, 캔버스에 쓰기 전에 한 번 더 요청해 둔다 */
  function preloadWordmarkFont() {
    try { if (document.fonts && document.fonts.load) document.fonts.load(wordmarkFont(40), WORDMARK); } catch (e) { /* ignore */ }
  }
  /** 그림 + 아래 캡션 띠(종이색, 오른쪽에 워드마크)를 합친 PNG */
  function galleryItemPng(i) {
    var g = ui.gallery[i];
    var src = renderOpsToCanvas(g.ops);
    var band = 72;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H + band;
    var c2 = cv.getContext('2d');
    c2.fillStyle = '#ffffff'; c2.fillRect(0, 0, cv.width, cv.height);
    c2.drawImage(src, 0, 0);
    c2.fillStyle = PAPER; c2.fillRect(0, H, W, band);
    var wmW = drawWordmark(c2, W - 20, H + band / 2, 40);
    var textMax = W - 20 - wmW - 40; // 캡션이 워드마크를 덮지 않도록
    c2.fillStyle = PENCIL; c2.font = 'bold 26px "Pretendard", "Malgun Gothic", sans-serif'; c2.textBaseline = 'middle';
    c2.fillText(g.word + (g.category ? '  (' + g.category + ')' : ''), 20, H + 26, textMax);
    c2.fillStyle = '#6c6f85'; c2.font = '16px "Pretendard", "Malgun Gothic", sans-serif';
    c2.fillText(galleryByText(g) + ' · ' + galleryGuessText(g) + (g.round ? ' · ' + galleryRoundText(g) : '') + ' · 이게 뭔 그림인데?', 20, H + 54, textMax);
    return cv.toDataURL('image/png');
  }
  /** 전체를 한 장에 모은 시트 PNG (3열). 아래 여백에 워드마크 */
  function gallerySheetPng() {
    var items = ui.gallery || [];
    var cols = Math.min(3, Math.max(1, items.length)), cellW = 400, cellH = 300, cap = 44, pad = 16, head = 64, foot = 64;
    var rows = Math.ceil(items.length / cols);
    var cv = document.createElement('canvas');
    cv.width = pad + cols * (cellW + pad); cv.height = head + rows * (cellH + cap + pad) + foot;
    var c2 = cv.getContext('2d');
    c2.fillStyle = PAPER; c2.fillRect(0, 0, cv.width, cv.height);
    c2.fillStyle = PENCIL; c2.font = 'bold 26px "Pretendard", "Malgun Gothic", sans-serif'; c2.textBaseline = 'middle';
    c2.fillText('그림 갤러리 · 방 ' + (state.roomCode || '') + ' · ' + items.length + '장', pad, head / 2, cv.width - pad * 2);
    drawWordmark(c2, cv.width - pad, cv.height - foot / 2, 40);
    items.forEach(function (g, i) {
      var col = i % cols, row = Math.floor(i / cols);
      var x = pad + col * (cellW + pad), y = head + row * (cellH + cap + pad);
      c2.fillStyle = '#ffffff'; c2.fillRect(x, y, cellW, cellH + cap);
      c2.drawImage(renderOpsToCanvas(g.ops), x, y, cellW, cellH);
      c2.fillStyle = '#f3ecff'; c2.fillRect(x, y + cellH, cellW, cap);
      // 이어 그리기는 제시어(조합)·공동 작가가 길어 칸 절반씩 넘지 않게(넘치면 fillText 가 가로로 줄인다)
      c2.fillStyle = '#2b2d42'; c2.font = 'bold 17px "Pretendard", "Malgun Gothic", sans-serif';
      if (g.relay) c2.fillText(g.word, x + 12, y + cellH + cap / 2, cellW * 0.5 - 16); else c2.fillText(g.word, x + 12, y + cellH + cap / 2);
      c2.fillStyle = '#6c6f85'; c2.font = '13px "Pretendard", "Malgun Gothic", sans-serif'; c2.textAlign = 'right';
      if (g.relay) c2.fillText(galleryByText(g) + ' · 🎯 ' + (g.guesserName || '?'), x + cellW - 12, y + cellH + cap / 2, cellW * 0.5 - 16);
      else c2.fillText(galleryByText(g) + ' · ' + galleryGuessText(g), x + cellW - 12, y + cellH + cap / 2);
      c2.textAlign = 'left';
    });
    return cv.toDataURL('image/png');
  }
  // ---------- 여러 장 저장: 한 장씩 내려받기 ----------
  function dataUrlToBlob(u) {
    var i = u.indexOf(','), type = (u.slice(5, i).split(';')[0]) || 'image/png', bin = atob(u.slice(i + 1)), a = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
    return new Blob([a], { type: type });
  }
  function downloadSequential(list) {
    return new Promise(function (resolve) {
      var i = 0;
      (function next() {
        if (i >= list.length) { resolve('downloaded'); return; }
        var f = list[i++];
        try { downloadBlob(f.blob, f.name); } catch (e) { /* ignore */ }
        setTimeout(next, 350); // 브라우저가 연속 다운로드를 한 번에 막지 않도록 간격을 둔다
      })();
    });
  }
  /** list: [{ name, blob }] → 한 장씩 내려받기(모바일도 공유 시트 대신 다운로드). 결과: 'downloaded' */
  function saveManyFiles(list) { return downloadSequential(list); }
  function galleryFileName(i) {
    var g = ui.gallery[i];
    return safeFile('그림맞추기_' + (state.roomCode || '') + '_' + (i + 1) + '_' + g.word) + '.png';
  }
  /** 게임 갤러리 "모두 저장": 그림마다 PNG 한 장씩 */
  function saveGalleryAll() {
    var items = ui.gallery || [];
    var list = [];
    items.forEach(function (g, i) {
      if (!g.ops.length && g.trimmed) return;
      try { list.push({ name: galleryFileName(i), blob: dataUrlToBlob(galleryItemPng(i)) }); } catch (e) { /* ignore */ }
    });
    if (!list.length) { toast('저장할 그림이 없어요', 'error'); return; }
    saveManyFiles(list).then(function () { toast('그림 ' + list.length + '장을 한 장씩 저장했어요', 'ok'); });
  }
  function openGallery() { if (!ui.gallery || !ui.gallery.length) { toast('아직 갤러리에 담을 그림이 없어요'); return; } preloadWordmarkFont(); ui.galleryOpen = true; renderGallery(); }
  function closeGallery() { ui.galleryOpen = false; renderGallery(); }
  function renderGallery() {
    var m = $('overlay-gallery'); if (!m) return;
    var items = ui.gallery || [];
    m.hidden = !ui.galleryOpen || !items.length;
    var bo = $('btn-gallery-open'); if (bo) bo.hidden = !items.length;
    var bl = $('btn-gallery-lobby'); if (bl) bl.hidden = !(items.length && state.phase === 'lobby');
    if (m.hidden) return;
    var cnt = $('gallery-count'); if (cnt) cnt.textContent = items.length + '장';
    var ga = $('btn-gallery-all'); if (ga) ga.textContent = '모두 저장 (' + items.length + '장)';
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
      var by = el('span', 'gallery-by' + (g.relay ? ' relay' : ''));
      if (g.relay) {
        // 이어 그리기: 공동 작가 "🖍 A·B·C" · 맞히는 사람 "🎯 D 맞힘". 좁으면 말줄임, 전체는 title 로
        card.title = galleryCaption(g);
        if (g.round) by.appendChild(el('span', 'gallery-no', g.round + '번 ·'));
        by.appendChild(el('span', 'gallery-drawer', galleryByText(g)));
        by.appendChild(el('span', 'gallery-guesser' + (g.guessed ? ' got' : ''), galleryGuessText(g)));
      } else {
        if (g.round) by.appendChild(document.createTextNode(g.round + 'R · '));
        by.appendChild(avatarNode(avatarOf(g.drawerId) || { emoji: '✏️', color: '#f3ecff' }, 'gallery-av'));
        by.appendChild(el('span', 'gallery-drawer', g.drawerName));
        by.appendChild(document.createTextNode(' · ' + g.guessed + '명 맞힘'));
      }
      sub.appendChild(by);
      var dl = el('button', 'btn btn-secondary btn-sm', 'PNG 저장'); dl.type = 'button';
      dl.addEventListener('click', function () {
        try { downloadDataUrl(galleryItemPng(i), galleryFileName(i)); }
        catch (e) { toast('이미지를 만들지 못했어요', 'error'); }
      });
      sub.appendChild(dl);
      meta.appendChild(sub);
      card.appendChild(meta);
      grid.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // 그림 보관함(로그인 사용자): 게임이 끝나면 내가 그린 그림을 이미지로 저장(최대 100장). 가득 차면 오래된 그림을 ZIP 으로 받고 바꾼다.
  //   저장한 게임은 이 탭에서 표시해 두어(sessionStorage) 재접속으로 game:over 를 다시 받아도 두 번 저장하지 않는다.
  // ------------------------------------------------------------------
  var MAX_DRAWINGS = 100, SAVED_GAMES_KEY = 'drawguess.savedGames';
  var vault = { rows: null, loading: false, unavailable: false, error: '', loadedAt: 0, viewing: null, busy: false };
  /** 내가 그린 턴(PROTOCOL "로그인"): 이어 그리기는 drawerIds 에 내가 있으면(공동 작품 — 주자마다 각자 보관), 그 밖은 drawerId */
  function myGalleryItems() {
    return (ui.gallery || []).filter(function (g) {
      var mine = g.relay ? g.drawerIds.indexOf(myId) !== -1 : g.drawerId === myId;
      return mine && g.ops && g.ops.length;
    });
  }
  function gallerySig(items) {
    return (state.roomCode || '') + ':' + items.map(function (g) { return g.round + '/' + g.word + '/' + g.ops.length; }).join('|');
  }
  function savedSigs() { try { var a = JSON.parse(sessionStorage.getItem(SAVED_GAMES_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function markSaved(sig) {
    var a = savedSigs().filter(function (x) { return x !== sig; }); a.push(sig);
    try { sessionStorage.setItem(SAVED_GAMES_KEY, JSON.stringify(a.slice(-20))); } catch (e) { /* ignore */ }
  }
  /** ops → 800×600 webp(안 되면 png), 512KB 이하 */
  function drawingBlob(g) {
    var cv = renderOpsToCanvas(g.ops);
    var tries = [['image/webp', 0.9], ['image/webp', 0.75], ['image/webp', 0.6], ['image/png']], i = 0;
    function next() {
      if (i >= tries.length) return Promise.reject(new Error('그림 이미지를 만들지 못했어요'));
      var t = tries[i++];
      return new Promise(function (resolve) { try { cv.toBlob(function (b) { resolve(b); }, t[0], t[1]); } catch (e) { resolve(null); } })
        .then(function (b) { return b && b.type === t[0] && b.size <= 512 * 1024 ? b : next(); });
    }
    return next();
  }
  function saveItems(items) {
    var n = 0;
    return items.reduce(function (p, g) {
      return p.then(function () { return drawingBlob(g); })
        .then(function (blob) { return Account.saveDrawing({ blob: blob, word: g.word, category: g.category || null, round: g.round, guessed: g.guessed }); })
        .then(function () { n++; });
    }, Promise.resolve()).then(function () { vault.rows = null; return n; });
  }
  function saveMyDrawings() {
    if (!acctLoggedIn() || !Account || !Account.saveDrawing || vault.unavailable) return;
    var items = myGalleryItems();
    if (!items.length) return;
    var sig = gallerySig(items);
    if (savedSigs().indexOf(sig) !== -1 || (ui.saveJob && ui.saveJob.sig === sig)) return;
    ui.saveJob = { sig: sig, items: items };
    ui.saveStatus = { kind: 'saving', n: items.length };
    renderResultsSave();
    Account.listDrawingRows()
      .then(function (rows) {
        var free = MAX_DRAWINGS - rows.length;
        if (items.length > free) { ui.saveStatus = { kind: 'full', n: items.length, need: items.length - Math.max(0, free), count: rows.length }; return; }
        return saveItems(items).then(function (n) { markSaved(sig); ui.saveStatus = { kind: 'saved', n: n }; });
      })
      .catch(function (e) { onSaveError(e); })
      .then(renderResultsSave);
  }
  function onSaveError(e) {
    if (e && e.code === 'NO_TABLE') { vault.unavailable = true; ui.saveStatus = null; ui.saveJob = null; return; }
    ui.saveStatus = { kind: 'error', msg: e && e.message ? e.message : '그림을 저장하지 못했어요' };
  }
  function drawingFileName(r, type) {
    var d = r.created_at ? new Date(r.created_at) : new Date(), p2 = function (x) { return (x < 10 ? '0' : '') + x; };
    var stamp = isNaN(d.getTime()) ? '' : d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
    return safeFile('그림맞추기_' + (r.word || '그림') + '_' + stamp) + (type === 'image/png' ? '.png' : '.webp');
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    downloadDataUrl(url, filename);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  /** 행들의 이미지 파일을 받는다 → [{ name, blob, date }]. 파일이 이미 없는 행은 건너뛴다. 그 밖의 실패가 있으면 전체 실패 */
  function fetchDrawingFiles(rows) {
    var failed = 0;
    return Promise.all(rows.map(function (r) {
      return Account.downloadDrawing(r)
        .then(function (b) { return { name: drawingFileName(r, b.type), blob: b, date: r.created_at ? new Date(r.created_at) : new Date() }; })
        .catch(function (e) { if (!/not found/i.test(e && e.message || '')) failed++; return null; });
    })).then(function (files) {
      if (failed) throw new Error('그림을 받지 못했어요. 잠시 후 다시 시도해주세요');
      return files.filter(Boolean);
    });
  }
  /** 행들을 받아 ZIP 한 파일로 저장. 받은 장 수를 돌려준다 */
  function zipDrawings(rows, zipName) {
    if (!window.MiniZip) return Promise.reject(new Error('ZIP 을 만들 수 없어요'));
    return fetchDrawingFiles(rows).then(function (files) {
      if (!files.length) return 0;
      return window.MiniZip.make(files.map(function (f) { return { name: f.name, data: f.blob, date: f.date }; }))
        .then(function (blob) { downloadBlob(blob, zipName); return files.length; });
    });
  }
  /** 내 정보 › 그림 "모두 저장": 파일을 받아 한 장씩 내려받기 */
  function saveAllDrawings() {
    var rows = vault.rows || []; if (!rows.length || vault.busy) return;
    vault.busy = true; renderMeGallery();
    toast('그림 ' + rows.length + '장을 받는 중…');
    fetchDrawingFiles(rows)
      .then(function (list) {
        if (!list.length) { toast('받을 수 있는 그림이 없어요', 'error'); return; }
        return downloadSequential(list).then(function () { toast('그림 ' + list.length + '장을 한 장씩 저장했어요', 'ok'); });
      })
      .catch(function (e) { acctErr(e, '그림을 받지 못했어요'); })
      .then(function () { vault.busy = false; renderMeGallery(); });
  }
  function stampNow() { var d = new Date(), p2 = function (x) { return (x < 10 ? '0' : '') + x; }; return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()); }
  /** 가득 참: 오래된 그림 need 장을 ZIP 으로 받고 지운 뒤 이번 그림 저장 */
  function replaceOldestAndSave() {
    var job = ui.saveJob; if (!job || vault.busy) return;
    vault.busy = true;
    ui.saveStatus = { kind: 'saving', n: job.items.length, note: '오래된 그림을 받는 중…' };
    renderResultsSave();
    var replaced = 0;
    Account.listDrawingRows()
      .then(function (rows) {
        var need = job.items.length - (MAX_DRAWINGS - rows.length);
        var oldest = need > 0 ? rows.slice().sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); }).slice(0, need) : [];
        replaced = oldest.length;
        if (!oldest.length) return null;
        return zipDrawings(oldest, '그림맞추기_보관함_정리_' + stampNow() + '.zip').then(function () { return Account.deleteDrawings(oldest); });
      })
      .then(function () { ui.saveStatus = { kind: 'saving', n: job.items.length }; renderResultsSave(); return saveItems(job.items); })
      .then(function (n) { markSaved(job.sig); ui.saveStatus = { kind: 'saved', n: n, replaced: replaced }; })
      .catch(function (e) { onSaveError(e); })
      .then(function () { vault.busy = false; renderResultsSave(); });
  }
  function skipSave() {
    if (ui.saveJob) markSaved(ui.saveJob.sig);
    ui.saveStatus = { kind: 'skipped' };
    renderResultsSave();
  }
  function renderResultsSave() {
    var box = $('results-save'); if (!box) return;
    var s = inRoom ? ui.saveStatus : null;
    box.hidden = !s;
    if (!s) { box.innerHTML = ''; box.removeAttribute('data-key'); return; }
    var key = JSON.stringify(s);
    if (box.getAttribute('data-key') === key) return;
    box.setAttribute('data-key', key);
    box.className = 'results-save rs-' + s.kind;
    box.innerHTML = '';
    var btn = function (label, cls, fn) { var b = el('button', 'btn btn-sm ' + cls, label); b.type = 'button'; b.addEventListener('click', fn); return b; };
    if (s.kind === 'saving') box.appendChild(el('span', 'rs-text', s.note || ('내 그림 ' + s.n + '장을 보관함에 저장하는 중…')));
    else if (s.kind === 'saved') box.appendChild(el('span', 'rs-text', '✅ 내 그림 ' + s.n + '장을 보관함에 저장했어요' + (s.replaced ? ' (오래된 ' + s.replaced + '장은 받아 두고 정리했어요)' : '') + '. 내 정보 › 그림에서 볼 수 있어요'));
    else if (s.kind === 'skipped') box.appendChild(el('span', 'rs-text', '이번 그림은 보관함에 저장하지 않았어요'));
    else if (s.kind === 'error') {
      box.appendChild(el('span', 'rs-text', '그림을 저장하지 못했어요: ' + s.msg));
      var acts0 = el('div', 'rs-actions');
      acts0.appendChild(btn('다시 시도', 'btn-outline', function () { if (ui.saveJob) { var sig = ui.saveJob.sig; ui.saveJob = null; if (savedSigs().indexOf(sig) === -1) saveMyDrawings(); } }));
      box.appendChild(acts0);
    } else if (s.kind === 'full') {
      box.appendChild(el('span', 'rs-text', '보관함이 가득 찼어요 (' + s.count + '/' + MAX_DRAWINGS + '장). 이번 그림 ' + s.n + '장을 저장하려면 오래된 그림 ' + s.need + '장을 정리해야 해요.'));
      var acts = el('div', 'rs-actions');
      acts.appendChild(btn('오래된 ' + s.need + '장 받고 바꾸기', 'btn-primary', replaceOldestAndSave));
      acts.appendChild(btn('저장 안 함', 'btn-ghost', skipSave));
      box.appendChild(acts);
    }
  }

  // 내 정보 › 그림 탭
  function loadDrawings(force) {
    if (!acctLoggedIn() || !Account || !Account.listDrawings || vault.loading) return;
    if (!force && vault.rows && Date.now() - vault.loadedAt < 45 * 60 * 1000) return; // 서명 URL 은 1시간
    vault.loading = true; vault.error = '';
    renderMeGallery();
    Account.listDrawings()
      .then(function (rows) { vault.rows = rows; vault.loadedAt = Date.now(); vault.unavailable = false; })
      .catch(function (e) { if (e && e.code === 'NO_TABLE') vault.unavailable = true; else vault.error = e && e.message ? e.message : '그림을 불러오지 못했어요'; })
      .then(function () { vault.loading = false; renderMeGallery(); });
  }
  function drawingSub(r) {
    return [fmtDate(r.created_at), r.category, typeof r.guessed === 'number' ? r.guessed + '명 맞힘' : ''].filter(Boolean).join(' · ');
  }
  function renderMeGallery() {
    if (landing.step !== 'me' || meTab() !== 'gallery' || inRoom) return;
    if (!vault.rows && !vault.loading && !vault.unavailable && !vault.error) { loadDrawings(); return; }
    var rows = vault.rows || [], n = rows.length;
    var show = function (id, on) { var e = $(id); if (e) e.hidden = !on; };
    show('drawings-loading', vault.loading && !vault.rows);
    show('drawings-unavailable', vault.unavailable);
    show('drawings-error', !!vault.error);
    var er = $('drawings-error'); if (er) er.textContent = vault.error || '';
    show('drawings-empty', !!vault.rows && !n && !vault.unavailable);
    show('drawings-full', n >= MAX_DRAWINGS);
    var cnt = $('drawings-count'); if (cnt) cnt.textContent = vault.rows && !vault.unavailable ? n + ' / ' + MAX_DRAWINGS : '';
    var zb = $('btn-drawings-zip'); if (zb) { zb.hidden = !n || vault.unavailable; zb.disabled = vault.busy; }
    var ab = $('btn-drawings-all');
    if (ab) {
      ab.hidden = !n || vault.unavailable; ab.disabled = vault.busy;
      ab.textContent = vault.busy ? '받는 중…' : '모두 저장';
    }
    var grid = $('drawings-grid'); if (!grid) return;
    var key = vault.unavailable ? '' : rows.map(function (r) { return r.id + ':' + (r.url ? 1 : 0); }).join('|');
    if (grid.getAttribute('data-key') === key) return;
    grid.setAttribute('data-key', key);
    grid.innerHTML = '';
    if (vault.unavailable) return;
    rows.forEach(function (r) {
      var li = el('li', 'drawing-item'); li.setAttribute('data-id', String(r.id));
      var th = el('button', 'drawing-thumb'); th.type = 'button'; th.setAttribute('aria-label', r.word + ' 그림 크게 보기');
      if (r.url) { var img = document.createElement('img'); img.src = r.url; img.alt = r.word + ' 그림'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; th.appendChild(img); }
      else th.appendChild(el('span', 'dt-missing', '이미지를 불러오지 못했어요'));
      th.addEventListener('click', function () { openDrawing(r); });
      li.appendChild(th);
      var meta = el('div', 'drawing-meta');
      meta.appendChild(el('strong', 'drawing-word', r.word));
      meta.appendChild(el('span', 'drawing-sub', drawingSub(r)));
      li.appendChild(meta);
      var acts = el('div', 'drawing-actions');
      var dl = el('button', 'btn btn-ghost btn-sm dr-download', '받기'); dl.type = 'button'; dl.addEventListener('click', function () { downloadDrawingRow(r); });
      var rm = el('button', 'btn btn-ghost btn-sm dr-delete', '삭제'); rm.type = 'button'; rm.addEventListener('click', function () { deleteDrawingRow(r); });
      acts.appendChild(dl); acts.appendChild(rm);
      li.appendChild(acts);
      grid.appendChild(li);
    });
  }
  function downloadDrawingRow(r) {
    Account.downloadDrawing(r).then(function (b) { downloadBlob(b, drawingFileName(r, b.type)); })
      .catch(function (e) { acctErr(e, '그림을 받지 못했어요'); });
  }
  function deleteDrawingRow(r) {
    if (!window.confirm('"' + r.word + '" 그림을 지울까요? 되돌릴 수 없어요.')) return;
    Account.deleteDrawings([r])
      .then(function () {
        toast('그림을 지웠어요', 'ok');
        if (vault.rows) vault.rows = vault.rows.filter(function (x) { return x.id !== r.id; });
        if (vault.viewing && vault.viewing.id === r.id) closeDrawing();
        renderMeGallery();
      })
      .catch(function (e) { acctErr(e, '그림을 지우지 못했어요'); });
  }
  function downloadAllDrawings() {
    var rows = vault.rows || []; if (!rows.length || vault.busy) return;
    vault.busy = true; renderMeGallery();
    toast('그림 ' + rows.length + '장을 모으는 중…');
    zipDrawings(rows, '그림맞추기_보관함_' + stampNow() + '.zip')
      .then(function (n) { if (n) toast('그림 ' + n + '장을 ZIP 으로 받았어요', 'ok'); })
      .catch(function (e) { acctErr(e, 'ZIP 을 만들지 못했어요'); })
      .then(function () { vault.busy = false; renderMeGallery(); });
  }
  function openDrawing(r) {
    var m = $('overlay-drawing'); if (!m) return;
    vault.viewing = r;
    var img = $('dv-img'); if (img) { img.src = r.url || ''; img.alt = r.word + ' 그림'; }
    var w = $('dv-word'); if (w) w.textContent = r.word;
    var meta = $('dv-meta'); if (meta) meta.textContent = drawingSub(r);
    m.hidden = false;
  }
  function closeDrawing() { vault.viewing = null; var m = $('overlay-drawing'); if (m) m.hidden = true; }

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
      if (ui.legTimeLeft != null && ui.legTimeLeft > 0) ui.legTimeLeft--;
      applyTimeLeft(ui.timeLeft - 1); renderTimers(); pushWordState(); armLocalTick(1000);
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
    // 이어 그리기: 구간 남은 시간은 상단 띠(데스크톱) · 턴 띠(모바일)에 있다
    if (inRelay()) { renderRelayBand(); renderTurnStrip(); }
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function renderAll() {
    // 모바일 CSS가 단계/역할별로 레이아웃을 바꿀 수 있도록 루트에 표시한다 (JS 레이아웃 코드 없이 CSS만으로 전환)
    var vr = $('view-room');
    if (vr) { vr.setAttribute('data-phase', state.phase); vr.setAttribute('data-role', drawerLayout() ? 'drawer' : 'guesser'); vr.setAttribute('data-tablet', isTabletPortrait() ? '1' : '0'); }
    placeMobileChrome();
    if (roomProfile.open && !roomProfile.formless && (!inRoom || state.phase !== 'lobby')) { closeRoomProfile(); if (inRoom) toast('게임이 시작돼 프로필 수정을 닫았어요'); }
    renderTopbar(); renderPlayers(); renderCenter(); renderOverlays(); renderTimers(); renderChatInput(); renderGallery(); renderResultsSave(); renderChatPeek(); renderAccount();
    pushWordState();
    maybeReloadForUpdate();
  }

  function canEndGame() { return inRoom && isHost() && (state.phase === 'choosing' || state.phase === 'drawing' || state.phase === 'turnEnd'); }
  /** 방송 모드(방장 설정): 방 코드·주소·출제자 단어를 화면에서 가린다. 눌러야 잠깐 보인다 */
  function streamer() { return !!prefs.streamerMode; }
  function revealRoomCode() {
    if (!streamer()) return;
    ui.codeRevealUntil = Date.now() + 4000; renderTopbar();
    setTimeout(renderTopbar, 4100);
  }
  // ---------- 방송 모드 단어 창: window.open + BroadcastChannel. 메인 화면에는 단어를 아예 그리지 않는다 ----------
  function desktopStreamer() { return streamer() && !mobileMq.matches; }
  function wordWindowOpen() { return !!(ui.wordWin && !ui.wordWin.closed); }
  function wordWindowState() {
    return {
      type: 'state', inRoom: inRoom, streamer: streamer(), phase: state.phase, isDrawer: isDrawer() || showsWord(), // relay 지난 주자도 제시어를 계속 본다
      options: isDrawer() && state.phase === 'choosing' && ui.wordOptions ? ui.wordOptions.slice() : null,
      chosen: ui.chosenWord || null, word: showsWord() && state.phase === 'drawing' ? ui.word : null, category: ui.category || null,
      relayPick: inRelay() ? { picks: ui.relayPicks.slice(), max: RELAY_PICK } : null, // 이어 그리기: 후보 중 2개 고르기(고른 순서)
      answer: state.phase === 'turnEnd' && ui.turnEnd ? ui.turnEnd.word : null,
      drawerName: playerName(state.drawerId, ui.drawerName || ''), timeLeft: ui.timeLeft,
    };
  }
  function pushWordState() { if (ui.wordChan) { try { ui.wordChan.postMessage(wordWindowState()); } catch (e) { /* ignore */ } } }
  function openWordWindow() {
    if (wordWindowOpen()) { try { ui.wordWin.focus(); } catch (e) { /* ignore */ } return; }
    var key = randomToken();
    var win = null;
    try { win = window.open('/word#' + key, 'dg-word', 'popup=yes,width=380,height=280'); } catch (e) { win = null; }
    if (!win) { toast('팝업이 차단됐어요. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요', 'error'); return; }
    closeWordChannel();
    ui.wordWin = win; ui.wordKey = key;
    if (window.BroadcastChannel) {
      ui.wordChan = new BroadcastChannel('drawguess-word-' + key);
      ui.wordChan.onmessage = function (e) {
        var m = e.data; if (!m || typeof m !== 'object') return;
        if (m.type === 'hello') pushWordState();
        else if (m.type === 'choose' && typeof m.word === 'string') chooseWord(m.word);
        else if (m.type === 'pick' && typeof m.word === 'string') toggleRelayPick(m.word);
        else if (m.type === 'submitPicks') submitRelayPicks();
      };
    }
    toast('단어 창을 열었어요. 방송 캡처 밖으로 옮겨 두세요', 'ok');
    if (ui.wordWatch) clearInterval(ui.wordWatch);
    ui.wordWatch = setInterval(function () {
      if (wordWindowOpen()) return;
      clearInterval(ui.wordWatch); ui.wordWatch = null;
      ui.wordWin = null; ui.wordKey = ''; closeWordChannel();
      renderAll(); // 후보 선택 중이었으면 "단어 창 열기" · "여기서 보기"가 다시 나온다
    }, 500);
    renderAll();
  }
  function closeWordChannel() { if (ui.wordChan) { try { ui.wordChan.close(); } catch (e) { /* ignore */ } ui.wordChan = null; } }
  function closeWordWindow() {
    if (ui.wordWatch) { clearInterval(ui.wordWatch); ui.wordWatch = null; }
    if (ui.wordChan) { try { ui.wordChan.postMessage({ type: 'bye' }); } catch (e) { /* ignore */ } }
    if (ui.wordWin && !ui.wordWin.closed) { try { ui.wordWin.close(); } catch (e) { /* ignore */ } }
    ui.wordWin = null; ui.wordKey = ''; closeWordChannel();
  }
  /** 출제자가 단어를 고른다(메인 화면 버튼 · 단어 창 공용) */
  function chooseWord(w) {
    if (inRelay()) { toggleRelayPick(w); return; } // 이어 그리기는 2개를 골라 "이 두 개로 그리기"
    if (ui.chosenWord || !isDrawer() || state.phase !== 'choosing' || !ui.wordOptions || ui.wordOptions.indexOf(w) < 0) return;
    ui.chosenWord = w; emit('word:choose', { word: w });
    renderAll();
  }
  // ---- 이어 그리기: 첫 주자가 단어 후보 중 2개를 골라 제시어 "A · B"(고른 순서)를 만든다 ----
  function canPickRelay() { return inRelay() && !ui.chosenWord && isDrawer() && state.phase === 'choosing' && !!ui.wordOptions; }
  function resetRelayPicks() {
    ui.relayPicks = [];
    if (ui.relayAutoTimer) { clearTimeout(ui.relayAutoTimer); ui.relayAutoTimer = null; }
  }
  /** 누르면 선택, 다시 누르면 해제. 이미 2개면 먼저 고른 것을 바꾸지 않고 안내만 */
  function toggleRelayPick(w) {
    if (!canPickRelay() || ui.wordOptions.indexOf(w) < 0) return;
    var i = ui.relayPicks.indexOf(w);
    if (i >= 0) ui.relayPicks.splice(i, 1);
    else if (ui.relayPicks.length >= RELAY_PICK) { toast(RELAY_PICK + '개까지 고를 수 있어요. 바꾸려면 고른 걸 한 번 더 눌러 빼 주세요'); return; }
    else ui.relayPicks.push(w);
    renderAll();
  }
  function submitRelayPicks() {
    if (!canPickRelay() || ui.relayPicks.length !== RELAY_PICK) return;
    var words = ui.relayPicks.slice();
    ui.chosenWord = words.join(' · ');
    if (ui.relayAutoTimer) { clearTimeout(ui.relayAutoTimer); ui.relayAutoTimer = null; }
    emit('word:choose', { words: words });
    renderAll();
  }
  /**
   * 시간이 다 돼 가면(남은 1초 표시 + 0.5초) 고른 것 + 남은 후보 앞에서부터 채워 스스로 보낸다.
   * 서버의 시간 초과 자동 선택은 고른 상태를 모르므로 후보 앞 2개 — 이건 그 전에 고른 걸 살리는 장치
   */
  function armRelayAutoPick() {
    if (ui.relayAutoTimer || !canPickRelay() || ui.timeLeft !== 1) return;
    ui.relayAutoTimer = setTimeout(function () {
      ui.relayAutoTimer = null;
      if (!canPickRelay() || !ui.relayPicks.length) return; // 하나도 안 골랐으면 서버가 앞 2개로 정한다
      for (var k = 0; k < ui.wordOptions.length && ui.relayPicks.length < RELAY_PICK; k++) {
        if (ui.relayPicks.indexOf(ui.wordOptions[k]) < 0) ui.relayPicks.push(ui.wordOptions[k]);
      }
      submitRelayPicks();
    }, 500);
  }
  function wordWindowButton() {
    var b = el('button', 'btn btn-sm ' + (wordWindowOpen() ? 'btn-ghost' : 'btn-secondary') + ' btn-word-window', wordWindowOpen() ? '단어 창 열림' : '단어 창 열기');
    b.type = 'button'; b.id = 'btn-word-window'; b.title = '방송 캡처 밖에서 후보와 내 단어를 보는 작은 창';
    b.addEventListener('click', openWordWindow);
    return b;
  }
  function renderTopbar() {
    var rc = $('room-code'), chip = rc ? rc.closest('.room-code-chip') : null;
    var hideCode = streamer() && Date.now() >= ui.codeRevealUntil;
    if (rc) rc.textContent = hideCode ? '••••' : (state.roomCode || '----');
    if (chip) { chip.classList.toggle('hidden-code', hideCode); chip.title = streamer() ? '방송 모드: 눌러서 4초 동안 방 코드 보기' : ''; }
    if (inRoom && ui.streamerWas !== streamer()) { ui.streamerWas = streamer(); pushRoomEntry(); if (!streamer()) closeWordWindow(); } // 방송 모드면 주소에서 ?room= 을 뺀다
    var beg = $('btn-end-game'); if (beg) beg.hidden = !canEndGame();
    if (leaveDialogOpen() && leaveIntent === 'end' && !canEndGame()) closeLeaveDialog(); // 그 사이 게임이 끝났거나 방장이 바뀜
    var ri = $('round-indicator');
    if (ri) {
      if (state.phase === 'lobby') ri.textContent = '대기실';
      else if (state.phase === 'gameOver') ri.textContent = '게임 종료';
      else if (inRelay()) ri.textContent = '문제 ' + (state.round || 1) + ' / ' + (state.totalRounds || '?');
      else ri.textContent = '라운드 ' + (state.round || 1) + ' / ' + (state.totalRounds || state.settings.rounds || '?');
    }
    renderWordArea();
    renderRelayBand();
  }

  /**
   * 이어 그리기 상단 띠(데스크톱. 모바일은 턴 띠가 같은 내용): drawing "🖍 ○○님 (2/3) · 다음 △△님 · 12초", choosing "○○님이 제시어를 고르고 있어요".
   * 문제 전체 남은 시간은 오른쪽 기존 타이머(#timer).
   */
  function renderRelayBand() {
    var rb = $('relay-band'); if (!rb) return;
    var ph = state.phase, r = state.relay;
    var show = inRelay() && (ph === 'drawing' || ph === 'choosing');
    rb.hidden = !show;
    var row = $('relay-row'); if (row) row.hidden = !show;
    renderRelayHint();
    if (!show) { if (rb.childElementCount) rb.innerHTML = ''; return; }
    var dn = playerName(state.drawerId, ui.drawerName || '');
    var key, build;
    if (ph === 'choosing') {
      key = 'c|' + dn + '|' + relayMyTurnNo();
      build = function () { rb.appendChild(el('span', 'rb-who', state.drawerId === myId ? '내가 제시어를 고를 차례예요' : dn + '님이 제시어를 고르고 있어요' + (relayMyTurnNo() ? ' · 나는 ' + relayMyTurnNo() + '번째' : ''))); };
    } else {
      var next = r.order[r.legIndex + 1], nn = next ? playerName(next, '') : '';
      var leg = ui.legTimeLeft;
      key = 'd|' + dn + '|' + r.legIndex + '|' + r.legCount + '|' + nn + '|' + leg;
      build = function () {
        var who = el('span', 'rb-who');
        who.appendChild(document.createTextNode('🖍 '));
        who.appendChild(el('b', null, state.drawerId === myId ? '내 차례' : dn + '님'));
        who.appendChild(document.createTextNode(' (' + (r.legIndex + 1) + '/' + r.legCount + ')'));
        rb.appendChild(who);
        rb.appendChild(el('span', 'rb-sep', '·'));
        rb.appendChild(el('span', 'rb-next', next ? '다음 ' + (next === myId ? '나' : nn + '님') : '마지막'));
        if (leg != null) { rb.appendChild(el('span', 'rb-sep', '·')); rb.appendChild(el('span', 'rb-leg' + (leg <= 5 ? ' urgent' : ''), leg + '초')); }
      };
    }
    if (rb.getAttribute('data-key') === key) return;
    rb.setAttribute('data-key', key); rb.innerHTML = '';
    build();
  }

  // ---- 이어 그리기: 맞히는 사람의 "초성 힌트" 버튼(마스크 아래 · 모바일은 헤더 1행) ----
  var HINT_PENALTY = 25; // 힌트 1회당 정답 점수 −25%(PROTOCOL 점수 절)
  /** 마스크에 아직 안 열린 칸('_')이 있는지 — 다 열렸으면(초성·맞힌 요소) 서버가 무시하므로 버튼을 잠근다 */
  function maskHasHidden(mask) { return String(mask || '').split(' ').some(function (t) { return t === '_'; }); }
  /** { max, used, left } — drawing 중엔 game:drawing/baton/hint 의 hintsUsed·hintsMax, choosing 중엔 설정값 */
  function relayHintState() {
    var max = ui.relayInfo ? num(ui.relayInfo.hintsMax, 0) : num(state.settings.hints, 0);
    var used = ui.relayInfo ? num(ui.relayInfo.hintsUsed, 0) : 0;
    return { max: max, used: used, left: Math.max(0, max - used) };
  }
  function renderRelayHint() {
    var b = $('btn-relay-hint'); if (!b) return;
    var ph = state.phase, hs = relayHintState();
    // choosing 중에도 자리를 지켜 둔다(비활성) — drawing 이 시작될 때 헤더가 출렁이지 않게
    var show = isRelayGuesser() && (ph === 'drawing' || ph === 'choosing') && hs.max > 0;
    b.hidden = !show;
    var tb = document.querySelector('#view-room .topbar'); if (tb) tb.classList.toggle('has-relay-hint', show);
    renderHintTip(show && ph === 'drawing'); // 처음 한 번 안내 말풍선(choosing 중 비활성 버튼에는 안 띄운다)
    if (!show) return;
    b.disabled = !(ph === 'drawing' && hs.left > 0 && !ui.hintPending && maskHasHidden(ui.wordMask));
    var long = hs.left > 0 ? '초성 힌트 (남은 ' + hs.left + '회 · −' + HINT_PENALTY + '%)' : '초성 힌트 (남은 0회)';
    var short = hs.left > 0 ? '힌트 ' + hs.left + ' · −' + HINT_PENALTY + '%' : '힌트 0';
    var ln = $('relay-hint-long'), sn = $('relay-hint-short');
    if (ln && ln.textContent !== long) ln.textContent = long;
    if (sn && sn.textContent !== short) sn.textContent = short;
    b.setAttribute('aria-label', long);
    b.title = (ph === 'choosing' ? '그림이 시작되면 누를 수 있어요. ' : '') + '누르면 아직 안 보이는 글자 하나의 초성이 열려요. 쓸 때마다 정답 점수 −' + HINT_PENALTY + '%'
      + (hs.used ? ' · 지금까지 ' + hs.used + '번(−' + Math.min(100, hs.used * HINT_PENALTY) + '%)' : '');
  }
  function requestRelayHint() {
    hideHintTip();
    var b = $('btn-relay-hint'); if (!b || b.hidden || b.disabled) return;
    emit('hint:request'); // ack 없음 — 응답은 game:hint { wordMask, hintsUsed }
    ui.hintPending = true; // 연타로 두 번 쓰지 않게 응답(또는 2초)까지 잠근다
    if (ui.hintPendingTimer) clearTimeout(ui.hintPendingTimer);
    ui.hintPendingTimer = setTimeout(function () { ui.hintPending = false; ui.hintPendingTimer = null; renderRelayHint(); }, 2000);
    renderRelayHint();
  }
  // ---- 힌트 버튼 안내 말풍선 "여기서 초성 힌트를 볼 수 있어요!" — 계정별 1회(이 브라우저 localStorage: 로그인은 계정 id, 게스트는 'guest') ----
  var HINT_TIP_KEY = 'drawguess.relayHintTip'; // { [userId|'guest']: 처음 띄운 시각 }
  var HINT_TIP_MS = 6000;
  var hintTipMem = {}; // localStorage 를 못 쓰는 브라우저에서도 이 탭에서는 한 번만
  function hintTipOwner() { return acctLoggedIn() && acct.user.id ? String(acct.user.id) : 'guest'; }
  function hintTipMap() {
    try { var m = JSON.parse(localStorage.getItem(HINT_TIP_KEY) || '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? m : {}; } catch (e) { return {}; }
  }
  function renderHintTip(canShow) {
    var tip = $('relay-hint-tip'); if (!tip) return;
    if (!canShow) { hideHintTip(); return; }
    if (tip.hidden) {
      var owner = hintTipOwner();
      if (hintTipMem[owner] || hintTipMap()[owner]) return;
      // 띄우는 순간 기록한다(새로고침·다음 게임에서는 다시 안 뜬다)
      hintTipMem[owner] = true;
      var m = hintTipMap(); m[owner] = Date.now();
      try { localStorage.setItem(HINT_TIP_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
      tip.hidden = false;
      if (ui.hintTipTimer) clearTimeout(ui.hintTipTimer);
      ui.hintTipTimer = setTimeout(hideHintTip, HINT_TIP_MS);
    }
    placeHintTip();
  }
  function hideHintTip() {
    if (ui.hintTipTimer) { clearTimeout(ui.hintTipTimer); ui.hintTipTimer = null; }
    var tip = $('relay-hint-tip'); if (tip && !tip.hidden) tip.hidden = true;
  }
  /** 버튼 바로 아래 가운데, 화면 좌우 8px 안으로. 꼬리는 버튼 가운데를 가리킨다 */
  function placeHintTip() {
    var tip = $('relay-hint-tip'), b = $('btn-relay-hint'); if (!tip || tip.hidden || !b) return;
    var r = b.getBoundingClientRect(); if (!r.width) return;
    var vw = document.documentElement.clientWidth || window.innerWidth, w = tip.offsetWidth, pad = 8;
    var cx = r.left + r.width / 2, left = Math.max(pad, Math.min(vw - w - pad, cx - w / 2));
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(r.bottom + 9) + 'px';
    tip.style.setProperty('--arrow-x', Math.round(Math.max(14, Math.min(w - 14, cx - left))) + 'px');
  }
  function clearHintPending() {
    ui.hintPending = false;
    if (ui.hintPendingTimer) { clearTimeout(ui.hintPendingTimer); ui.hintPendingTimer = null; }
  }

  function renderWordArea() {
    var wa = $('word-area'); if (!wa) return;
    wa.innerHTML = '';
    var ph = state.phase;
    var relay = inRelay();
    if (ph === 'choosing') {
      wa.appendChild(el('span', 'word-hint', isDrawer() ? (relay ? '제시어를 골라주세요!' : '단어를 골라주세요!') : (relay ? '제시어를 고르고 있어요…' : '단어를 고르고 있어요…')));
    } else if (ph === 'drawing') {
      if (showsWord() && desktopStreamer() && wordWindowOpen()) {
        // 단어 창이 열려 있으면 메인 화면에는 단어를 아예 그리지 않는다(방송 캡처에 안 나가게)
        wa.appendChild(el('span', 'word-hint', '내 단어는 단어 창에서'));
        wa.appendChild(wordWindowButton());
      } else if (showsWord()) {
        var s = el('span', 'word-secret' + (relay ? ' relay-word' : '')); s.appendChild(el('span', 'label', relay ? '제시어' : '내 단어')); s.appendChild(el('span', 'word', ui.word));
        if (ui.category) s.appendChild(el('span', 'word-category', ui.category));
        if (streamer()) {
          // 방송 화면에 단어가 그대로 나가지 않게 흐리게. 누르면 보이고 다시 누르면 가린다
          s.classList.add('peekable'); s.classList.toggle('peek', !!ui.wordPeek);
          s.appendChild(el('span', 'peek-hint', ui.wordPeek ? '눌러서 가리기' : '눌러서 보기'));
          s.setAttribute('role', 'button'); s.tabIndex = 0;
          s.addEventListener('click', function () { ui.wordPeek = !ui.wordPeek; renderWordArea(); });
        }
        wa.appendChild(s);
        if (desktopStreamer()) wa.appendChild(wordWindowButton());
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
    } else if (ph === 'lobby' && desktopStreamer()) {
      wa.appendChild(wordWindowButton()); // 게임 전에 미리 열어 두라고
    }
  }

  // wordMask: 글자 사이 공백 1개, 단어 사이 공백 3개 → 토큰 분해 (빈 토큰 = 단어 경계)
  // 이어 그리기 조합 마스크는 요소 사이에 ' · ' 가 있다(예 '_ _ _ · _ _'). 요소마다 묶음(.mask-part)으로 만들어 좁은 화면에서는 요소 단위로 줄바꿈
  var PART_SEP = ' · ';
  /**
   * 조합 마스크의 요소별 "맞힘" 여부. 맞힌 요소는 서버가 글자 그대로 보낸다(본인만). 초성 힌트는 자모(ㄱ~ㅎ)라
   * 칸이 모두 열려 있고 자모가 하나도 없으면 맞힌 요소다(영문·숫자 요소는 힌트로 글자 수−1 까지만 열리므로 다 열렸으면 맞힌 것)
   */
  function solvedParts(mask) {
    return String(mask || '').split(PART_SEP).map(function (part) {
      var t = part.split(' ').filter(function (x) { return x !== ''; });
      return t.length > 0 && t.every(function (x) { return x !== '_' && !/[ㄱ-ㆎ]/.test(x); });
    });
  }
  function maskNode(mask, wordLength) {
    var wrap = el('span', 'mask-wrap');
    var m = el('span', 'mask');
    var parts = String(mask).split(PART_SEP);
    var multi = parts.length > 1;
    var boxes = 0, words = 1;
    var solved = multi ? solvedParts(mask) : [];
    var flash = ui.solvedFlash && Date.now() < ui.solvedFlash.until ? ui.solvedFlash.idx : null;
    parts.forEach(function (part, pi) {
      var holder = m;
      if (multi) {
        if (pi > 0) m.appendChild(el('span', 'mask-sep', '·'));
        // 맞힌 요소는 초록으로, 방금 맞혔으면 한 번 튀어 오른다
        holder = el('span', 'mask-part' + (solved[pi] ? ' solved' : '') + (solved[pi] && flash && flash[pi] ? ' just-solved' : '')); m.appendChild(holder);
      }
      var tokens = part.split(' ');
      var gapPending = false, partBoxes = 0;
      for (var i = 0; i < tokens.length; i++) {
        var t = tokens[i];
        if (t === '') { if (partBoxes) gapPending = true; continue; }
        if (gapPending) { holder.appendChild(el('span', 'mask-gap')); gapPending = false; if (!multi) words++; }
        var box = el('span', 'mask-box' + (t === '_' ? '' : ' revealed'), t === '_' ? '' : t);
        holder.appendChild(box); boxes++; partBoxes++;
      }
    });
    wrap.appendChild(m);
    var len = multi ? boxes : (wordLength || boxes);
    // 모바일 CSS 가 글자 수에 따라 칸 크기를 줄일 수 있게 표시한다 (≤8 s, 9~14 m, 15+ l)
    wrap.setAttribute('data-len', String(boxes));
    wrap.setAttribute('data-size', boxes <= 8 ? 's' : boxes <= 14 ? 'm' : 'l');
    if (multi) { wrap.classList.add('mask-combo'); wrap.appendChild(el('span', 'mask-len', '(' + parts.length + '개 조합 · ' + len + '글자)')); }
    else if (len) wrap.appendChild(el('span', 'mask-len', '(' + len + '글자' + (words > 1 ? ' · ' + words + '단어' : '') + ')'));
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
      // 이어 그리기: 맞히는 사람 🎯, 이번 문제 주자 🖍(현재 주자는 기존 출제자 강조)
      var relayG = inRelay() && state.relay.guesserId === p.id, relayR = inRelay() && !isDr && state.relay.order.indexOf(p.id) !== -1;
      var li = el('li', 'player' + (isMe ? ' me' : '') + (p.hasGuessed ? ' guessed' : '') + (isDr ? ' drawing' : '') + (isNext ? ' next' : '') + (relayG ? ' relay-guesser' : '') + (p.connected === false ? ' offline' : ''));
      li.setAttribute('data-id', p.id);
      li.appendChild(el('span', 'rank', '#' + rank));
      var av = avatarNode(p.avatar);
      if (isDr) av.appendChild(el('span', 'badge-drawer', '✏️'));
      else if (relayG) { var bg = el('span', 'badge-drawer badge-guesser', '🎯'); bg.title = '맞히는 사람'; av.appendChild(bg); }
      else if (isNext) av.appendChild(el('span', 'badge-next', '⏭'));
      li.appendChild(av);
      var info = el('span', 'pinfo');
      var name = el('span', 'pname');
      name.appendChild(document.createTextNode(p.name));
      if (isMe) { name.appendChild(document.createTextNode(' ')); name.appendChild(el('span', 'me-tag', '(나)')); }
      if (p.id === state.hostId) { name.appendChild(document.createTextNode(' ')); var crown = el('span', 'host-tag', '👑'); crown.title = '호스트'; name.appendChild(crown); }
      if (relayR && !isNext) { name.appendChild(document.createTextNode(' ')); var rt = el('span', 'runner-tag', '🖍'); rt.title = '이번 문제 주자'; name.appendChild(rt); }
      if (isNext) { name.appendChild(document.createTextNode(' ')); var nt = el('span', 'next-tag', '다음 차례'); nt.title = inRelay() ? '다음 구간에 이어 그릴 차례예요' : '다음 턴에 그릴 차례예요'; name.appendChild(nt); }
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
    var dav = avatarOf(state.drawerId);
    if (inRelay()) { renderRelayStrip(t, dn, dav, sep); return; }
    if (state.phase === 'turnEnd') { t.appendChild(document.createTextNode('⏳ ')); t.appendChild(el('b', null, dn)); t.appendChild(document.createTextNode(' 턴 종료')); }
    else {
      if (dav) t.appendChild(avatarNode(dav, 'ts-av')); else t.appendChild(document.createTextNode('✏️ '));
      t.appendChild(el('b', null, dn + (state.drawerId === myId ? '(나)' : '')));
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
  /** 이어 그리기 턴 띠(모바일): "🖍 민수님 (1/2) · 다음 지은님 · 12초" / choosing "민수님이 제시어 고르는 중" / turnEnd "⏳ 문제 끝" */
  function renderRelayStrip(t, dn, dav, sep) {
    var r = state.relay, me = state.drawerId === myId;
    if (state.phase === 'turnEnd') { t.appendChild(document.createTextNode('⏳ 문제 ' + (state.round || 1) + ' 끝')); return; }
    if (dav) t.appendChild(avatarNode(dav, 'ts-av')); else t.appendChild(document.createTextNode('🖍 '));
    if (state.phase === 'choosing') {
      t.appendChild(el('b', null, me ? '내가' : dn + '님이'));
      t.appendChild(document.createTextNode(' 제시어 고르는 중'));
      return;
    }
    t.appendChild(el('b', null, me ? '내 차례' : dn + '님'));
    t.appendChild(document.createTextNode(' (' + (r.legIndex + 1) + '/' + r.legCount + ')'));
    var next = r.order[r.legIndex + 1];
    sep(); t.appendChild(el('span', 'ts-muted', next ? '다음 ' + (next === myId ? '나' : playerName(next, '') + '님') : '마지막'));
    if (ui.legTimeLeft != null) { sep(); t.appendChild(el('span', 'ts-leg' + (ui.legTimeLeft <= 5 ? ' urgent' : ''), ui.legTimeLeft + '초')); }
  }
  /** 모바일 가로 스크롤 플레이어 띠: 오른쪽에 더 있으면 패널에 .has-more 를 붙여 CSS 페이드로 힌트를 준다 */
  function updatePlayerStripFade() {
    var list = $('player-list'); var panel = list && list.parentNode; if (!panel || !panel.classList) return;
    var more = list.scrollWidth - list.clientWidth - list.scrollLeft > 4;
    panel.classList.toggle('has-more', more);
  }

  function renderCenter() {
    requestAnimationFrame(function () { fitDrawerCanvas(); fitTabletCanvas(); }); // 레이아웃 확정 후 캔버스 크기 맞춤(모바일 출제자 · 가로 태블릿)
    var lobby = state.phase === 'lobby';
    var sp = $('settings-panel'), mp = $('mode-panel'), cw = $('canvas-wrap'), tb = $('toolbar'), ds = $('draw-status');
    if (mp) mp.hidden = !(lobby && state.lobbyStep === 'mode');
    if (sp) sp.hidden = !(lobby && state.lobbyStep !== 'mode');
    if (cw) cw.hidden = lobby;
    var drawer = drawerLayout(); // relay 주자는 차례가 아니어도 그리기 배치(툴바는 잠김)
    if (tb) { tb.hidden = lobby || !drawer; tb.setAttribute('aria-disabled', canDraw() ? 'false' : 'true'); }
    renderToolbarLock();
    if (ds) {
      ds.hidden = lobby || drawer || state.phase === 'gameOver';
      if (!ds.hidden) {
        var dn = playerName(state.drawerId, ui.drawerName || '출제자');
        var dp = findPlayer(state.drawerId);
        var drawerAway = dp && dp.connected === false && (state.phase === 'drawing' || state.phase === 'choosing');
        var txt = drawerAway ? '📶 ' + dn + '님 연결을 기다리고 있어요'
          : inRelay() ? relayStatusText(dn)
          : state.phase === 'drawing' ? '✏️ ' + dn + '님이 그리고 있어요'
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

  /** 이어 그리기 상태 띠(맞히는 사람·관전자): "🖍 ○○님이 이어 그리는 중" / choosing "○○님이 제시어를 고르고 있어요" */
  function relayStatusText(dn) {
    var ph = state.phase;
    if (ph === 'turnEnd') return '⏳ 다음 문제를 준비하고 있어요';
    return ph === 'choosing' ? dn + '님이 제시어를 고르고 있어요' : '🖍 ' + dn + '님이 이어 그리는 중';
  }

  /** 이어 그리기 choosing 중 첫 주자가 아닌 주자의 순번(n번째). 해당 없으면 0 — drawing 의 "나는 n번째"와 같은 계산(order 위치 + 1) */
  function relayMyTurnNo() {
    if (!inRelay() || !state.relay || state.phase !== 'choosing' || !isRunner() || isDrawer()) return 0;
    var i = state.relay.order.indexOf(myId);
    return i > 0 ? i + 1 : 0;
  }

  /** 이어 그리기: 차례가 아닌 주자의 툴바에 잠김 표시 "🔒 ○○님 차례예요" */
  function renderToolbarLock() {
    var tb = $('toolbar'), lk = $('toolbar-lock'); if (!tb || !lk) return;
    var r = state.relay, locked = isRunner() && !isDrawer() && (state.phase === 'drawing' || state.phase === 'choosing');
    tb.classList.toggle('relay-locked', locked);
    lk.hidden = !locked;
    if (!locked) return;
    var dn = playerName(state.drawerId, ui.drawerName || ''), mine = r.order.indexOf(myId);
    lk.textContent = state.phase === 'choosing' ? '🔒 ' + dn + '님이 제시어를 고르고 있어요' + (relayMyTurnNo() ? ' · 나는 ' + relayMyTurnNo() + '번째' : '')
      : mine > r.legIndex ? '🔒 ' + dn + '님 차례예요 · 나는 ' + (mine + 1) + '번째'
      : '🔒 ' + dn + '님이 이어 그리는 중';
  }

  function renderModePanel() {
    var mp = $('mode-panel'); if (!mp) return;
    var host = isHost();
    // 이어 그리기 카드도 인원과 상관없이 방장이 고를 수 있다. 인원이 안 맞으면 설정 화면의 시작 버튼만 잠기고 안내가 나온다
    mp.querySelectorAll('.mode-card').forEach(function (b) {
      var mode = b.getAttribute('data-mode');
      b.classList.toggle('selected', mode === state.settings.mode);
      b.disabled = !host;
      if (mode === 'relay') {
        var meta = b.querySelector('.mode-meta');
        if (meta) meta.textContent = '함께 한 그림 · ' + relayMin() + '~' + RELAY_MAX + '명';
      }
    });
    var hint = $('mode-hint');
    if (hint) hint.textContent = host ? '어떤 방식으로 놀지 골라주세요. 고르면 게임 설정으로 넘어가요.' : '호스트가 게임 모드를 고르고 있어요…';
  }

  /** 단어 후보 수 목록: relay 3~8, 그 밖 2~5. 범위가 바뀔 때만 다시 만든다 */
  function fillWordCountSelect(mode) {
    var sel = $('set-wordCount'); if (!sel) return;
    var rg = wordCountRange(mode), key = rg.join('-');
    if (sel.getAttribute('data-range') === key) return;
    sel.setAttribute('data-range', key);
    var vals = []; for (var v = rg[0]; v <= rg[1]; v++) vals.push(v);
    fillSelect('set-wordCount', vals, function (x) { return x + '개'; });
  }
  function renderSettings() {
    var s = state.settings, editable = isHost() && state.phase === 'lobby';
    function setVal(id, v) {
      var n = $(id); if (!n) return;
      if (document.activeElement === n && editable) return; // 입력 중엔 덮어쓰지 않음
      if (n.type === 'checkbox') n.checked = !!v; else n.value = String(v);
    }
    fillWordCountSelect(s.mode);
    setVal('set-rounds', s.rounds); setVal('set-drawTime', s.drawTime); setVal('set-wordCount', s.wordCount);
    setVal('set-hints', s.hints); setVal('set-hintEndAt', s.hintEndAt);
    setVal('set-customWords', s.customWords || ''); setVal('set-customWordsOnly', s.customWordsOnly);
    var fixed = s.mode === 'fixed';
    // 게임 길이 · 예상 시간 · 우리만의 단어 · 요약(방장이 아닌 사람)
    var preset = matchPreset(s), ps = presetsFor(s.mode), est = estimateGame(s);
    document.querySelectorAll('#preset-row .preset-btn').forEach(function (b) {
      var k = b.getAttribute('data-preset'), p = ps[k];
      b.setAttribute('aria-checked', k === preset ? 'true' : 'false');
      b.disabled = !editable;
      var sub = b.querySelector('.preset-sub'); if (sub && p) sub.textContent = presetSub(s.mode, p);
    });
    var relay = s.mode === 'relay';
    var estEl = $('settings-estimate');
    if (estEl) estEl.textContent = (relay ? est.players + (est.below ? '명 기준 · ' : '명 · ') + est.turns + '문제' : fixed ? s.rounds + '문제' : est.players + '명 × ' + s.rounds + '라운드') + ' · 최대 약 ' + est.minutes + '분';
    var dn = $('details-note'); if (dn) dn.textContent = preset ? '' : '직접 설정함';
    var hostView = $('settings-host'), sum = $('settings-summary');
    if (hostView) hostView.hidden = !isHost();
    if (sum) {
      sum.hidden = isHost();
      if (!sum.hidden) {
        var cw = parseWords(s.customWords || '').words.length;
        var chips = relay
          ? [[preset ? PRESET_NAMES[preset] : '직접 설정', 'sum-main'], [est.turns + '문제'], ['한 명당 ' + s.drawTime + '초'], [s.hints ? '힌트 최대 ' + s.hints + '번' : '힌트 없음'], ['최대 약 ' + est.minutes + '분']]
          : [[preset ? PRESET_NAMES[preset] : '직접 설정', 'sum-main'], [fixed ? s.rounds + '문제' : s.rounds + '라운드'], ['한 턴 ' + s.drawTime + '초'],
            [s.mode === 'blitz' ? '힌트 없음' : s.hints ? '힌트 ' + s.hints + '번' : '힌트 없음'], ['최대 약 ' + est.minutes + '분']];
        var cwList = cw ? parseWords(s.customWords || '').words : [];
        var sumCats = Array.isArray(s.categories) ? s.categories : [];
        // 우리 단어만 쓰기라도 단어가 wordCount 미만이면 고른 카테고리에서 채우므로(server/words.js pickWords) 칩을 보여준다
        if (sumCats.length && !(s.customWordsOnly && cwList.length >= s.wordCount)) chips.push([sumCats.length <= 3 ? sumCats.join(' · ') : '카테고리 ' + sumCats.length + '개']);
        var skey = JSON.stringify([chips, cwList, !!s.customWordsOnly]);
        if (sum.getAttribute('data-key') !== skey) {
          sum.setAttribute('data-key', skey); sum.innerHTML = '';
          var chipRow = el('div', 'sum-chips');
          chips.forEach(function (c0) { chipRow.appendChild(el('span', 'sum-chip' + (c0[1] ? ' ' + c0[1] : ''), c0[0])); });
          sum.appendChild(chipRow);
          if (cwList.length) {
            var box = el('div', 'sum-words');
            box.appendChild(el('div', 'sum-words-title', '우리만의 단어 ' + cwList.length + '개' + (!s.customWordsOnly ? ' · 기본 단어와 섞어서 출제' : cwList.length >= s.wordCount ? ' · 우리 단어로만 출제' : ' · 우리 단어로 출제 · 모자라면 고른 카테고리에서 채워요')));
            var wl = el('div', 'sum-words-list');
            cwList.forEach(function (w) { wl.appendChild(el('span', 'sum-word', w)); });
            box.appendChild(wl);
            sum.appendChild(box);
          }
        }
      }
    }
    var uc = $('set-useCustom'), cb0 = $('custom-body');
    var hasWords = !!String(s.customWords || '').trim();
    if (uc) { if (!ui.customOpen && hasWords) ui.customOpen = true; uc.checked = !!ui.customOpen; uc.disabled = !editable; }
    if (cb0) cb0.hidden = !ui.customOpen;
    var wsl = $('wordset-share'); if (wsl) wsl.hidden = !hasWords || !editable;
    // 기본 단어 카테고리 칩. 우리 단어만 쓰고 단어가 wordCount 이상이면 기본 단어가 안 나오므로 숨긴다(모자라면 고른 카테고리에서 채우니 보여준다)
    var cats = selectedCategories(), catBlock = $('cat-block');
    if (catBlock) {
      catBlock.hidden = !!(s.customWordsOnly && hasWords && parseWords(s.customWords || '').words.length >= s.wordCount);
      var allOn = cats.length === CATEGORY_NAMES.length;
      var cn = $('cat-note'); if (cn) cn.textContent = allOn ? '전체 ' + CATEGORY_NAMES.length + '개' : CATEGORY_NAMES.length + '개 중 ' + cats.length + '개';
      document.querySelectorAll('#cat-row .cat-chip').forEach(function (b) {
        b.setAttribute('aria-pressed', cats.indexOf(b.getAttribute('data-cat')) !== -1 ? 'true' : 'false');
        b.disabled = !editable;
      });
      var ca = $('btn-cat-all'), cnn = $('btn-cat-none');
      if (ca) ca.disabled = !editable || allOn;
      if (cnn) cnn.disabled = !editable || cats.length === 1;
    }
    var rh = $('set-rounds-help'); if (rh) rh.textContent = fixed ? '출제자가 그릴 단어 개수' : '모두가 한 번씩 그리면 1라운드';
    var badge = $('mode-badge'); if (badge) badge.textContent = MODE_NAMES[s.mode] || s.mode;
    var back = $('btn-mode-back'); if (back) back.hidden = !isHost();
    var rl = $('set-rounds-label'); if (rl) rl.textContent = fixed ? '문제 수' : '라운드';
    var fw = $('set-fixedDrawer-wrap'); if (fw) fw.hidden = !fixed;
    // 속도전: 단어 후보·힌트 설정은 의미가 없으므로 숨긴다
    var blitz = s.mode === 'blitz';
    ['set-wordCount', 'set-hints', 'set-hintEndAt'].forEach(function (id) {
      var n = $(id); var wrap = n && n.closest ? n.closest('.setting') : null; if (wrap) wrap.hidden = blitz;
    });
    // 이어 그리기: 라운드·힌트 시점은 쓰지 않는다(문제 수 = 인원, 힌트는 맞히는 사람이 버튼으로). 시간·힌트는 뜻이 바뀐 라벨로
    ['set-rounds', 'set-hintEndAt'].forEach(function (id) {
      var n = $(id); var wrap = n && n.closest ? n.closest('.setting') : null; if (wrap && relay) wrap.hidden = true; else if (wrap && id === 'set-rounds') wrap.hidden = false;
    });
    var dtl = $('set-drawTime-label'); if (dtl) dtl.textContent = relay ? '한 명당 시간' : '그리기 시간';
    var dth = $('set-drawTime-help'); if (dth) dth.textContent = relay ? '주자 한 명이 이어 그리는 시간' : '한 사람이 그리는 시간';
    var hl = $('set-hints-label'); if (hl) hl.textContent = relay ? '최대 힌트' : '힌트 횟수';
    var hh = $('set-hints-help'); if (hh) hh.textContent = relay ? '맞히는 사람이 버튼으로 초성을 여는 횟수. 쓸 때마다 점수가 줄어요' : '정답 글자를 초성으로 몇 번 보여 줄지';
    var wch = $('set-wordCount-help'); if (wch) wch.textContent = relay ? '첫 주자가 이 중 ' + RELAY_PICK + '개를 골라 제시어를 만들어요' : '그리는 사람이 고를 수 있는 단어 개수';
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
    var need = relay ? relayMin() : minPlayers();
    var enough = relay ? onlineCount() >= need : state.players.length >= need;
    var tooMany = relay && onlineCount() > RELAY_MAX;
    var fd = fixed ? findPlayer(fixedDrawerId()) : null;
    var drawerOk = !fixed || (fd && fd.connected !== false);
    var viewing = state.players.filter(function (p) { return p.connected !== false && p.atResults; }).map(function (p) { return p.name + (p.id === myId ? '(나)' : ''); });
    if (btn) {
      btn.disabled = !(isHost() && enough && !tooMany && drawerOk && !viewing.length);
      btn.textContent = isHost() ? '게임 시작' : '호스트를 기다리는 중…';
    }
    if (hint) {
      hint.textContent = viewing.length ? '결과 화면을 보고 있는 사람이 있어요: ' + viewing.join(', ')
        : !enough ? (relay ? '이어 그리기는 ' + need + '명부터 할 수 있어요 (지금 ' + onlineCount() + '명)' : '플레이어가 ' + need + '명 이상이어야 시작할 수 있어요')
        : tooMany ? '이어 그리기는 ' + RELAY_MAX + '명까지 할 수 있어요 (지금 ' + onlineCount() + '명)'
        : !drawerOk ? '출제자가 접속 중이어야 시작할 수 있어요'
        : (isHost() ? (fixed && fd ? '✏️ ' + fd.name + '님이 ' + s.rounds + '개의 단어를 그려요' : blitz ? '⚡ 단어는 자동으로 정해지고 ' + s.drawTime + '초씩, 힌트 없음. 1등 400 · 2등 300 · 3등 200점'
          : relay ? '🖍 ' + (onlineCount() - 1) + '명이 ' + s.drawTime + '초씩 이어 그리고 1명이 맞혀요. 모두 한 번씩 맞히면 끝' : '') : '호스트가 게임을 시작하면 바로 시작돼요');
    }
  }

  /** 이어 그리기 2개 고르기: 칩 상태(고른 순서 1·2) · 미리보기 "A · B" · "이 두 개로 그리기" 버튼 */
  function renderRelayPicks(show, blurred) {
    var bar = $('relay-pick-bar'); if (!bar) return;
    bar.hidden = !show;
    bar.classList.toggle('blurred', !!blurred);
    if (!show) return;
    var picks = ui.relayPicks, sent = !!ui.chosenWord, full = picks.length >= RELAY_PICK;
    document.querySelectorAll('#word-options .pick-option').forEach(function (b) {
      var i = picks.indexOf(b.getAttribute('data-word'));
      b.classList.toggle('picked', i >= 0);
      b.classList.toggle('dim', i < 0 && full);
      b.setAttribute('aria-pressed', i >= 0 ? 'true' : 'false');
      b.disabled = sent;
      var nEl = b.querySelector('.pick-num'); if (nEl) nEl.textContent = i >= 0 ? String(i + 1) : '';
    });
    var pv = $('relay-pick-preview');
    if (pv) {
      pv.innerHTML = '';
      if (!picks.length) pv.appendChild(el('span', 'pick-empty', '두 단어를 고르면 제시어가 돼요'));
      else {
        pv.appendChild(el('b', null, picks[0]));
        pv.appendChild(el('span', 'pick-sep', ' · '));
        pv.appendChild(picks[1] ? el('b', null, picks[1]) : el('span', 'pick-empty', '하나 더'));
      }
    }
    var go = $('btn-relay-pick');
    if (go) { go.disabled = sent || picks.length !== RELAY_PICK; go.textContent = sent ? '골랐어요!' : '이 두 개로 그리기'; }
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
        var relayC = inRelay();
        if (title) title.textContent = mine ? (relayC ? '단어 ' + RELAY_PICK + '개를 골라주세요!' : '단어를 골라주세요!') : dn + (relayC ? '님이 제시어를 고르고 있어요' : '님이 단어를 고르고 있어요');
        var rn = $('choosing-relay-note');
        if (rn) {
          // 이어 그리기: 첫 주자는 조합을 다 그리지 않아도 된다 — 뒤 주자가 이어 그린다
          var myNo = relayC ? relayMyTurnNo() : 0;
          rn.hidden = !(relayC && (mine || myNo));
          if (!rn.hidden && !mine) rn.textContent = '나는 ' + myNo + '번째로 그려요';
          else if (!rn.hidden) rn.textContent = state.relay.legCount > 1 ? '한 명당 ' + (state.settings.drawTime) + '초씩 ' + state.relay.legCount + '명이 이어 그려요. 다 못 그려도 괜찮아요' : state.settings.drawTime + '초 동안 그려요';
        }
        if (wait) wait.hidden = !!mine;
        var viaWindow = !!(mine && desktopStreamer() && wordWindowOpen()); // 단어 창에서 고른다: 메인에는 후보를 아예 안 그린다
        var peekBtn = $('btn-peek-options'), blurred = !!(mine && streamer() && !ui.optionsPeek && !viaWindow);
        if (peekBtn) peekBtn.hidden = !blurred;
        var winBtn = $('btn-choose-window'), winHint = $('choosing-window-hint');
        if (winBtn) winBtn.hidden = !(mine && desktopStreamer() && !wordWindowOpen());
        if (winHint) winHint.hidden = !viaWindow;
        if (opts) {
          opts.hidden = !mine || viaWindow;
          opts.classList.toggle('blurred', blurred); // 방송 모드: 후보를 흐리게, "후보 보기"를 눌러야 고를 수 있다
          if (!mine && opts.childElementCount) opts.innerHTML = ''; // 이전 턴 후보 버튼 잔존 방지
          opts.classList.toggle('relay-pick', !!(mine && relayC));
          var key = mine ? (relayC ? 'r\u0001' : '') + ui.wordOptions.join('\u0001') : '';
          if (key !== ui.optionsKey) {
            ui.optionsKey = key; opts.innerHTML = '';
            if (mine && relayC) ui.wordOptions.forEach(function (w) {
              // 이어 그리기: 토글 칩(고른 순서 번호). 상태는 renderRelayPicks 가 매번 맞춘다
              var b = el('button', 'word-option pick-option'); b.type = 'button'; b.setAttribute('data-word', w);
              b.appendChild(el('span', 'pick-num')); b.appendChild(el('span', 'pick-text', w));
              b.addEventListener('click', function () { toggleRelayPick(w); });
              opts.appendChild(b);
            });
            else if (mine) ui.wordOptions.forEach(function (w) {
              var b = el('button', 'word-option', w); b.type = 'button';
              b.addEventListener('click', function () {
                if (ui.chosenWord) return;
                chooseWord(w);
                opts.querySelectorAll('.word-option').forEach(function (x) { x.disabled = true; x.classList.toggle('chosen', x === b); });
              });
              opts.appendChild(b);
            });
          }
        }
        renderRelayPicks(!!(mine && relayC && !viaWindow), blurred);
      } else { ui.optionsKey = ''; renderRelayPicks(false, false); }
    }
    if (ot) {
      ot.hidden = !(ph === 'turnEnd' && ui.turnEnd);
      if (!ot.hidden) {
        var te = ui.turnEnd;
        var r = $('turnend-reason');
        if (r) {
          if (inRelay()) {
            var gName = state.relay.guesserId ? playerName(state.relay.guesserId, '') : '';
            r.textContent = te.reason === 'allGuessed' ? '🎯 ' + (state.relay.guesserId === myId ? '내가' : gName + '님이') + ' 맞혔어요!' : (RELAY_REASON_TEXT[te.reason] || '문제 끝');
          } else r.textContent = REASON_TEXT[te.reason] || '턴 종료';
        }
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
    // 이어 그리기: 주자의 채팅은 주자끼리만(guessed-chat 채널). 맞히는 사람은 drawing 중 정답 판정, 관전자는 판정 없음
    if (inRelay() && (state.phase === 'choosing' || state.phase === 'drawing')) {
      // 맞히는 사람: 요소를 나눠 맞혀도 되므로 맞힌 게 있으면 남은 개수를 알려 준다. 관전자(중간 참가)는 판정 없음
      var sp = solvedParts(ui.wordMask), left = sp.length > 1 ? sp.filter(function (x) { return !x; }).length : 0;
      ci.placeholder = isRunner() ? '주자끼리만 보여요…'
        : isRelayGuesser() ? (state.phase !== 'drawing' ? '🎯 곧 그림이 시작돼요…' : left && left < sp.length ? '🎯 남은 ' + left + '개도 맞혀 보세요…' : '🎯 정답을 입력하세요…')
        : '관전 중 · 메시지를 입력하세요…';
      return;
    }
    if (state.phase === 'drawing' && !isDrawer()) {
      var me = findPlayer(myId);
      ci.placeholder = me && me.hasGuessed ? '정답자들과 채팅…' : '정답을 입력하세요…';
    } else ci.placeholder = '메시지를 입력하세요…';
  }

  // ------------------------------------------------------------------
  // Chat
  // ------------------------------------------------------------------
  /** 채팅 한 줄: 닉네임(위) · 내용(아래). 닉네임이 길어도 내용 폭이 줄지 않는다 */
  function msgBody(name, text, safe) {
    var b = el('div', 'msg-body');
    if (name) b.appendChild(el('span', 'msg-name', String(name)));
    b.appendChild(msgText(text, safe));
    return b;
  }
  /** 본문 span. safe(가린 판)가 있으면 설정에 따라 고르고, 나중에 설정이 바뀌면 바꿔 끼울 수 있게 둘 다 붙여 둔다 */
  function msgText(text, safe) {
    var n = el('span', 'msg-text', safe && prefs.profanityFilter ? safe : text);
    if (safe) { n.setAttribute('data-raw', text); n.setAttribute('data-safe', safe); }
    return n;
  }
  function appendChat(m) {
    var list = $('chat-list'); if (!list) return;
    var kind = typeof m.kind === 'string' ? m.kind : 'chat';
    var text = m.text == null ? '' : String(m.text);
    var safe = typeof m.textSafe === 'string' && m.textSafe !== text ? m.textSafe : null; // 서버가 욕설을 가린 판
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    var node, peekNote = ''; // 모바일 요약(말풍선·티커)에 덧붙일 부분 정답 문구
    if (kind === 'system') {
      node = el('div', 'msg msg-system', text);
      if (text.indexOf('입장했습니다') !== -1) SFX.play('join');
      else if (text.indexOf('나갔습니다') !== -1 || text.indexOf('강퇴되었습니다') !== -1) SFX.play('leave');
    } else if (kind === 'correct') {
      node = el('div', 'msg msg-correct'); node.appendChild(el('span', 'msg-icon', '🎉')); node.appendChild(el('span', 'msg-text', text));
      SFX.play(m.id === myId ? 'correctSelf' : 'correctOther');
    } else if (kind === 'close') {
      // 이어 그리기 부분 정답: 서버가 partial { solved, total } 을 붙여 보낸다(보낸 사람에게만) → "3개 중 1개 맞았어요!"
      var pt = m.partial && typeof m.partial === 'object' ? m.partial : null;
      var partial = !!(pt && num(pt.total, 0) > 0);
      var note = partial ? num(pt.total, 0) + '개 중 ' + num(pt.solved, 0) + '개 맞았어요!' : '거의 맞았어요!';
      if (partial) peekNote = note;
      node = el('div', 'msg msg-close' + (partial ? ' msg-partial' : '')); node.appendChild(el('span', 'msg-icon', partial ? '🎯' : '🔥')); node.appendChild(msgText(text, safe)); node.appendChild(el('span', 'msg-note', note));
      SFX.play('close');
    }
    else if (kind === 'guessed-chat') {
      // 이어 그리기에서는 "주자끼리" 채널(맞히는 사람은 못 본다)
      var runnerChat = inRelay();
      node = el('div', 'msg msg-guessed' + (runnerChat ? ' msg-runner' : '')); node.appendChild(el('span', 'msg-icon', runnerChat ? '🖍' : '🔒'));
      node.appendChild(msgBody(m.name, text, safe));
      if (runnerChat) { var nm0 = node.querySelector('.msg-name'); if (nm0) nm0.appendChild(el('span', 'msg-tag', '주자')); }
    } else {
      node = el('div', 'msg msg-chat' + (m.id && m.id === myId ? ' msg-mine' : ''));
      node.appendChild(avatarNode(m.avatar));
      node.appendChild(msgBody(m.name, text, safe));
    }
    list.appendChild(node);
    while (list.children.length > 300) list.removeChild(list.firstChild);
    if (atBottom) list.scrollTop = list.scrollHeight;
    // 모바일 요약(티커 · 말풍선 · 접힌 채팅 바)용 최근 메시지
    ui.recentChat.push({ kind: kind, name: m.name ? String(m.name) : '', text: safe && prefs.profanityFilter ? safe : text, raw: text, safe: safe, mine: !!(m.id && m.id === myId), note: peekNote, t: Date.now() });
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
  /** 화면에 보이고 누를 수 있는가(hidden·display:none 조상·disabled 면 false) */
  function focusableNow(n) { return !!(n && !n.disabled && !n.hidden && n.getClientRects().length); }
  /** 모달 포커스 트랩: Tab·Shift+Tab 이 box 밖으로 나가지 않게 처음↔끝을 잇는다. keydown 에서 부른다 */
  function trapTab(box, e) {
    if (!box || e.key !== 'Tab') return;
    var list = Array.prototype.filter.call(box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'), focusableNow);
    if (!list.length) { e.preventDefault(); return; }
    var first = list[0], last = list[list.length - 1], cur = document.activeElement;
    var inside = box.contains(cur);
    if (e.shiftKey && (cur === first || !inside)) { e.preventDefault(); focusNode(last); }
    else if (!e.shiftKey && (cur === last || !inside)) { e.preventDefault(); focusNode(first); }
  }
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
    var wc = $('wordset-card'), ws = landing.wordSet;
    if (inv) { orderChildren(card, [head, jr]); orderChildren(sr, [meCard, card, dv, wc, bc, dm]); }
    else { orderChildren(sr, [meCard, card, jr, dv, wc, bc, dm]); }
    // 받은 단어 세트 링크: 이름·개수만 보여 준다(단어는 방을 만들면 설정에서 보인다)
    if (wc) wc.hidden = !ws;
    var wn = $('wordset-card-name'); if (wn) wn.textContent = ws ? ws.name || '이름 없는 세트' : '';
    var wnt = $('wordset-card-note'); if (wnt) wnt.textContent = ws ? '단어 ' + ws.words.length + '개' + (ws.only ? ' · 이 단어로만 출제' : '') + ' — 방을 만들면 이 단어로 시작해요' : '';
    if (card) card.hidden = !inv;
    var ic = $('invite-code'); if (ic) ic.textContent = inv || '';
    var full = $('invite-full'); if (full) { full.hidden = !(inv && landing.fullMsg); full.textContent = landing.fullMsg || ''; }
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
  // 유입 경로(?ref=채널코드): 이 탭에 기억해 두고 방 만들기/참가 때 서버에 알린다(지표용). 주소에서는 바로 지운다
  var REF_KEY = 'drawguess.ref';
  function rememberRef() {
    try {
      var qs = new URLSearchParams(location.search || '');
      var ref = (qs.get('ref') || '').trim().toLowerCase();
      if (!qs.has('ref')) return;
      if (/^[a-z0-9_-]{1,24}$/.test(ref)) sessionStorage.setItem(REF_KEY, ref);
      qs.delete('ref');
      var q = qs.toString();
      history.replaceState(history.state, '', location.pathname + (q ? '?' + q : '') + location.hash);
    } catch (e) { /* ignore */ }
  }
  function getRef() { try { return sessionStorage.getItem(REF_KEY) || ''; } catch (e) { return ''; } }

  // ---------- 공개 단어 세트 링크(#ws=…): "이 단어 세트로 방 만들기" ----------
  // 단어는 주소 해시에 base64url(UTF-8 JSON { v:1, n?, w:[…], o })로 담는다 → 서버 저장소가 없고, 해시라 서버 로그에도 안 남는다.
  // 받은 쪽은 읽자마자 sessionStorage 에 두고 주소에서 지운 뒤(로그인 리다이렉트를 다녀와도 남는다), 이 탭에서 방을 만들면 그 단어로 설정을 채운다
  var WS_KEY = 'drawguess.wordSetLink';
  var WS_MAX_LEN = 2000, WS_MAX_NAME = 30; // 서버 customWords 원문 상한과 같음 · 세트 이름 상한(내 정보 단어 세트와 같음)
  function b64urlEncode(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(s) {
    s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  /** 단어 배열 → customWords 규칙(각 1~20자 · 중복 제거 · 쉼표로 이은 원문 2000자 이하)에 맞춘 세트. 남는 단어가 없으면 null. cut = 길이 상한 때문에 뺀 개수 */
  function normWordSet(name, words, only) {
    var out = [], seen = {}, len = 0, cut = 0;
    (Array.isArray(words) ? words : []).forEach(function (raw) {
      var w = String(raw == null ? '' : raw);
      try { w = w.normalize('NFC'); } catch (e) { /* ignore */ }
      w = w.replace(/[,\u0000-\u001F\u007F]/g, ' ').trim().replace(/\s+/g, ' ');
      var n = Array.from(w).length;
      if (n < 1 || n > 20) return;
      var key = w.toLowerCase(); if (seen[key]) return;
      var add = (out.length ? 2 : 0) + w.length; // ', ' 로 잇는다
      if (len + add > WS_MAX_LEN) { cut++; return; }
      seen[key] = 1; out.push(w); len += add;
    });
    if (!out.length) return null;
    var nm = String(name == null ? '' : name).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().replace(/\s+/g, ' ');
    return { name: Array.from(nm).slice(0, WS_MAX_NAME).join(''), words: out, only: !!only, cut: cut };
  }
  function wordSetUrl(set) {
    var payload = { v: 1, w: set.words, o: set.only ? 1 : 0 };
    if (set.name) payload.n = set.name;
    return location.origin + '/#ws=' + b64urlEncode(JSON.stringify(payload));
  }
  function pendingWordSet() {
    try {
      var v = JSON.parse(sessionStorage.getItem(WS_KEY) || 'null');
      return v && typeof v === 'object' ? normWordSet(v.name, v.words, v.only) : null;
    } catch (e) { return null; }
  }
  function clearPendingWordSet() { landing.wordSet = null; try { sessionStorage.removeItem(WS_KEY); } catch (e) { /* ignore */ } }
  /** 주소의 #ws= 를 읽어 이 탭에 기억하고 주소에서 지운다 */
  function readWordSetHash() {
    var m = null;
    try { m = /(?:^#|&)ws=([A-Za-z0-9_-]*)/.exec(location.hash || ''); } catch (e) { /* ignore */ }
    if (!m) { landing.wordSet = pendingWordSet(); return; }
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* ignore */ }
    var set = null;
    try {
      var d = m[1].length <= 40000 ? JSON.parse(b64urlDecode(m[1])) : null;
      if (d && typeof d === 'object') set = normWordSet(d.n, d.w, d.o);
    } catch (e) { set = null; }
    if (set) { try { sessionStorage.setItem(WS_KEY, JSON.stringify({ name: set.name, words: set.words, only: set.only })); } catch (e) { /* ignore */ } }
    else toast('단어 세트 링크를 읽지 못했어요. 주소가 잘렸는지 확인해 줘', 'error');
    landing.wordSet = set || pendingWordSet();
  }
  /** 방을 만든 직후(호스트): 받은 단어 세트로 우리만의 단어를 채운다 */
  function applyPendingWordSet() {
    var ws = landing.wordSet || pendingWordSet(); clearPendingWordSet();
    if (!ws) return;
    var patch = { customWords: ws.words.join(', '), customWordsOnly: !!ws.only };
    state.settings = Object.assign({}, state.settings, patch);
    ui.customOpen = true; ui.setSource = { name: ws.name, key: ws.words.join(',') };
    emit('room:settings', { settings: patch });
    toast((ws.name ? '"' + ws.name + '" ' : '') + '단어 세트(' + ws.words.length + '개)를 우리만의 단어에 넣었어요', 'ok');
    renderAll();
  }
  /** 단어 세트 링크 보내기: 모바일은 공유 시트, PC 는 문구 + 링크 복사 */
  function shareWordSet(set) {
    if (!set) { toast('링크로 만들 단어가 없어요', 'error'); return; }
    var url = wordSetUrl(set);
    var text = '이뭔그 ' + (set.name ? '"' + set.name + '" ' : '') + '단어 세트 ' + set.words.length + '개 🎨 이 단어로 방 만들기';
    var note = set.cut ? ' 단어가 많아서 ' + set.words.length + '개만 담았어요' : '';
    if (canShareInvite()) {
      navigator.share({ title: '이뭔그', text: text, url: url }).then(function () { if (note) toast(note.trim()); }, function (err) {
        if (err && err.name === 'AbortError') return;
        copyText(text + ' → ' + url, '단어 세트 링크를 복사했어요!' + note, '복사에 실패했어요');
      });
      return;
    }
    copyText(text + ' → ' + url, '단어 세트 링크를 복사했어요!' + note, '복사에 실패했어요');
  }
  /** 방 설정의 "이 단어로 방 만들기 링크": 불러온 세트 그대로면 그 이름도 담는다 */
  function shareRoomWordSet() {
    if (!isHost() || state.phase !== 'lobby') return;
    var ta = $('set-customWords'), cb = $('set-customWordsOnly');
    var words = parseWords(ta ? ta.value : state.settings.customWords || '').words;
    var src = ui.setSource, name = src && src.key === words.join(',') ? src.name : '';
    shareWordSet(normWordSet(name, words, cb ? cb.checked : state.settings.customWordsOnly));
  }
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
    landing.invite = null; landing.fullMsg = null;
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
    var wd = $('btn-wordset-card-drop'); if (wd) wd.addEventListener('click', function () { clearPendingWordSet(); renderLanding(); toast('받은 단어 세트를 뺐어요'); });

    rememberRef();
    readWordSetHash();
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
    var ref = getRef(); if (ref) p.ref = ref;
    if (landing.wordSet || pendingWordSet()) p.fromWordSetLink = true; // 지표용 불린만(PROTOCOL room:create)
    withAck('room:create', p, function (ack) { setToken(ack.token); enterRoom(ack.roomCode, ack.playerId); applyPendingWordSet(); });
  }
  function joinRoom() {
    var code = codeInput();
    if (code.length !== 4) { toast('방 코드는 영문 4글자예요', 'error'); var c = $('room-code-input'); if (c) c.focus(); return; }
    var p = validName(); if (!p) return;
    profile.name = p.name; saveProfile();
    syncAccountProfile(false);
    var payload = { roomCode: code, name: p.name, avatar: p.avatar, token: getToken(), via: landing.invite === code ? 'link' : 'code' };
    var ref = getRef(); if (ref) payload.ref = ref;
    landing.fullMsg = null; renderLanding();
    withAck('room:join', payload, function (ack) { setToken(ack.token); enterRoom(ack.roomCode || code, ack.playerId); }, function (msg) {
      // 가득 찬 방(방송·모임): 토스트 대신 초대 카드 안에 남겨 두어 잠시 후 다시 누를 수 있게
      if (landing.invite === code && /가득/.test(msg)) { landing.fullMsg = msg; renderLanding(); return; }
      toast(msg, 'error');
    });
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
    var ci = $('chat-input'); if (ci && canAutoFocusChat()) ci.focus();
  }

  function resetToLanding(sendLeave) {
    if (sendLeave) emit('room:leave');
    inRoom = false;
    closeWordWindow(); ui.streamerWas = null; hideHintTip();
    rejoinTarget = null;
    closeSheet(true);
    clearLastRoom();
    cancelLocalStroke(false);
    state.roomCode = null; state.hostId = null; state.phase = 'lobby'; state.round = 0; state.totalRounds = 0;
    state.drawerId = null; state.players = []; state.settings = Object.assign({}, DEFAULT_SETTINGS);
    ui.wordMask = ''; ui.word = null; ui.wordOptions = null; ui.turnEnd = null; ui.ranking = null; ui.optionsKey = '';
    ui.gallery = null; ui.galleryThumbs = []; ui.galleryOpen = false; ui.saveStatus = null; ui.saveJob = null; ui.customOpen = false; ui.customStash = null; ui.setSource = null;
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
      var qs = new URLSearchParams(location.search);
      if (streamer()) qs.delete('room'); else qs.set('room', state.roomCode); // 방송 모드: 주소창에 방 코드가 안 보이게
      var q = qs.toString(), url = q ? '/?' + q : '/', st = { inRoom: state.roomCode }, hs = history.state;
      if (hs && hs.inRoom) history.replaceState(st, '', url); else history.pushState(st, '', url);
    } catch (e) { /* file:// 등 */ }
  }
  // 뒤로가기로 방을 나가려 할 때 묻는 대화상자
  function leaveDialogOpen() { var d = $('overlay-leave'); return !!(d && !d.hidden); }
  var leaveIntent = null; // null = 방 나가기(메인) · 'me' = 방에서 나가 내 정보로
  function openLeaveDialog(intent) {
    var d = $('overlay-leave'); if (!d || !inRoom) return;
    leaveIntent = intent === 'me' || intent === 'end' ? intent : null;
    var game = state.phase !== 'lobby';
    var title = $('leave-title'), desc = $('leave-desc'), ok0 = $('btn-leave-confirm');
    if (leaveIntent === 'end') {
      if (title) title.textContent = '게임을 끝낼까요?';
      if (desc) desc.textContent = '모두 바로 대기실로 돌아가요. 이번 게임의 결과와 그림은 남지 않아요.';
      if (ok0) ok0.textContent = '게임 끝내기';
    } else if (leaveIntent === 'me') {
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

  // ---------- 초대: 모바일은 공유 시트(카톡 등), PC 는 초대 문구 + 링크 복사 ----------
  var INVITE_TEXT = '이뭔그 한 판? 🎨 설치 없이 링크만 누르면 돼';
  function inviteUrl() { return location.origin + '/?room=' + state.roomCode; }
  /** 터치 기기 + Web Share 가 있으면 공유 시트 */
  function canShareInvite() {
    try { return !!navigator.share && window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  }
  function copyText(text, okMsg, failMsg) {
    function ok() { toast(okMsg, 'ok'); }
    function fallback() {
      try {
        var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
        var done = document.execCommand && document.execCommand('copy'); document.body.removeChild(ta);
        if (done) ok(); else toast(failMsg, 'error');
      } catch (e) { toast(failMsg, 'error'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
    else fallback();
  }
  function copyInviteText(text) { copyText(text, '초대 문구와 링크를 복사했어요!', '복사에 실패했어요. 방 코드: ' + state.roomCode); }
  function copyInvite() {
    if (!state.roomCode) return;
    var url = inviteUrl(), text = INVITE_TEXT + ' → ' + url;
    if (canShareInvite()) {
      navigator.share({ title: '이뭔그', text: INVITE_TEXT, url: url }).then(null, function (err) {
        if (err && err.name === 'AbortError') return; // 시트를 닫음
        copyInviteText(text);
      });
      return;
    }
    copyInviteText(text);
  }
  /** 초대 버튼 문구: 공유 시트가 있으면 "초대 링크 보내기" */
  function labelInviteButton() {
    var b = $('btn-copy'); if (!b || !canShareInvite()) return;
    b.title = '초대 링크 보내기';
    var t = b.querySelector('.btn-copy-text'); if (t) t.textContent = '초대 링크 보내기';
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
    var wcr = wordCountRange(s.mode);
    if (g('set-wordCount')) s.wordCount = clamp(num(g('set-wordCount').value, s.wordCount), wcr[0], wcr[1]);
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
    fillWordCountSelect(state.settings.mode);
    fillSelect('set-hints', range(0, 5), function (v) { return v === 0 ? '없음' : v + '회'; });
    fillSelect('set-hintEndAt', [5, 10, 15, 20, 30, 45, 60], function (v) { return '종료 ' + v + '초 전'; });

    ['set-rounds', 'set-drawTime', 'set-wordCount', 'set-hints', 'set-hintEndAt', 'set-customWordsOnly', 'set-fixedDrawer'].forEach(function (id) {
      var n = $(id); if (n) n.addEventListener('change', sendSettings);
    });
    document.querySelectorAll('#mode-panel .mode-card').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!isHost() || state.phase !== 'lobby') return;
        var mode = b.getAttribute('data-mode'), wasRelay = state.settings.mode === 'relay';
        state.settings = Object.assign({}, state.settings, MODE_PRESETS[mode] || {}, { mode: mode });
        if ((mode === 'relay') !== wasRelay) state.settings.wordCount = mode === 'relay' ? RELAY_WORD_COUNT.def : DEFAULT_SETTINGS.wordCount;
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
    var wsb = $('btn-wordset-link'); if (wsb) wsb.addEventListener('click', function () { sendSettings(); shareRoomWordSet(); });
    // 기본 단어 카테고리 칩: 기본은 13개 전부 켜진 상태(settings.categories = [] = 전체)에서 빼는 식으로 쓴다.
    // 전부 켜면 [] 로 정규화(서버 규칙과 같음), 마지막 하나는 못 끈다. "모두 선택"=[], "모두 해제"=첫 카테고리 하나만 남김
    var catRow = $('cat-row');
    var setCategories = function (next) {
      if (!isHost() || state.phase !== 'lobby') return;
      if (next.length === CATEGORY_NAMES.length) next = [];
      state.settings = Object.assign({}, state.settings, { categories: next });
      emit('room:settings', { settings: state.settings });
      renderAll();
    };
    if (catRow) {
      CATEGORY_NAMES.forEach(function (n) { var b = el('button', 'cat-chip', n); b.type = 'button'; b.setAttribute('data-cat', n); b.setAttribute('aria-pressed', 'true'); catRow.appendChild(b); });
      catRow.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('.cat-chip') : null; if (!b || b.disabled) return;
        var k = b.getAttribute('data-cat'), cur = selectedCategories();
        if (cur.indexOf(k) !== -1) {
          if (cur.length === 1) { toast('카테고리는 하나는 남겨야 해요'); return; }
          setCategories(cur.filter(function (x) { return x !== k; }));
        } else setCategories(CATEGORY_NAMES.filter(function (n) { return n === k || cur.indexOf(n) !== -1; }));
      });
    }
    var catAll = $('btn-cat-all'), catNone = $('btn-cat-none');
    if (catAll) catAll.addEventListener('click', function () { if (!catAll.disabled) setCategories([]); });
    if (catNone) catNone.addEventListener('click', function () {
      if (catNone.disabled) return;
      // 규칙상 최소 하나는 남아야 하므로 첫 카테고리만 남기고 알려 준다. 상태가 늘 유효하고 서버·비방장 요약과 바로 맞아떨어진다
      setCategories([CATEGORY_NAMES[0]]);
      toast('하나는 남겨야 해서 "' + CATEGORY_NAMES[0] + '"만 남겼어요. 쓰고 싶은 카테고리를 눌러 더해요');
    });
    document.querySelectorAll('#preset-row .preset-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!isHost() || state.phase !== 'lobby') return;
        var p = presetsFor(state.settings.mode)[b.getAttribute('data-preset')]; if (!p) return;
        state.settings = Object.assign({}, state.settings, p);
        emit('room:settings', { settings: state.settings });
        renderAll();
      });
    });
    var ucb = $('set-useCustom');
    if (ucb) ucb.addEventListener('change', function () {
      if (!isHost() || state.phase !== 'lobby') return;
      ui.customOpen = ucb.checked;
      if (!ucb.checked) {
        // 끄면 단어를 비워 게임에 쓰지 않게 한다(다시 켜면 되돌린다)
        ui.customStash = { words: state.settings.customWords || '', only: !!state.settings.customWordsOnly };
        state.settings = Object.assign({}, state.settings, { customWords: '', customWordsOnly: false });
        emit('room:settings', { settings: state.settings });
      } else if (ui.customStash && ui.customStash.words && !String(state.settings.customWords || '').trim()) {
        state.settings = Object.assign({}, state.settings, { customWords: ui.customStash.words, customWordsOnly: ui.customStash.only });
        emit('room:settings', { settings: state.settings });
      }
      renderAll();
      if (ucb.checked) { var t = $('set-customWords'); if (t && !t.value) focusNode(t); }
    });

    var bs = $('btn-start');
    if (bs) bs.addEventListener('click', function () {
      if (!isHost()) return;
      if (state.players.length < minPlayers()) { toast('플레이어가 ' + minPlayers() + '명 이상이어야 시작할 수 있어요', 'error'); return; }
      emit('game:start');
    });
    var bc = $('btn-copy'); if (bc) bc.addEventListener('click', copyInvite);
    labelInviteButton();
    var chip = document.querySelector('.room-code-chip'); if (chip) chip.addEventListener('click', revealRoomCode);
    var pk = $('btn-peek-options'); if (pk) pk.addEventListener('click', function () { ui.optionsPeek = true; renderAll(); });
    var cw = $('btn-choose-window'); if (cw) cw.addEventListener('click', openWordWindow);
    var rpk = $('btn-relay-pick'); if (rpk) rpk.addEventListener('click', submitRelayPicks);
    window.addEventListener('beforeunload', function () { closeWordWindow(); });
    var bl = $('btn-leave'); if (bl) bl.addEventListener('click', function () { resetToLanding(true); });
    var bs = $('btn-sound'); if (bs) { renderSoundButton(bs); bs.addEventListener('click', function () { SFX.toggle(); renderSoundButton(bs); }); }
    document.querySelectorAll('.pref-switch').forEach(function (b) {
      b.addEventListener('click', function () { setPref(b.getAttribute('data-pref'), b.getAttribute('aria-checked') !== 'true'); });
    });
    renderPrefSwitches();
    var rh = $('btn-relay-hint'); if (rh) rh.addEventListener('click', requestRelayHint); // 이어 그리기 맞히는 사람 초성 힌트
    var rht = $('relay-hint-tip'); if (rht) rht.addEventListener('click', hideHintTip);
    window.addEventListener('resize', placeHintTip);
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
    var ga = $('btn-gallery-all'); if (ga) ga.addEventListener('click', saveGalleryAll);
    var lc = $('btn-leave-cancel'); if (lc) lc.addEventListener('click', closeLeaveDialog);
    var lo = $('btn-leave-confirm'); if (lo) lo.addEventListener('click', function () {
      var intent = leaveIntent;
      closeLeaveDialog();
      if (!inRoom) return;
      if (intent === 'end') { if (canEndGame()) emit('game:end'); return; }
      resetToLanding(true);
      if (intent === 'me') goStep('me', true, { from: 'room' });
    });
    var rpb = $('btn-room-profile'); if (rpb) rpb.addEventListener('click', function () { closeSheet(true); openRoomProfile(); });
    var beg = $('btn-end-game'); if (beg) beg.addEventListener('click', function () { closeSheet(true); if (canEndGame()) openLeaveDialog('end'); });
    var rpc = $('btn-room-profile-close'); if (rpc) rpc.addEventListener('click', function () { closeRoomProfile(); });
    var rpo = $('overlay-profile'); if (rpo) rpo.addEventListener('click', function (e) { if (e.target === rpo) closeRoomProfile(); });
    var ld = $('overlay-leave'); if (ld) ld.addEventListener('click', function (e) { if (e.target === ld) closeLeaveDialog(); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (leaveDialogOpen()) { closeLeaveDialog(); return; }
      if (wsLoadOpen()) { closeWsLoad(); return; }
      var dd = $('overlay-delete'); if (dd && !dd.hidden) { closeDeleteDialog(); return; }
      if (vault.viewing) { closeDrawing(); return; }
      if (openSheetId) { closeSheet(false); return; }
      if (roomProfile.open) { closeRoomProfile(); return; }
      if (ui.galleryOpen) closeGallery();
    });
    buildMobileChrome();

    var plist = $('player-list'); if (plist) plist.addEventListener('scroll', updatePlayerStripFade, { passive: true });
    window.addEventListener('resize', updatePlayerStripFade);

    var form = $('chat-form'), input = $('chat-input');
    if (form && input) {
      // 한글 조합(IME) 중 Enter: 조합이 끝난 뒤 보낸다. 보낸 직후 iOS/iPadOS 가 조합하던 마지막 글자를 다시 넣으면 지운다
      var ime = { composing: false, pending: false, clearedAt: 0, sent: '' };
      var sendNow = function () {
        var text = input.value.trim().slice(0, 100);
        if (!text) { input.focus(); return; }
        emit('chat:message', { text: text });
        input.value = ''; ime.clearedAt = Date.now(); ime.sent = text;
        input.focus();
      };
      input.addEventListener('compositionstart', function () { ime.composing = true; });
      input.addEventListener('compositionend', function () {
        ime.composing = false;
        if (ime.pending) { ime.pending = false; setTimeout(sendNow, 0); return; }
        setTimeout(dropEcho, 0);
      });
      var dropEcho = function () {
        if (!ime.clearedAt || Date.now() - ime.clearedAt > 600) return;
        var v = input.value;
        if (v && v.length <= 2 && ime.sent.slice(-v.length) === v) { input.value = ''; }
      };
      input.addEventListener('input', function () { if (!ime.composing) dropEcho(); });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (ime.composing) { ime.pending = true; setTimeout(function () { if (ime.pending) { ime.pending = false; ime.composing = false; sendNow(); } }, 400); return; } // compositionend 가 안 오는 경우 대비
        sendNow();
      });
    }
    buildToolbar();
  }

  // ------------------------------------------------------------------
  // Mobile chrome (≤767px · 세로 터치 태블릿) — 바텀 시트 · 노드 재배치 · visualViewport 추적 · 채팅 티커/말풍선
  //   데스크톱/태블릿에서는 아무 노드도 옮기지 않고 시트도 열리지 않는다(CSS 가 모바일 전용 요소를 display:none 처리).
  // ------------------------------------------------------------------
  // style.css 의 모바일 미디어 블록과 같은 조건: 폰 세로(≤767px) · 좁은 마우스 창 · 세로로 든 터치 태블릿(≤1099px, 아이패드 세로).
  // 가로로 든 터치 기기(≥640px)는 모바일 셸 대신 가로 게임 셸(tablet-shell)
  var MOBILE_MQ = '(max-width: 639px), (max-width: 767px) and (orientation: portrait), (max-width: 767px) and (pointer: fine), (max-width: 1099px) and (orientation: portrait) and (pointer: coarse)';
  var mobileMq = window.matchMedia ? window.matchMedia(MOBILE_MQ) : { matches: false, addEventListener: null, addListener: null };
  /** 넓은 화면 + 마우스일 때만 채팅 입력창에 자동 포커스(터치 기기는 가상 키보드가 튀어나온다) */
  function canAutoFocusChat() {
    if (window.innerWidth < 1100) return false;
    try { return !window.matchMedia || !window.matchMedia('(pointer: coarse)').matches; } catch (e) { return true; }
  }
  var COMPACT_MAX_H = 520; // visualViewport 높이가 이보다 짧으면(키보드) 컴팩트 모드
  var KB_DROP = 120;       // 같은 폭에서 본 최대 높이보다 이만큼 줄면 키보드가 열린 것으로 본다
  var SHELL_CHROME_H = 300; // 모바일 게임 셸에서 캔버스를 뺀 나머지(헤더·턴 띠·상태 띠·채팅 최소·간격) 대략 높이
  var vvMax = 0, vvW = 0;
  var TABLET_MIN_W = 700; // 모바일 UI 중 이 폭 이상 = 태블릿 세로(출제자 배치가 다르다)
  function isTabletPortrait() { return mobileMq.matches && window.innerWidth >= TABLET_MIN_W; }
  // 가로 태블릿(아이패드 가로) 게임 셸 — style.css 의 같은 미디어 조건과 맞춘다
  var TABLET_LAND_MQ = '(min-width: 640px) and (orientation: landscape) and (pointer: coarse)';
  var tabletLandMq = window.matchMedia ? window.matchMedia(TABLET_LAND_MQ) : { matches: false, addEventListener: null, addListener: null };
  var openSheetId = null, sheetTimer = null, tickerTimer = null, bubbleTimer = null, lastCompact = false;

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
    if (mobile) placeNode(leave, $('menu-slot-leave'));
    else placeNode(leave, right, menu);
    var endBtn = $('btn-end-game');
    if (mobile) placeNode(endBtn, $('menu-slot-end'));
    else placeNode(endBtn, right, right ? right.querySelector('#btn-account-top') || right.querySelector('#btn-room-profile') : null);
    var profBtn = $('btn-room-profile');
    if (mobile) placeNode(profBtn, $('menu-slot-profile'));
    else placeNode(profBtn, right, leave && leave.parentNode === right ? leave : menu);
    var acctBtn = $('btn-account-top');
    if (mobile) placeNode(acctBtn, $('menu-slot-account'));
    else placeNode(acctBtn, right, profBtn && profBtn.parentNode === right ? profBtn : (leave && leave.parentNode === right ? leave : menu));
    var expand = $('btn-chat-expand');
    if (mobile && game && !drawerLayout()) placeNode(expand, $('draw-status')); else placeNode(expand, $('chat-bar'));
    if (!mobile && openSheetId) closeSheet(true);
    // 게임 셸(position:fixed)이 떠 있는 동안 문서 자체는 스크롤/바운스되지 않게 (iOS 주소창·키보드 대응)
    document.body.classList.toggle('game-shell', mobile && game && inRoom);
    document.body.classList.toggle('tablet-shell', !mobile && tabletLandMq.matches && game && inRoom);
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
    var w = window.innerWidth;
    if (w !== vvW) { vvW = w; vvMax = 0; } // 회전 등으로 폭이 바뀌면 다시 잰다
    vvMax = Math.max(vvMax, h);
    var kbOpen = vvMax - h > KB_DROP;
    // 태블릿 세로: 키보드가 열려도 520px 보다 크지만, 폭 가득한 캔버스 + 입력칸이 남은 높이에 안 들어가면 컴팩트(캔버스를 통째로 줄이고 말풍선)
    var tb0 = $('toolbar'), tbH = drawerLayout() && tb0 && !tb0.hidden ? (tb0.offsetHeight || 110) : 0;
    var fits = !kbOpen || h >= (w - 16) * 0.75 + SHELL_CHROME_H + tbH;
    var compact = mobileMq.matches && (h < COMPACT_MAX_H || !fits);
    var vr = $('view-room');
    if (vr) { if (compact) vr.setAttribute('data-compact', '1'); else vr.removeAttribute('data-compact'); vr.setAttribute('data-tablet', isTabletPortrait() ? '1' : '0'); }
    if (compact !== lastCompact) { lastCompact = compact; if (!compact) setTimeout(scrollChatBottom, 0); renderChatPeek(false); }
    fitDrawerCanvas();
    fitTabletCanvas();
  }
  /** 가로 태블릿 게임 셸: 가운데 패널 안에서(도구 모음/상태 띠를 뺀) 남는 높이에 4:3 캔버스 최대 너비를 --tw 로 */
  function fitTabletCanvas() {
    var cw = $('canvas-wrap'), cp = document.querySelector('.center-panel');
    if (!cw || !cp) return;
    if (!document.body.classList.contains('tablet-shell')) { cw.style.removeProperty('--tw'); return; }
    var cs = getComputedStyle(cp);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var gap = parseFloat(cs.rowGap || cs.gap) || 8;
    var innerW = cp.clientWidth - padX, availH = cp.clientHeight - padY;
    ['toolbar', 'draw-status'].forEach(function (id) { var n = $(id); if (n && !n.hidden && n.offsetParent) availH -= n.offsetHeight + gap; });
    if (innerW <= 0 || availH <= 0) return;
    var wpx = Math.floor(Math.min(innerW, availH * 4 / 3));
    cw.style.setProperty('--tw', wpx + 'px');
  }

  /**
   * 출제자(모바일): 툴바를 화면 하단에 두고 캔버스는 그 위 남는 높이에 4:3 최대 크기로 맞춘다.
   * room-grid 높이에서 턴 띠 카드·채팅 버블 카드 최소 높이·패널 패딩·툴바·간격을 뺀 것이 캔버스 최대 높이
   * → 너비 = min(패널 너비, 높이 × 4/3). 결과를 --dw 로 넘긴다. (채팅 카드는 남는 높이를 flex 로 채운다)
   */
  function fitDrawerCanvas() {
    var vr = $('view-room'), cp = document.querySelector('.center-panel'), cw = $('canvas-wrap'), tb = $('toolbar');
    if (!vr || !cp || !cw) return;
    var on = mobileMq.matches && !isTabletPortrait() && state.phase !== 'lobby' && drawerLayout();
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
  function summarize(m) { return (m.kind === 'chat' || m.kind === 'guessed-chat') && m.name ? m.name + ': ' + m.text : peekText(m); }
  /** 요약에 쓸 본문: 이어 그리기 부분 정답이면 "고양이 · 3개 중 1개 맞았어요!" */
  function peekText(m) { return m.note ? m.text + ' · ' + m.note : m.text; }
  function kindClass(kind) { return kind === 'correct' ? 'kind-correct' : kind === 'close' ? 'kind-close' : kind === 'system' ? 'kind-system' : kind === 'guessed-chat' ? 'kind-guessed' : 'kind-chat'; }
  var BUBBLE_LIFE_MS = 3000, BUBBLE_FADE_MS = 400;
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
      else tt.textContent = last ? peekText(last) : '채팅 열기';
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
          b.appendChild(el('span', 'bb-text', peekText(m)));
          dc.appendChild(b);
        });
      }
    }
    var bb = $('chat-bubbles');
    if (bb) {
      bb.innerHTML = '';
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
      // 맞히는 사람이 폰 키패드를 올린 컴팩트 화면에서만: 도착 3초 뒤 사라지고(도착 시각 기준이라 다시 그려도 타이머가 리셋되지 않음) 아래(최신)부터 70/45/15% 불투명
      var vr2 = $('view-room');
      var timed = mobileMq.matches && !!vr2 && vr2.getAttribute('data-role') === 'guesser' && vr2.getAttribute('data-compact') === '1';
      var now = Date.now(), nextAt = 0;
      var shown = mobileMq.matches ? recent.filter(function (m) { return !timed || now - (m.t || 0) < BUBBLE_LIFE_MS; }) : [];
      shown.forEach(function (m, i) {
        var b = el('div', 'chat-bubble ' + kindClass(m.kind) + (m.mine ? ' mine' : ''));
        if (timed) {
          b.classList.add('bb-timed', 'bb-pos' + Math.min(2, shown.length - 1 - i));
          var age = now - (m.t || 0);
          b.style.animationDelay = (BUBBLE_LIFE_MS - BUBBLE_FADE_MS - age) + 'ms'; // 페이드 시작까지(이미 지났으면 음수 = 중간부터)
          var left = BUBBLE_LIFE_MS - age; if (!nextAt || left < nextAt) nextAt = left;
        }
        if ((m.kind === 'chat' || m.kind === 'guessed-chat') && m.name) b.appendChild(el('span', 'bb-name', m.name));
        b.appendChild(el('span', 'bb-text', peekText(m)));
        bb.appendChild(b);
      });
      if (timed && nextAt) bubbleTimer = setTimeout(function () { bubbleTimer = null; renderChatPeek(false); }, nextAt + 20);
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
    if (tabletLandMq.addEventListener) tabletLandMq.addEventListener('change', onMq); else if (tabletLandMq.addListener) tabletLandMq.addListener(onMq);
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
      vault.rows = null; vault.error = ''; vault.unavailable = false; vault.loadedAt = 0; closeDrawing();
      if (uid && inRoom && ui.gallery && ui.gallery.length) setTimeout(saveMyDrawings, 0); // 결과 화면에서 로그인 복원이 늦게 끝난 경우
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
    var wlb = $('btn-wordset-load');
    if (wlb) { wlb.hidden = !acct.sets.length; wlb.disabled = !canApplySet(); }
    if (wsLoadOpen()) { if (!logged || !acct.sets.length || !canApplySet()) closeWsLoad(); else renderWsLoad(); }
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
    if (tab === 'gallery') renderMeGallery();
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
        var lk = el('button', 'btn btn-ghost btn-sm ws-link', '🔗 링크'); lk.type = 'button'; lk.title = '이 단어로 방 만들기 링크';
        lk.addEventListener('click', function () { shareWordSet(normWordSet(s.name, s.words, true)); });
        acts.appendChild(lk); acts.appendChild(ed); acts.appendChild(dl);
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
    ui.setSource = { name: s.name, key: parseWords(s.words.join(',')).words.join(',') }; // 링크에 세트 이름을 담는 데 쓴다
    sendSettings();
    toast('"' + s.name + '" 세트를 방 설정에 적용했어요', 'ok');
  }
  /** 방 설정: "📂 불러오기" dialog — 내 세트를 행으로 보여 주고, 고르면 단어를 채운다 */
  function wsLoadOpen() { var d = $('overlay-wsload'); return !!(d && !d.hidden); }
  function renderWsLoad() {
    var box = $('wsload-list'); if (!box) return;
    // 상태가 올 때마다 불리므로 목록이 그대로면 다시 그리지 않는다(행에 둔 포커스를 지킨다)
    var key = JSON.stringify(acct.sets.map(function (s) { return [s.id, s.name, s.words.length]; }));
    if (box.getAttribute('data-key') === key && box.childElementCount) return;
    box.setAttribute('data-key', key);
    box.innerHTML = '';
    acct.sets.forEach(function (s) {
      var b = el('button', 'wsload-item'); b.type = 'button';
      b.appendChild(el('span', 'wsload-name', s.name));
      b.appendChild(el('span', 'wsload-count', s.words.length + '개'));
      b.addEventListener('click', function () { pickWsLoad(s); });
      box.appendChild(b);
    });
  }
  function openWsLoad() {
    var d = $('overlay-wsload'); if (!d || !acctLoggedIn() || !acct.sets.length || !canApplySet()) return;
    renderWsLoad(); d.hidden = false;
    focusNode(d.querySelector('.wsload-item') || $('btn-wsload-close')); // 첫 행, 없으면 닫기
  }
  /** 닫으면 [📂 불러오기] 로 포커스를 돌려놓는다(버튼이 숨었거나 비활성이면 그대로 둔다) */
  function closeWsLoad() {
    var d = $('overlay-wsload'); if (!d || d.hidden) return;
    d.hidden = true;
    var wlb = $('btn-wordset-load'); if (focusableNow(wlb)) focusNode(wlb);
  }
  function pickWsLoad(s) {
    closeWsLoad();
    if (!canApplySet()) return;
    var ta = $('set-customWords'); if (ta) ta.value = s.words.join(', ');
    ui.setSource = { name: s.name, key: parseWords(s.words.join(',')).words.join(',') }; // 링크에 세트 이름을 담는 데 쓴다
    sendSettings();
    toast('"' + s.name + '" 세트를 불러왔어요', 'ok');
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
  var roomProfile = { open: false, home: null, next: null, snap: null, timer: null, formless: false };
  /** 설정 창 윗부분(효과음 · 안내)을 모달/시트에 붙이고, 대기실이면 프로필 폼도 연다 */
  function openRoomProfile() {
    if (!inRoom) return;
    var top = $('room-settings-top');
    var lobby = state.phase === 'lobby';
    var lk = $('room-profile-locked'); if (lk) lk.hidden = lobby;
    if (top) {
      top.hidden = false;
      if (mobileMq.matches) { var sb = $('sheet-profile-body'); if (sb) sb.insertBefore(top, sb.firstChild); }
      else placeNode(top, $('room-settings-modal-slot'));
    }
    var sbtn = $('btn-sound'); if (sbtn) renderSoundButton(sbtn);
    if (!lobby) { // 게임 중: 효과음만
      roomProfile.open = true; roomProfile.snap = null; roomProfile.formless = true;
      if (mobileMq.matches) openSheet('sheet-profile'); else { var m0 = $('overlay-profile'); if (m0) m0.hidden = false; }
      return;
    }
    roomProfile.formless = false;
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
    var top = $('room-settings-top'); if (top) { top.hidden = true; document.body.appendChild(top); }
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
    var dz = $('btn-drawings-zip'); if (dz) dz.addEventListener('click', downloadAllDrawings);
    var da = $('btn-drawings-all'); if (da) da.addEventListener('click', saveAllDrawings);
    var dvc = $('btn-dv-close'); if (dvc) dvc.addEventListener('click', closeDrawing);
    var dvd = $('btn-dv-download'); if (dvd) dvd.addEventListener('click', function () { if (vault.viewing) downloadDrawingRow(vault.viewing); });
    var dvx = $('btn-dv-delete'); if (dvx) dvx.addEventListener('click', function () { if (vault.viewing) deleteDrawingRow(vault.viewing); });
    var dvo = $('overlay-drawing'); if (dvo) dvo.addEventListener('click', function (e) { if (e.target === dvo) closeDrawing(); });
    var nb = $('btn-wordset-new'); if (nb) nb.addEventListener('click', function () { openWordSetForm(null); });
    var wc = $('btn-ws-cancel'); if (wc) wc.addEventListener('click', function () { acct.formOpen = false; acct.editing = null; renderAccountPanel(); });
    var wf = $('wordset-form'); if (wf) wf.addEventListener('submit', function (e) { e.preventDefault(); submitWordSet(); });
    var ww = $('ws-words'); if (ww) ww.addEventListener('input', updateWordCount);
    var wlb = $('btn-wordset-load'); if (wlb) wlb.addEventListener('click', openWsLoad);
    var wlc = $('btn-wsload-close'); if (wlc) wlc.addEventListener('click', closeWsLoad);
    var wlo = $('overlay-wsload');
    if (wlo) {
      wlo.addEventListener('click', function (e) { if (e.target === wlo) closeWsLoad(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Tab' && wsLoadOpen()) trapTab(wlo, e); }); // 포커스가 body 로 빠졌어도 dialog 안으로
    }
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
  window.__dg = { state: state, ui: ui, acct: acct, photo: photo, landing: landing, badImgs: badImgs, renderPlayers: function () { renderPlayers(); }, renderAll: function () { renderAll(); }, ops: function () { return ops; }, redrawAll: redrawAll, myId: function () { return myId; } };
})();
