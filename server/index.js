'use strict';
/**
 * index.js — draw-guess 서버 진입점
 *  - express@4 로 public/ 정적 서빙
 *  - socket.io@4 로 PROTOCOL.md 의 C→S 이벤트 처리 (검증 후 Room 에 위임)
 *  - rooms: Map<roomCode, Room>
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 12;
const MAX_CHAT_LEN = 100;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const CODE_RE = /^[A-Z]{4}$/;
const DEFAULT_AVATAR = { emoji: '🙂', color: '#4f8cff' };

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

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

  const fail = (message) => socket.emit('error:msg', { message });

  /** 현재 소켓이 속한 Room (없으면 null, 스테일 코드는 정리) */
  const currentRoom = () => {
    const code = socket.data.roomCode;
    if (!code) return null;
    const room = rooms.get(code);
    if (!room || !room.getPlayer(socket.id)) {
      socket.data.roomCode = null;
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

  /** 현재 방에서 나가기 (room:leave / disconnect / 새 방 생성 전) */
  const leaveCurrentRoom = () => {
    const code = socket.data.roomCode;
    if (!code) return;
    socket.data.roomCode = null;
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;
    room.removePlayer(socket.id, 'left');
    deleteRoomIfEmpty(room);
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
    rooms.set(code, room);
    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, roomCode: code, playerId: socket.id });
    room.addPlayer({ id: socket.id, name, avatar });
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
    if (socket.data.roomCode === code && room.getPlayer(socket.id)) {
      return ack({ ok: false, error: '이미 이 방에 참가 중입니다.' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return ack({ ok: false, error: `방이 가득 찼습니다. (최대 ${MAX_PLAYERS}명)` });
    }

    leaveCurrentRoom(); // 다른 방에 있었다면 먼저 나간다
    if (!rooms.has(code)) return ack({ ok: false, error: '존재하지 않는 방입니다.' });

    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, roomCode: code, playerId: socket.id });
    room.addPlayer({ id: socket.id, name, avatar });
  });

  // room:leave
  on('room:leave', () => {
    leaveCurrentRoom();
  });

  // room:settings { settings } — 호스트, lobby
  on('room:settings', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const err = room.updateSettings(socket.id, data && data.settings);
    if (err) fail(err);
  });

  // game:start — 호스트, lobby, 2명 이상
  on('game:start', () => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const err = room.start(socket.id);
    if (err) fail(err);
  });

  // word:choose { word } — 출제자, choosing
  on('word:choose', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const err = room.chooseWord(socket.id, data && data.word);
    if (err) fail(err);
  });

  // draw:* — 출제자, drawing. 위반/잘못된 페이로드는 조용히 무시
  on('draw:start', (data) => {
    const room = currentRoom();
    if (room) room.handleDraw(socket.id, 'start', data);
  });
  on('draw:move', (data) => {
    const room = currentRoom();
    if (room) room.handleDraw(socket.id, 'move', data);
  });
  on('draw:end', () => {
    const room = currentRoom();
    if (room) room.handleDraw(socket.id, 'end');
  });
  on('draw:fill', (data) => {
    const room = currentRoom();
    if (room) room.handleDraw(socket.id, 'fill', data);
  });
  on('draw:clear', () => {
    const room = currentRoom();
    if (room) room.handleDraw(socket.id, 'clear');
  });
  on('draw:undo', () => {
    const room = currentRoom();
    if (room) room.handleDraw(socket.id, 'undo');
  });

  // chat:message { text } — 1..100자, 정답 판정은 Room 이 수행
  on('chat:message', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    const text = sanitizeChat(data && data.text);
    if (!text) return fail(`메시지는 1~${MAX_CHAT_LEN}자여야 합니다.`);
    const err = room.handleChat(socket.id, text);
    if (err) fail(err);
  });

  // player:kick { playerId } — 호스트
  on('player:kick', (data) => {
    const room = currentRoom();
    if (!room) return fail('방에 참가하지 않았습니다.');
    if (!room.isHost(socket.id)) return fail('호스트만 강퇴할 수 있습니다.');
    const targetId = data && typeof data.playerId === 'string' ? data.playerId : null;
    if (!targetId || targetId === socket.id || !room.getPlayer(targetId)) {
      return fail('강퇴할 수 없는 플레이어입니다.');
    }
    const target = io.sockets.sockets.get(targetId);
    if (target) {
      target.emit('error:msg', { message: '호스트에 의해 방에서 내보내졌습니다.' });
      target.leave(room.code);
      target.data.roomCode = null;
    }
    room.removePlayer(targetId, 'kicked');
    deleteRoomIfEmpty(room);
  });

  // 연결 끊김 = 즉시 퇴장
  socket.on('disconnect', () => {
    try {
      leaveCurrentRoom();
    } catch (err) {
      console.error('[draw-guess] disconnect handler error:', err);
    }
  });
});

server.on('error', (err) => {
  console.error('[draw-guess] server error:', err.message);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[draw-guess] listening on http://localhost:${PORT}`);
});
