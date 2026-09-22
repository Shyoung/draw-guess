/**
 * 배포/재시작 복원 시뮬레이션 (socket.io-client + file 저장소)
 *  1) 서버 A를 STORE_URL=file:... 로 띄우고 방을 만들어 drawing 단계까지 진행(그림 + 정답 1명)
 *  2) 서버 A를 SIGTERM 으로 내림(배포와 같은 상황) → 스냅샷이 저장돼 있어야 함
 *  3) 같은 포트로 서버 B를 띄움 → 방이 복원되고, 클라이언트들이 토큰으로 rejoin 하면
 *     같은 playerId·점수·phase(drawing)·마스크·그림(ops)·남은 시간으로 이어진다
 *  4) 복원된 게임이 정상적으로 끝까지 진행되는지(정답 → turnEnd) 확인
 *  node test/persist.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = 3127;
const URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'test', '.tmp-state.json');

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
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* ignore */ }
  console.log(`\n${passes} passed, ${failures} failed`);
  setTimeout(() => process.exit(code), 300);
}
setTimeout(() => { console.log('FAIL - overall timeout'); cleanup(2); }, 90000);

function startServer(label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), STORE_URL: 'file:' + STATE_FILE, RECONNECT_GRACE_MS: '60000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.logs = '';
    proc.stdout.on('data', (d) => { proc.logs += String(d); if (String(d).includes('listening')) resolve(proc); });
    proc.stderr.on('data', (d) => { proc.logs += String(d); process.stderr.write(`[${label}:err] ` + d); });
    proc.on('exit', (code, sig) => { proc.exited = { code, sig }; });
    setTimeout(() => reject(new Error(label + ' did not start')), 10000);
  });
}
function stopServer(proc) {
  return new Promise((resolve) => {
    if (proc.exited) return resolve();
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.exited) proc.kill('SIGKILL'); }, 5000);
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
const emitAck = (c, ev, data) => new Promise((resolve) => c.emit(ev, data, resolve));
function waitNext(c, ev, pred, timeout = 8000, label = '') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.off(ev, h); reject(new Error(`timeout waiting ${ev} ${label}`)); }, timeout);
    const h = (p) => { if (!pred || pred(p)) { clearTimeout(timer); c.off(ev, h); resolve(p); } };
    c.on(ev, h);
  });
}
const byId = (list, id) => list.find((p) => p.id === id);
const lastEv = (c, ev) => { const e = c.log.filter((x) => x.ev === ev).pop(); return e ? e.payload : null; };

(async () => {
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* ignore */ }

  // ── 서버 A ─────────────────────────────────────────────────────
  serverProc = await startServer('A');
  check('server A reports file store', /store=file/.test(serverProc.logs), serverProc.logs.trim());

  const a1 = await connect('P1'), a2 = await connect('P2'), a3 = await connect('P3');
  const T1 = 'tok-p1-persist-0001', T2 = 'tok-p2-persist-0002', T3 = 'tok-p3-persist-0003';
  const created = await emitAck(a1, 'room:create', { name: '호스트', avatar: { emoji: '🙂', color: '#ff0000' }, token: T1 });
  const code = created.roomCode;
  await emitAck(a2, 'room:join', { roomCode: code, name: '둘째', avatar: {}, token: T2 });
  await emitAck(a3, 'room:join', { roomCode: code, name: '셋째', avatar: {}, token: T3 });
  const P1 = created.playerId, P2 = a2.playerId, P3 = a3.playerId;

  a1.emit('room:settings', { settings: { rounds: 2, drawTime: 90, hints: 0, wordCount: 2, customWords: '자전거,냉장고,해바라기,고슴도치', customWordsOnly: true } });
  await waitNext(a1, 'room:state', (s) => s.settings.customWordsOnly === true);
  const chP = waitNext(a1, 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, 'choosing');
  a1.emit('game:start');
  const ch = await chP;
  const word = ch.wordOptions[0];
  const drawingP = waitNext(a2, 'game:drawing', undefined, 5000, 'drawing');
  a1.emit('word:choose', { word });
  const d0 = await drawingP;

  a1.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 10, y: 10 });
  a1.emit('draw:move', { pts: [[20, 20], [30, 30], [40, 40]] });
  a1.emit('draw:end');
  a1.emit('draw:fill', { x: 700, y: 500, color: '#00ff00' });
  // P2 정답 → 점수 발생 (복원 후에도 유지되어야 함)
  const corrP = waitNext(a1, 'chat:message', (m) => m.kind === 'correct' && m.id === P2, 5000, 'P2 correct');
  a2.emit('chat:message', { text: word });
  await corrP;
  const stA = await waitNext(a1, 'room:state', (s) => byId(s.players, P2).score > 0, 5000, 'score state');
  const scoreP2 = byId(stA.players, P2).score;
  check('before restart: drawing, P2 scored, 3 players', stA.phase === 'drawing' && scoreP2 > 0 && stA.players.length === 3, stA);
  await sleep(700); // 저장 디바운스(300ms) 여유
  const timerBefore = lastEv(a1, 'game:timer');
  const timeLeftBefore = timerBefore ? timerBefore.timeLeft : 90;

  const snapOnDisk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('snapshot written to store while playing', snapOnDisk[code] && snapOnDisk[code].phase === 'drawing' && snapOnDisk[code].ops.length === 2, Object.keys(snapOnDisk));

  // ── 서버 A 종료 (배포 상황) ──────────────────────────────────────
  const discP = Promise.all([a1, a2, a3].map((c) => new Promise((r) => c.once('disconnect', r))));
  const tStop = Date.now();
  await stopServer(serverProc);
  await discP;
  check('server A exited on SIGTERM within 3s (flush + close)', Date.now() - tStop < 3000, Date.now() - tStop);
  const snapAfter = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))[code];
  check('snapshot survives shutdown with all players and score', snapAfter && snapAfter.players.length === 3 && byId(snapAfter.players, P2).score === scoreP2 && snapAfter.word === word, snapAfter && snapAfter.players);

  // ── 서버 B ─────────────────────────────────────────────────────
  await sleep(2500); // 배포 전환 사이의 빈 시간(다운타임) — 이 시간은 게임의 남은 시간에서 빠지지 않아야 한다
  serverProc = await startServer('B');
  check('server B does NOT restore at boot (restore on demand)', /restore on demand/.test(serverProc.logs) && !/restored room/.test(serverProc.logs), serverProc.logs.trim());
  const hzBefore = await fetch(URL + '/healthz').then((x) => x.json());
  check('healthz before anyone rejoins: rooms=0', hzBefore.rooms === 0, hzBefore);

  const b1 = await connect('P1b'), b2 = await connect('P2b'), b3 = await connect('P3b');
  // catch-up 이벤트는 rejoin ack 직후 비동기로 오므로 먼저 대기를 걸어둔다
  const cu1 = waitNext(b1, 'game:drawing', undefined, 5000, 'drawer catch-up');
  const cu2 = waitNext(b2, 'game:hint', undefined, 5000, 'P2 reveal catch-up');
  const cu3d = waitNext(b3, 'game:drawing', undefined, 5000, 'P3 catch-up');
  const cu3s = waitNext(b3, 'draw:sync', undefined, 5000, 'P3 sync');
  const allConnP = waitNext(b1, 'room:state', (s) => s.players.length === 3 && s.players.every((p) => p.connected), 8000, 'all connected');
  const r1 = await emitAck(b1, 'room:rejoin', { roomCode: code, token: T1 });
  const r2 = await emitAck(b2, 'room:rejoin', { roomCode: code, token: T2 });
  const r3 = await emitAck(b3, 'room:rejoin', { roomCode: code, token: T3 });
  const [dB1, hintB2, dB3, syncB] = await Promise.all([cu1, cu2, cu3d, cu3s]);
  check('room restored on first rejoin (server log)', /restored room [A-Z]{4} from store \(phase drawing, 3 players\)/.test(serverProc.logs), serverProc.logs.trim());
  check('all three rejoin with their ORIGINAL playerIds', r1.ok && r1.playerId === P1 && r2.ok && r2.playerId === P2 && r3.ok && r3.playerId === P3, [r1, r2, r3]);

  const stB = await allConnP;
  check('restored state: phase drawing, round 1/2, same drawer, P2 score kept, host P1', stB.phase === 'drawing' && stB.round === 1 && stB.totalRounds === 2 && stB.drawerId === P1 && byId(stB.players, P2).score === scoreP2 && stB.hostId === P1, stB);

  check('drawer gets game:drawing WITH word after restore', dB1 && dB1.word === word, dB1);
  check('guesser gets game:drawing with same mask, no word', dB3 && dB3.word === undefined && dB3.wordMask === d0.wordMask, dB3);
  check('remaining time continues and downtime is NOT deducted (within 2s of the value before shutdown)', dB3 && dB3.timeLeft <= timeLeftBefore && dB3.timeLeft >= timeLeftBefore - 2, { before: timeLeftBefore, after: dB3 && dB3.timeLeft });
  check('draw:sync restores ops (stroke + fill)', syncB && syncB.ops.length === 2 && syncB.ops[0].type === 'stroke' && syncB.ops[0].points.length === 4 && syncB.ops[1].type === 'fill', syncB && syncB.ops);
  check('rejoined correct guesser (P2) sees the full word again', hintB2 && hintB2.wordMask.replace(/ /g, '') === word, hintB2);
  check('P2 still hasGuessed after restore', byId(stB.players, P2).hasGuessed === true);

  // 타이머가 실제로 흐르는지
  const t1 = await waitNext(b3, 'game:timer', undefined, 3000, 'tick after restore');
  const t2 = await waitNext(b3, 'game:timer', (p) => p.timeLeft < t1.timeLeft, 3000, 'second tick');
  check('timer keeps ticking after restore', t2.timeLeft === t1.timeLeft - 1, [t1, t2]);

  // 복원된 게임이 정상 진행: 드로잉 중계 + 마지막 정답자 → allGuessed
  const relayP = waitNext(b3, 'draw:start', undefined, 3000, 'relay after restore');
  b1.emit('draw:start', { tool: 'pen', color: '#0000ff', size: 8, x: 100, y: 100 });
  b1.emit('draw:end');
  await relayP;
  check('drawing relays to rejoined guessers after restore', true);
  const teP = waitNext(b1, 'game:turnEnd', undefined, 8000, 'turnEnd');
  b3.emit('chat:message', { text: word });
  const te = await teP;
  check('restored game continues to turnEnd (allGuessed) with deltas for all 3', te.reason === 'allGuessed' && te.deltas.length === 3 && (te.deltas.find((d) => d.id === P1) || {}).delta === 300, te);
  const next = await waitNext(b2, 'game:choosing', undefined, 10000, 'next turn');
  check('next turn starts with next drawer (P2) — turn order preserved across restart', next.drawerId === P2, next);

  // 방 정리 → 저장소에서도 삭제
  for (const c of [b1, b2, b3]) c.emit('room:leave');
  await sleep(600);
  const finalStore = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  check('room removed from store when everyone leaves', !finalStore[code], Object.keys(finalStore));

  cleanup(failures ? 1 : 0);
})().catch((err) => {
  check(`unexpected error: ${err && err.message}`, false, err && err.stack);
  cleanup(1);
});
