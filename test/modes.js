/**
 * 게임 모드 시뮬레이션 (socket.io-client)
 *  - 대기실 단계: 새 방 lobbyStep='mode' → 호스트가 mode 설정 + lobby:step 'settings' → 게임 종료 후 'settings' 유지
 *  - fixed(한 명이 그리기): 지정 출제자(P2)가 모든 턴 출제, rounds=단어 수, 출제자 점수 0·랭킹 제외, game:over.drawer
 *  - 지정 출제자가 나가면 호스트가 이어서 출제
 *  node test/modes.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3129;
const URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');

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
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: '1500' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d));
    serverProc.on('exit', () => reject(new Error('server exited')));
  });
}
function connect(label) {
  const c = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true });
  c.label = label; c.log = [];
  c.onAny((ev, payload) => c.log.push({ ev, payload }));
  clients.push(c);
  return new Promise((resolve, reject) => {
    c.once('connect', () => { c.playerId = c.id; resolve(c); });
    c.once('connect_error', reject);
  });
}
const emitAck = (c, ev, data) => new Promise((resolve) => c.emit(ev, data, resolve));
function waitNext(c, ev, pred, timeout = 8000, label = '') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.off(ev, h); reject(new Error(`timeout waiting ${ev} ${label}`)); }, timeout);
    const h = (p) => { if (!pred || pred(p)) { clearTimeout(timer); c.off(ev, h); resolve(p); } };
    c.on(ev, h);
  });
}
const byId = (list, id) => list.find((p) => p.id === id);
const lastState = (c) => { const e = c.log.filter((x) => x.ev === 'room:state').pop(); return e ? e.payload : null; };

(async () => {
  await startServer();
  const c1 = await connect('P1'), c2 = await connect('P2'), c3 = await connect('P3');
  const created = await emitAck(c1, 'room:create', { name: '호스트', avatar: {}, token: 'tok-p1-modes-000001' });
  const code = created.roomCode;
  await emitAck(c2, 'room:join', { roomCode: code, name: '둘째', avatar: {}, token: 'tok-p2-modes-000002' });
  await emitAck(c3, 'room:join', { roomCode: code, name: '셋째', avatar: {}, token: 'tok-p3-modes-000003' });
  const P1 = created.playerId, P2 = c2.playerId, P3 = c3.playerId;
  await sleep(200);

  // ── 대기실 단계 ────────────────────────────────────────────────
  const st0 = lastState(c3);
  check('new room starts at lobbyStep=mode, mode=classic, fixedDrawerId null', st0.lobbyStep === 'mode' && st0.settings.mode === 'classic' && st0.fixedDrawerId === null, st0);
  const errP = waitNext(c2, 'error:msg', undefined, 3000);
  c2.emit('lobby:step', { step: 'settings' });
  check('non-host lobby:step → error', typeof (await errP).message === 'string');

  const stepP = waitNext(c3, 'room:state', (s) => s.lobbyStep === 'settings' && s.settings.mode === 'fixed', 5000, 'mode+step');
  c1.emit('room:settings', { settings: { mode: 'fixed', fixedDrawerId: P2, rounds: 2, drawTime: 60, hints: 0, wordCount: 2, customWords: '자전거,냉장고,해바라기,고슴도치,선풍기', customWordsOnly: true } });
  c1.emit('lobby:step', { step: 'settings' });
  const st1 = await stepP;
  check('host sets mode=fixed + fixedDrawerId=P2 and moves to settings', st1.fixedDrawerId === P2 && st1.settings.fixedDrawerId === P2, st1.settings);
  const badP = waitNext(c3, 'room:state', (s) => s.settings.fixedDrawerId === null, 3000, 'bad drawer id');
  c1.emit('room:settings', { settings: { fixedDrawerId: 'not-a-player' } });
  const stBad = await badP;
  check('unknown fixedDrawerId → null (falls back to host), state.fixedDrawerId=host', stBad.fixedDrawerId === P1, stBad.fixedDrawerId);
  const backP = waitNext(c3, 'room:state', (s) => s.settings.fixedDrawerId === P2, 3000);
  c1.emit('room:settings', { settings: { fixedDrawerId: P2 } });
  await backP;
  const modeBackP = waitNext(c3, 'room:state', (s) => s.lobbyStep === 'mode', 3000);
  c1.emit('lobby:step', { step: 'mode' });
  await modeBackP;
  check('host can go back to mode step', true);
  c1.emit('lobby:step', { step: 'settings' });
  await waitNext(c3, 'room:state', (s) => s.lobbyStep === 'settings', 3000);

  // ── fixed 게임: P2가 두 턴 모두 출제 ──────────────────────────
  const ch1P = waitNext(c2, 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, 'P2 choosing');
  const ch1otherP = waitNext(c1, 'game:choosing', undefined, 5000);
  const stChP = waitNext(c1, 'room:state', (s) => s.phase === 'choosing' && s.round === 1, 5000, 'state round1');
  c1.emit('game:start');
  const ch1 = await ch1P; const ch1o = await ch1otherP;
  check('turn 1 drawer is the fixed drawer (P2), host gets no options', ch1.drawerId === P2 && ch1o.wordOptions === undefined, { ch1, ch1o });
  const stCh = await stChP;
  check('room:state during game: nextDrawerId = P2 (round 1 of 2), fixedDrawerId=P2', stCh.nextDrawerId === P2 && stCh.fixedDrawerId === P2 && stCh.round === 1 && stCh.totalRounds === 2, stCh);
  const d1P = waitNext(c1, 'game:drawing', undefined, 5000);
  c2.emit('word:choose', { word: ch1.wordOptions[0] });
  await d1P;
  c2.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 1, y: 1 }); c2.emit('draw:end');
  const te1P = waitNext(c1, 'game:turnEnd', undefined, 8000, 'turnEnd 1');
  c1.emit('chat:message', { text: ch1.wordOptions[0] });
  c3.emit('chat:message', { text: ch1.wordOptions[0] });
  const te1 = await te1P;
  const dP2 = te1.deltas.find((d) => d.id === P2);
  check('turn 1 allGuessed; fixed drawer P2 earns 0, guessers earn > 0', te1.reason === 'allGuessed' && dP2 && dP2.delta === 0 && te1.deltas.filter((d) => d.id !== P2).every((d) => d.delta > 0), te1.deltas);

  const ch2P = waitNext(c2, 'game:choosing', (p) => Array.isArray(p.wordOptions), 10000, 'P2 choosing 2');
  const stCh2P = waitNext(c1, 'room:state', (s) => s.phase === 'choosing' && s.round === 2, 10000, 'state round2');
  const ch2 = await ch2P;
  check('turn 2 (round 2) drawer is still P2', ch2.drawerId === P2, ch2);
  const stCh2 = await stCh2P;
  check('round 2 of 2: nextDrawerId null (last word)', stCh2.round === 2 && stCh2.nextDrawerId === null, stCh2);
  const d2P = waitNext(c1, 'game:drawing', undefined, 5000);
  c2.emit('word:choose', { word: ch2.wordOptions[0] });
  await d2P;
  const overP = waitNext(c1, 'game:over', undefined, 10000, 'game over');
  c1.emit('chat:message', { text: ch2.wordOptions[0] });
  c3.emit('chat:message', { text: ch2.wordOptions[0] });
  const over = await overP;
  check('game:over mode=fixed, drawer=P2, ranking excludes P2 (2 entries)', over.mode === 'fixed' && over.drawer && over.drawer.id === P2 && over.ranking.length === 2 && !byId(over.ranking, P2), over);
  check('gallery has 2 drawings by P2', Array.isArray(over.gallery) && over.gallery.length === 2 && over.gallery.every((g) => g.drawerId === P2), over.gallery && over.gallery.map((g) => g.word));

  const lobbyP = waitNext(c1, 'room:state', (s) => s.phase === 'lobby', 15000, 'back to lobby');
  const stLobby = await lobbyP;
  check('back in lobby: lobbyStep=settings, mode kept (fixed), fixedDrawerId kept', stLobby.lobbyStep === 'settings' && stLobby.settings.mode === 'fixed' && stLobby.fixedDrawerId === P2, stLobby);

  // ── 지정 출제자가 나가면 → 호스트로 ─────────────────────────────
  const leftP = waitNext(c1, 'room:state', (s) => s.players.length === 2 && s.fixedDrawerId === P1, 5000, 'drawer left');
  c2.emit('room:leave');
  const stLeft = await leftP;
  check('fixed drawer leaves → fixedDrawerId falls back to host', stLeft.settings.fixedDrawerId === null && stLeft.fixedDrawerId === P1, stLeft);

  // ── 출제자가 끊긴 채로는 시작 불가 (접속 인원은 2명 이상으로 유지) ──
  const c4 = await connect('P4');
  await emitAck(c4, 'room:join', { roomCode: code, name: '넷째', avatar: {}, token: 'tok-p4-modes-000004' });
  c1.emit('room:settings', { settings: { fixedDrawerId: P3 } });
  await waitNext(c1, 'room:state', (s) => s.fixedDrawerId === P3, 3000);
  const offP = waitNext(c1, 'room:state', (s) => byId(s.players, P3) && byId(s.players, P3).connected === false, 5000);
  c3.disconnect();
  await offP;
  const startErrP = waitNext(c1, 'error:msg', undefined, 3000);
  c1.emit('game:start');
  const se = await startErrP;
  check('game:start refused while fixed drawer is disconnected', /출제자/.test(se.message), se);

  cleanup(failures ? 1 : 0);
})().catch((err) => {
  check(`unexpected error: ${err && err.message}`, false, err && err.stack);
  cleanup(1);
});
