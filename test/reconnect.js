/**
 * 재접속 + 반응 시뮬레이션 (socket.io-client)
 *  - P2가 drawing 중 연결이 끊겨도 유예 시간 동안 자리·점수가 유지되는지
 *  - room:rejoin 으로 같은 playerId로 복귀하고 catch-up(game:drawing, draw:sync, 전체 공개)을 받는지
 *  - 복귀 후 정답을 맞혀 점수가 누적되는지
 *  - 유예 시간이 지나면 퇴장 처리되는지 (RECONNECT_GRACE_MS=2500 으로 짧게)
 *  - react:send → react:show 중계, 출제자/비-drawing 단계에서는 무시되는지
 *  node test/reconnect.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3125;
const URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const GRACE_MS = 2500;

let passes = 0, failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) passes += 1; else failures += 1;
  const suffix = !ok && detail !== undefined ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${suffix}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let serverProc = null;
const clients = [];
function cleanup(code) {
  for (const c of clients) { try { c.disconnect(); } catch (_) { /* ignore */ } }
  if (serverProc) { try { serverProc.kill(); } catch (_) { /* ignore */ } }
  console.log(`\n${passes} passed, ${failures} failed`);
  setTimeout(() => process.exit(code), 300);
}
setTimeout(() => { console.log('FAIL - overall timeout'); cleanup(2); }, 90000);

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: String(GRACE_MS) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d));
    serverProc.on('exit', () => reject(new Error('server exited')));
  });
}

function connect(label) {
  const c = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true });
  c.label = label;
  c.log = [];
  c.onAny((ev, payload) => c.log.push({ ev, payload, t: Date.now() }));
  clients.push(c);
  return new Promise((resolve, reject) => {
    c.once('connect', () => { c.playerId = c.id; resolve(c); });
    c.once('connect_error', reject);
  });
}
function emitAck(c, ev, data) {
  return new Promise((resolve) => c.emit(ev, data, resolve));
}
function waitFor(c, ev, pred, timeout = 8000, label = '') {
  return new Promise((resolve, reject) => {
    const hit = c.log.find((e) => e.ev === ev && (!pred || pred(e.payload)));
    if (hit) return resolve(hit.payload);
    const timer = setTimeout(() => { c.off(ev, h); reject(new Error(`timeout waiting ${ev} ${label}`)); }, timeout);
    const h = (p) => { if (!pred || pred(p)) { clearTimeout(timer); c.off(ev, h); resolve(p); } };
    c.on(ev, h);
  });
}
/** waitFor 와 달리 과거 로그를 보지 않고 "지금부터" 오는 이벤트만 기다린다 (오래된 room:state 오탐 방지) */
function waitNext(c, ev, pred, timeout = 8000, label = '') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.off(ev, h); reject(new Error(`timeout waiting next ${ev} ${label}`)); }, timeout);
    const h = (p) => { if (!pred || pred(p)) { clearTimeout(timer); c.off(ev, h); resolve(p); } };
    c.on(ev, h);
  });
}
const byId = (list, id) => list.find((p) => p.id === id);

(async () => {
  await startServer();

  // ── 방 만들기 + 참가 (토큰 명시) ─────────────────────────────
  const c1 = await connect('P1');
  const c2 = await connect('P2');
  const TOKEN2 = 'tok-p2-reconnect-0001';
  const created = await emitAck(c1, 'room:create', { name: '호스트', avatar: { emoji: '🙂', color: '#ff0000' }, token: 'tok-p1-abcdefgh' });
  check('room:create ack returns token as given', created.ok && created.token === 'tok-p1-abcdefgh', created);
  const code = created.roomCode;
  const joined = await emitAck(c2, 'room:join', { roomCode: code, name: '둘째', avatar: {}, token: TOKEN2 });
  check('room:join ack returns token', joined.ok && joined.token === TOKEN2 && joined.playerId === c2.id, joined);
  const noTok = await connect('P3');
  const j3 = await emitAck(noTok, 'room:join', { roomCode: code, name: '셋째', avatar: {} });
  check('join without token → server issues one (hex 32)', j3.ok && /^[0-9a-f]{32}$/.test(j3.token), j3);
  noTok.emit('room:leave');
  await waitFor(c1, 'room:state', (s) => s.players.length === 2, 5000, 'P3 left');

  const st0 = c1.log.filter((e) => e.ev === 'room:state').pop().payload;
  check('room:state players carry connected:true', st0.players.every((p) => p.connected === true), st0.players);

  // ── 게임 시작: P1 출제, P2 정답자 ────────────────────────────
  c1.emit('room:settings', { settings: { rounds: 1, drawTime: 60, hints: 0, wordCount: 2, customWords: '자전거,냉장고,해바라기,고슴도치', customWordsOnly: true } });
  await waitFor(c1, 'room:state', (s) => s.settings.customWordsOnly === true);
  c1.emit('game:start');
  const ch = await waitFor(c1, 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, 'P1 choosing');
  const word = ch.wordOptions[0];
  c1.emit('word:choose', { word });
  const d2 = await waitFor(c2, 'game:drawing', undefined, 5000, 'P2 drawing');
  check('P2 in drawing with mask (no word)', d2.word === undefined && typeof d2.wordMask === 'string', d2);

  // 출제자가 그림 몇 개 그려둠 (재접속 시 draw:sync 로 복원되어야 함)
  c1.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 10, y: 10 });
  c1.emit('draw:move', { pts: [[20, 20], [30, 30]] });
  c1.emit('draw:end');
  c1.emit('draw:fill', { x: 700, y: 500, color: '#ff0000' });
  await sleep(150);

  // ── 반응(👍👎) ───────────────────────────────────────────────
  const reactP = waitFor(c1, 'react:show', (p) => p.id === c2.id && p.kind === 'up', 3000, 'react up');
  c2.emit('react:send', { kind: 'up' });
  const rs = await reactP;
  check('react:send(up) by guesser → react:show {id, kind} to all', rs.id === c2.id && rs.kind === 'up', rs);
  const selfSaw = await waitFor(c2, 'react:show', (p) => p.id === c2.id && p.kind === 'up', 3000, 'self react').then(() => true).catch(() => false);
  check('sender also receives react:show (own avatar animates)', selfSaw);
  const beforeCount = c1.log.filter((e) => e.ev === 'react:show').length;
  for (let i = 0; i < 20; i++) c2.emit('react:send', { kind: 'down' }); // 연타 → 초당 8회 제한
  await sleep(400);
  const burst = c1.log.filter((e) => e.ev === 'react:show').length - beforeCount;
  check(`burst of 20 reacts in <1s is rate-limited to ≤8 (got ${burst})`, burst >= 1 && burst <= 8, burst);
  const drawerReactBefore = c1.log.filter((e) => e.ev === 'react:show').length;
  c1.emit('react:send', { kind: 'up' }); // 출제자는 무시
  await sleep(300);
  check('drawer react:send is ignored', c1.log.filter((e) => e.ev === 'react:show').length === drawerReactBefore);

  // ── P2 연결 끊김 → 유예 상태 ─────────────────────────────────
  const p2Id = c2.playerId;
  const offP = waitFor(c1, 'room:state', (s) => byId(s.players, p2Id) && byId(s.players, p2Id).connected === false, 5000, 'P2 offline');
  c2.disconnect();
  const offState = await offP;
  check('after P2 disconnect: still in players, connected:false, score kept', offState.players.length === 2 && byId(offState.players, p2Id).connected === false, offState.players);
  check('phase stays drawing (guesser disconnect does not end the turn)', offState.phase === 'drawing', offState.phase);
  check('system message announces disconnect with grace seconds', c1.log.some((e) => e.ev === 'chat:message' && e.payload.kind === 'system' && /연결이 끊어졌습니다/.test(e.payload.text)));

  // ── 잘못된 토큰으로 rejoin → 거절 ───────────────────────────
  const bad = await connect('P2-bad');
  const badAck = await emitAck(bad, 'room:rejoin', { roomCode: code, token: 'wrong-token-zzzz' });
  check('room:rejoin with unknown token → ok:false', badAck && badAck.ok === false, badAck);
  bad.disconnect();

  // ── 올바른 토큰으로 rejoin ───────────────────────────────────
  const c2b = await connect('P2-again');
  const rj = await emitAck(c2b, 'room:rejoin', { roomCode: code, token: TOKEN2 });
  check('room:rejoin ok with SAME playerId (old socket id)', rj.ok === true && rj.playerId === p2Id && rj.roomCode === code, rj);
  const stBack = await waitFor(c2b, 'room:state', (s) => byId(s.players, p2Id) && byId(s.players, p2Id).connected === true, 5000, 'P2 back');
  check('room:state after rejoin: connected:true, 2 players', stBack.players.length === 2, stBack.players);
  const dBack = await waitFor(c2b, 'game:drawing', undefined, 5000, 'catch-up drawing');
  check('catch-up game:drawing to rejoined P2 (mask, no word)', dBack.word === undefined && dBack.wordMask === d2.wordMask && dBack.timeLeft <= 60, dBack);
  const sync = await waitFor(c2b, 'draw:sync', undefined, 5000, 'catch-up sync');
  check('catch-up draw:sync restores ops (stroke + fill)', Array.isArray(sync.ops) && sync.ops.length === 2 && sync.ops[0].type === 'stroke' && sync.ops[1].type === 'fill', sync.ops);
  check('system message announces reconnect', c1.log.some((e) => e.ev === 'chat:message' && e.payload.kind === 'system' && /다시 연결되었습니다/.test(e.payload.text)));

  // ── 복귀한 P2가 정답 → 점수 누적, 출제자에게 guessed-chat 라우팅 정상 ──
  const correctP = waitFor(c1, 'chat:message', (m) => m.kind === 'correct' && m.id === p2Id, 5000, 'correct');
  c2b.emit('chat:message', { text: word });
  await correctP;
  const revealed = await waitFor(c2b, 'game:hint', (h) => h.wordMask.replace(/ /g, '') === word, 3000, 'full reveal');
  check('rejoined guesser gets full reveal via game:hint after correct guess', !!revealed);
  const te = await waitFor(c2b, 'game:turnEnd', undefined, 8000, 'turnEnd');
  check('turn ends allGuessed; P2 (rejoined) has delta > 0', te.reason === 'allGuessed' && (te.deltas.find((d) => d.id === p2Id) || {}).delta > 0, te);
  const stEnd = await waitFor(c1, 'room:state', (s) => byId(s.players, p2Id) && byId(s.players, p2Id).score > 0, 5000, 'P2 score');
  check('P2 score accumulated on the SAME player entry', byId(stEnd.players, p2Id).score > 0 && byId(stEnd.players, p2Id).connected === true, stEnd.players);

  // ── 다음 턴: 복귀한 P2가 자기 순서대로 출제자가 된다 (turnOrder에 그대로 남아 있음) ──
  const ch2 = await waitNext(c2b, 'game:choosing', (p) => p.drawerId === p2Id && Array.isArray(p.wordOptions), 10000, 'P2 turn');
  check('rejoined player keeps their turn slot (P2 becomes drawer next)', ch2.drawerId === p2Id && ch2.wordOptions.length > 0, ch2);
  const p1DrawingP = waitNext(c1, 'game:drawing', undefined, 5000, 'P1 guessing');
  c2b.emit('word:choose', { word: ch2.wordOptions[0] });
  await p1DrawingP;
  const overP = waitNext(c1, 'game:over', undefined, 15000, 'game over');
  c1.emit('chat:message', { text: ch2.wordOptions[0] });
  const over = await overP;
  check('game over ranking includes the rejoined P2 with accumulated score', !!byId(over.ranking, p2Id) && byId(over.ranking, p2Id).score > 0, over.ranking);

  // ── 게임 종료 후 lobby: P2 다시 끊고 유예 만료 → 퇴장 ─────────
  await waitNext(c1, 'room:state', (s) => s.phase === 'lobby', 20000, 'back to lobby');
  const leftP = waitNext(c1, 'chat:message', (m) => m.kind === 'system' && /둘째님이 나갔습니다/.test(m.text), GRACE_MS + 4000, 'grace expiry');
  const goneP = waitNext(c1, 'room:state', (s) => s.players.length === 1, GRACE_MS + 4000, 'P2 removed');
  c2b.disconnect();
  const t0 = Date.now();
  await leftP;
  const elapsed = Date.now() - t0;
  check(`grace expiry removes player after ~${GRACE_MS}ms (took ${elapsed}ms)`, elapsed >= GRACE_MS - 200 && elapsed < GRACE_MS + 3000, elapsed);
  const stGone = await goneP;
  check('after grace expiry: 1 player left, host still P1', stGone.players.length === 1 && stGone.hostId === c1.playerId, stGone);

  // ── 토큰으로 이미 만료된 자리에 rejoin → 거절 ───────────────
  const late = await connect('P2-late');
  const lateAck = await emitAck(late, 'room:rejoin', { roomCode: code, token: TOKEN2 });
  check('rejoin after grace expiry → ok:false', lateAck && lateAck.ok === false, lateAck);

  // ── 호스트가 끊기면 접속 중인 사람에게 호스트 승계 (복귀해도 안 돌려받음) ──
  const c4 = await connect('P4');
  const j4 = await emitAck(c4, 'room:join', { roomCode: code, name: '넷째', avatar: {}, token: 'tok-p4-abcdefgh' });
  check('P4 joins', j4.ok);
  const hostOffP = waitNext(c4, 'room:state', (s) => s.hostId === c4.playerId, 5000, 'host handoff');
  const P1_TOKEN = 'tok-p1-abcdefgh';
  c1.disconnect();
  const hs = await hostOffP;
  check('host disconnect → host handed to connected P4 immediately', hs.hostId === c4.playerId && byId(hs.players, created.playerId).connected === false, hs);
  const c1b = await connect('P1-again');
  const afterBackP = waitNext(c4, 'room:state', (s) => byId(s.players, created.playerId) && byId(s.players, created.playerId).connected === true, 5000, 'P1 back');
  const rj1 = await emitAck(c1b, 'room:rejoin', { roomCode: code, token: P1_TOKEN });
  const afterBack = await afterBackP;
  check('P1 rejoins with same id but host stays with P4', rj1.ok && rj1.playerId === created.playerId && afterBack.hostId === c4.playerId, afterBack);

  cleanup(failures ? 1 : 0);
})().catch((err) => {
  check(`unexpected error: ${err && err.message}`, false, err && err.stack);
  cleanup(1);
});
