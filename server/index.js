'use strict';
/**
 * index.js — draw-guess 서버 진입점
 *  - express@4 로 public/ 정적 서빙
 *  - socket.io@4 로 PROTOCOL.md 의 C→S 이벤트 처리 (검증 후 Room 에 위임)
 *  - rooms: Map<roomCode, Room>
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const MAX_CHAT_LEN = 100;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CODE_RE = /^[A-Z]{4}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const REACT_LIMIT_PER_SEC = 8; // 플레이어당 초당 반응 상한(연타 허용, 폭주 방지)
const DEFAULT_AVATAR = { emoji: '🙂', color: '#4f8cff' };

const app = express();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * 자산 버전: public/ 안의 html/js/css 내용 해시(8자리).
 * 파일 내용이 바뀌면 값이 바뀌므로 배포마다 자동으로 새 URL(?v=...)이 되어 브라우저/중간 캐시가 무효화된다.
 */
function computeAssetVersion() {
  const h = crypto.createHash('md5');
  fs.readdirSync(PUBLIC_DIR)
    .filter((n) => /\.(js|css|html)$/.test(n))
    .sort()
    .forEach((n) => { h.update(n); h.update(fs.readFileSync(path.join(PUBLIC_DIR, n))); });
  return h.digest('hex').slice(0, 8);
}
const ASSET_VERSION = computeAssetVersion();

// index.html은 매 요청 재검증(no-store)하고, 안의 로컬 css/js 참조에는 ?v=버전 을 붙여 서빙한다.
// 외부/절대 경로(http:, //, /socket.io/..., data:)는 건드리지 않는다.
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/(href|src)="((?!https?:|\/|data:)[^"]+\.(?:css|js))"/g, (m, attr, file) => `${attr}="${file}?v=${ASSET_VERSION}"`)
  .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="asset-version" content="${ASSET_VERSION}">`);

function sendIndex(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.type('html').send(INDEX_HTML);
}
app.get(['/', '/index.html'], sendIndex);

// 헬스체크 / keep-alive 핑 대상 (정적 파일보다 가볍게)
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// js/css는 URL에 버전이 붙으므로 1년 캐시(immutable)해도 안전하다. 그 외 파일은 매번 재검증.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(js|css)$/.test(filePath)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    else res.set('Cache-Control', 'no-cache');
  },
}));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, Room>} */
const rooms = new Map();

// ── 방 코드 ─────────────────────────────────────────────────────
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function randomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  return code;
}
/** 충돌 없는 4글자 A-Z 코드. 사실상 항상 무작위로 성공하며, 최후에는 순차 탐색 */
function generateRoomCode() {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const code = randomCode();
    if (!rooms.has(code)) return code;
  }
  for (let n = 0; n < 26 ** 4; n++) {
    let code = '';
    let v = n;
    for (let i = 0; i < 4; i++) {
      code = LETTERS[v % 26] + code;
      v = Math.floor(v / 26);
    }
    if (!rooms.has(code)) return code;
  }
  return null;
}

// ── 입력 검증 ───────────────────────────────────────────────────
/** 이름: 문자열, NFC, trim, 연속 공백 1개, 1..12자(코드포인트). 실패 시 null */
function sanitizeName(v) {
  if (typeof v !== 'string') return null;
  const name = v.normalize('NFC').trim().replace(/\s+/g, ' ');
  const len = Array.from(name).length;
  if (len < 1 || len > 12) return null;
  return name;
}

/** 아바타: { emoji, color:'#rrggbb' }. 형식이 틀리면 기본값으로 보정 */
function sanitizeAvatar(v) {
  const a = v && typeof v === 'object' ? v : {};
  let emoji = typeof a.emoji === 'string' ? a.emoji.trim() : '';
  if (!emoji || Array.from(emoji).length > 16) emoji = DEFAULT_AVATAR.emoji;
  const color =
    typeof a.color === 'string' && COLOR_RE.test(a.color) ? a.color.toLowerCase() : DEFAULT_AVATAR.color;
  return { emoji, color };
}

/** 재접속 토큰: 클라이언트가 보낸 값이 형식에 맞으면 그대로, 아니면 새로 발급 */
function sanitizeToken(v) {
  return typeof v === 'string' && TOKEN_RE.test(v) ? v : crypto.randomBytes(16).toString('hex');
}

/** 채팅 텍스트: 문자열, trim, 1..100자. 실패 시 null */
function sanitizeChat(v) {
  if (typeof v !== 'string') return null;
  const text = v.normalize('NFC').replace(/\p{Cc}/gu, '').trim(); // 제어 문자 제거
  const len = Array.from(text).length;
  if (len < 1 || len > MAX_CHAT_LEN) return null;
  return text;
}

/** 방이 비었으면 타이머 정리 후 레지스트리에서 삭제 */
function deleteRoomIfEmpty(room) {
  if (room && room.isEmpty()) {
    room.destroy();
    rooms.delete(room.code);
    console.log(`[draw-guess] room ${room.code} deleted (empty). rooms=${rooms.size}`);
  }
}

// ── 소켓 처리 ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.data.roomCode = null;
  socket.data.playerId = null; // 방 안에서의 고정 id (최초 접속 시 socket.id, 재접속해도 유지)
  socket.data.reactTimes = [];
  /** 이 소켓의 playerId */
  const pid = () => socket.data.playerId || socket.id;
  // 접속(재접속 포함)마다 서버 자산 버전을 알려준다. 페이지 버전과 다르면 클라이언트가 스스로 새로고침한다.
  socket.emit('server:version', { version: ASSET_VERSION });

  const fail = (message) => socket.emit('error:msg', { message });

  /** 현재 소켓이 속한 Room (없으면 null, 스테일 코드는 정리) */
  const currentRoom = () => {
    const code = socket.data.roomCode;
    if (!code) return null;
    const room = rooms.get(code);
    if (!room || !room.getPlayer(pid())) {
      socket.data.roomCode = null;
      socket.data.playerId = null;
      return null;
    }
    return room;
  };

  /** 핸들러 예외가 서버를 죽이지 않도록 감싼다 */
  const on = (event, handler) => {
    socket.on(event, (...args) => {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[draw-guess] handler error on ${event}:`, err);
        fail('요청을 처리하는 중 오류가 발생했습니다.');
      }
    });
  };

  /**
   * 현재 방에서 빠지기.
   * - 'leave'      : 명시적 퇴장(room:leave, 새 방 생성/참가 전) → 즉시 제거
   * - 'disconnect' : 연결 끊김 → RECONNECT_GRACE_MS 동안 자리 유지(room:rejoin 가능)
   */
  const detachFromRoom = (mode) => {
    const code = socket.data.roomCode;
    if (!code) return;
    const id = pid();
    socket.data.roomCode = null;
    socket.data.playerId = null;
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;
    if (mode === 'disconnect') room.markDisconnected(id);
    else room.removePlayer(id, 'left');
    deleteRoomIfEmpty(room);
  };
  const leaveCurrentRoom = () => detachFromRoom('leave');

  /**
   * 기존 플레이어 자리(p)에 이 소켓을 붙인다. 옛 소켓이 아직 살아 있으면(새로고침 경합·다른 탭)
   * 그쪽에 session:replaced 를 보내고 방에서 떼어낸다 — 그 소켓의 disconnect 는 이후 no-op 이 된다.
   */
  const attachToExisting = (room, p, ack, extra) => {
    const code = room.code;
    if (p.connected && p.socketId && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) {
        old.emit('session:replaced', { message: '다른 탭이나 기기에서 이 자리로 접속해 이 화면은 종료됐어요.' });
        old.data.roomCode = null;
        old.data.playerId = null;
        old.leave(code);
      }
    }
    leaveCurrentRoom();
    socket.data.roomCode = code;
    socket.data.playerId = p.id;
    socket.join(code);
    ack({ ok: true, roomCode: code, playerId: p.id, token: p.token });
    room.reconnect(p.id, socket.id, extra || {});
  };

  /** (data, ack) 인자 정규화 — 클라이언트가 data 없이 ack 만 보낸 경우 대비 */
  const normalizeArgs = (data, ack) => {
    if (typeof data === 'function') return [{}, data];
    return [data && typeof data === 'object' ? data : {}, typeof ack === 'function' ? ack : () => {}];
  };

  // room:create { name, avatar } → ack { ok, roomCode, playerId } | { ok:false, error }
  on('room:create', (rawData, rawAck) => {
    const [data, ack] = normalizeArgs(rawData, rawAck);
    const name = sanitizeName(data.name);
    if (!name) return ack({ ok: false, error: '이름은 1~12자여야 합니다.' });
    const avatar = sanitizeAvatar(data.avatar);

    leaveCurrentRoom();
    const code = generateRoomCode();
    if (!code) return ack({ ok: false, error: '방을 만들 수 없습니다. 잠시 후 다시 시도해 주세요.' });

    const room = new Room(io, code);
    room.onEmpty = deleteRoomIfEmpty; // 유예 시간 만료로 마지막 사람이 빠질 때 방 정리
    rooms.set(code, room);
    const token = sanitizeToken(data.token);
    socket.data.roomCode = code;
    socket.data.playerId = socket.id;
    socket.join(code);
    ack({ ok: true, roomCode: code, playerId: socket.id, token });
    room.addPlayer({ id: socket.id, name, avatar, token, socketId: socket.id });
    console.log(`[draw-guess] room ${code} created by ${name}. rooms=${rooms.size}`);
  });

  // room:join { roomCode, name, avatar } → ack 동일
  on('room:join', (rawData, rawAck) => {
    const [data, ack] = normalizeArgs(rawData, rawAck);
    const code = typeof data.roomCode === 'string' ? data.roomCode.trim().toUpperCase() : '';
    if (!CODE_RE.test(code)) return ack({ ok: false, error: '방 코드는 영문 4글자입니다.' });
    const name = sanitizeName(data.name);
    if (!name) return ack({ ok: false, error: '이름은 1~12자여야 합니다.' });
    const avatar = sanitizeAvatar(data.avatar);

    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: '존재하지 않는 방입니다.' });
    if (socket.data.roomCode === code && room.getPlayer(pid())) {
      return ack({ ok: false, error: '이미 이 방에 참가 중입니다.' });
    }
    const token = sanitizeToken(data.token);
    const existing = room.findByToken(token);
    if (existing) {
      // 같은 브라우저(토큰)가 이미 이 방에 있다 → 중복 참가 대신 그 자리로 복귀(이름·아바타는 새 값으로 갱신)
      attachToExisting(room, existing, ack, { name, avatar });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      return ack({ ok: false, error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` });
    }

    leaveCurrentRoom(); // 다른 방에 있었다면 먼저 나간다
    if (!rooms.has(code)) return ack({ ok: false, error: '존재하지 않는 방입니다.' });

    socket.data.roomCode = code;
    socket.data.playerId = socket.id;
    socket.join(code);
    ack({ ok: true, roomCode: code, playerId: socket.id, token });
    room.addPlayer({ id: socket.id, name, avatar, token, socketId: socket.id });
  });

  // room:rejoin { roomCode, token } → ack { ok, roomCode, playerId, token } | { ok:false, error }
  // 연결이 끊긴 지 RECONNECT_GRACE_MS 안이면 같은 playerId·점수로 복귀한다.
  on('room:rejoin', (rawData, rawAck) => {
    const [data, ack] = normalizeArgs(rawData, rawAck);
    const code = typeof data.roomCode === 'string' ? data.roomCode.trim().toUpperCase() : '';
    const token = typeof data.token === 'string' && TOKEN_RE.test(data.token) ? data.token : null;
    if (!CODE_RE.test(code) || !token) return ack({ ok: false, error: '재접속 정보가 올바르지 않습니다.' });
    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: '방이 더 이상 존재하지 않습니다.' });
    const p = room.findByToken(token);
    if (!p) return ack({ ok: false, error: '이어서 할 수 있는 자리가 없습니다. 다시 참가해 주세요.' });
    attachToExisting(room, p, ack);
  });

  // react:send { kind:'up'|'down' } — drawing 중 비출제자. 초당 REACT_LIMIT_PER_SEC 회까지.
  on('react:send', (data) => {
    const room = currentRoom();
    if (!room) return;
    const kind = data && data.kind === 'down' ? 'down' : 'up';
    const now = Date.now();
    const times = socket.data.reactTimes.filter((t) => now - t < 1000);
    if (times.length >= REACT_LIMIT_PER_SEC) { socket.data.reactTimes = times; return; }
    times.push(now);
    socket.data.reactTimes = times;
    room.react(pid(), kind);
  });

  // room:leave
  on('room:leave', () => {
    leaveCurrentRoom();
  });

  // room:settings { settings } — 호스트, lobby
  on('room:settings', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const err = room.updateSettings(pid(), data && data.settings);
    if (err) fail(err);
  });

  // game:start — 호스트, lobby, 2명 이상
  on('game:start', () => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const err = room.start(pid());
    if (err) fail(err);
  });

  // word:choose { word } — 출제자, choosing
  on('word:choose', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const err = room.chooseWord(pid(), data && data.word);
    if (err) fail(err);
  });

  // draw:* — 출제자, drawing. 위반/잘못된 페이로드는 조용히 무시
  on('draw:start', (data) => {
    const room = currentRoom();
    if (room) room.handleDraw(pid(), 'start', data);
  });
  on('draw:move', (data) => {
    const room = currentRoom();
    if (room) room.handleDraw(pid(), 'move', data);
  });
  on('draw:end', () => {
    const room = currentRoom();
    if (room) room.handleDraw(pid(), 'end');
  });
  on('draw:fill', (data) => {
    const room = currentRoom();
    if (room) room.handleDraw(pid(), 'fill', data);
  });
  on('draw:clear', () => {
    const room = currentRoom();
    if (room) room.handleDraw(pid(), 'clear');
  });
  on('draw:undo', () => {
    const room = currentRoom();
    if (room) room.handleDraw(pid(), 'undo');
  });

  // chat:message { text } — 1..100자, 정답 판정은 Room 이 수행
  on('chat:message', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const text = sanitizeChat(data && data.text);
    if (!text) return fail(`메시지는 1~${MAX_CHAT_LEN}자여야 합니다.`);
    const err = room.handleChat(pid(), text);
    if (err) fail(err);
  });

  // player:kick { playerId } — 호스트
  on('player:kick', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    if (!room.isHost(pid())) return fail('호스트만 강퇴할 수 있습니다.');
    const targetId = data && typeof data.playerId === 'string' ? data.playerId : null;
    if (!targetId || targetId === pid() || !room.getPlayer(targetId)) {
      return fail('강퇴할 수 없는 플레이어입니다.');
    }
    const targetPlayer = room.getPlayer(targetId);
    const target = targetPlayer.socketId ? io.sockets.sockets.get(targetPlayer.socketId) : null;
    if (target) {
      target.emit('error:msg', { message: '호스트에 의해 방에서 내보내졌습니다.' });
      target.leave(room.code);
      target.data.roomCode = null;
      target.data.playerId = null;
    }
    room.removePlayer(targetId, 'kicked');
    deleteRoomIfEmpty(room);
  });

  // 연결 끊김 → 유예 시간 동안 자리 유지 (RECONNECT_GRACE_MS=0 이면 즉시 퇴장)
  socket.on('disconnect', () => {
    try {
      detachFromRoom('disconnect');
    } catch (err) {
      console.error('[draw-guess] disconnect handler error:', err);
    }
  });
});

server.on('error', (err) => {
  console.error('[draw-guess] server error:', err.message);
  process.exit(1);
});

// Render 무료 플랜은 15분간 요청이 없으면 잠든다. 공개 URL이 있으면 10분마다 스스로 핑을 보내 깨어 있게 한다.
// Render는 RENDER_EXTERNAL_URL 을 자동으로 넣어 준다. 다른 호스팅에서는 KEEP_ALIVE_URL 로 지정.
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '';
const KEEP_ALIVE_MS = 10 * 60 * 1000;
function startKeepAlive() {
  if (!KEEP_ALIVE_URL) return;
  const target = KEEP_ALIVE_URL.replace(/\/+$/, '') + '/healthz';
  const ping = () => fetch(target).catch((err) => console.warn('[keep-alive] ping failed:', err.message));
  setInterval(ping, KEEP_ALIVE_MS).unref();
  console.log(`[keep-alive] pinging ${target} every ${KEEP_ALIVE_MS / 60000} min`);
}

server.listen(PORT, () => {
  console.log(`[draw-guess] listening on http://localhost:${PORT} (asset version ${ASSET_VERSION})`);
  startKeepAlive();
});
