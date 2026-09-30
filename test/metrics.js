/**
 * 이용 지표 시뮬레이션 (socket.io-client)
 *  - [metric] 로그 한 줄: room_created(ref) · player_joined(via/ref/midGame/size) · game_started · game_completed(turns/bytesOut)
 *    · game_aborted(host · notEnoughPlayers) · room_closed · room_full_rejected
 *  - 로그에 닉네임이 없다
 *  - /admin/stats: 키 없음/틀림 → 403, 맞으면 오늘 누적 = 이벤트 합. ADMIN_KEY 없는 서버는 404
 *  node test/metrics.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3131 + Number(process.env.TEST_PORT_OFFSET ?? 0);
const URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const ADMIN_KEY = 'test-admin-key-0123456789';

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
const serverLog = [];
const metrics = []; // 파싱된 [metric] 레코드
function cleanup(code) {
  for (const c of clients) { try { c.disconnect(); } catch (_) { /* ignore */ } }
  if (serverProc) { try { serverProc.kill(); } catch (_) { /* ignore */ } }
  console.log(`\n${passes} passed, ${failures} failed`);
  setTimeout(() => process.exit(code), 300);
}
setTimeout(() => { console.log('FAIL - overall timeout'); cleanup(2); }, 90000);

function startServer(env, port, attemptsLeft = 3) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port), RECONNECT_GRACE_MS: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let addrInUse = false;
    child.stdout.on('data', (d) => {
      const s = String(d);
      serverLog.push(s);
      for (const line of s.split('\n')) {
        const i = line.indexOf('[metric] ');
        if (i >= 0) { try { metrics.push(JSON.parse(line.slice(i + 9))); } catch (_) { /* ignore */ } }
      }
      if (s.includes('listening')) resolve(child);
    });
    child.stderr.on('data', (d) => {
      if (String(d).includes('EADDRINUSE')) addrInUse = true;
      process.stderr.write('[server:err] ' + d);
    });
    // 직전 프로세스가 방금 닫은 포트가 (Windows TIME_WAIT 등으로) 아직 안 풀렸을 때 짧게 재시도
    child.on('exit', () => {
      if (addrInUse && attemptsLeft > 1) {
        setTimeout(() => { startServer(env, port, attemptsLeft - 1).then(resolve, reject); }, 300);
      } else {
        reject(new Error('server exited'));
      }
    });
  });
}
function connect() {
  const c = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true });
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
/** 마지막 이벤트 레코드 */
const last = (ev) => metrics.filter((m) => m.ev === ev).pop();
const count = (ev) => metrics.filter((m) => m.ev === ev).length;
const stats = (key, days) => fetch(`${URL}/admin/stats?key=${encodeURIComponent(key)}${days ? '&days=' + days : ''}`);

(async () => {
  serverProc = await startServer({ ADMIN_KEY }, PORT);

  // ── 방 생성 · 참가 (ref / via) ─────────────────────────────────
  const c1 = await connect(), c2 = await connect(), c3 = await connect();
  const created = await emitAck(c1, 'room:create', { name: '방장닉네임', avatar: {}, token: 'tok-m1-000000001', ref: ' GN ' });
  const code = created.roomCode;
  await emitAck(c2, 'room:join', { roomCode: code, name: '둘째', avatar: {}, token: 'tok-m2-000000002', via: 'link', ref: 'bad ref!' });
  await emitAck(c3, 'room:join', { roomCode: code, name: '셋째', avatar: {}, token: 'tok-m3-000000003' });
  await sleep(300);
  const rc = last('room_created');
  check('room_created: room · ref 정규화(소문자·trim) · loggedIn=false · ts', rc && rc.room === code && rc.ref === 'gn' && rc.loggedIn === false && typeof rc.ts === 'string', rc);
  const joins = metrics.filter((m) => m.ev === 'player_joined');
  check('player_joined ×2: via link(ref 무효→"") size 2 · via code(기본) size 3 · midGame false',
    joins.length === 2 && joins[0].via === 'link' && joins[0].ref === '' && joins[0].size === 2 && joins[1].via === 'code' && joins[1].size === 3 && joins.every((j) => j.midGame === false), joins);
  check('서버 로그에 닉네임이 없다', !serverLog.join('').includes('방장닉네임') && !/created by/.test(serverLog.join('')));

  // ── 게임 한 판(classic · 1라운드 · 3명 = 3턴) ────────────────────
  c1.emit('room:settings', { settings: { mode: 'classic', rounds: 1, drawTime: 30, hints: 0, wordCount: 2, customWords: '자전거,냉장고,해바라기,고슴도치,선풍기,우산', customWordsOnly: true } });
  c1.emit('lobby:step', { step: 'settings' });
  await sleep(200);
  const all = [c1, c2, c3];
  let firstChoosing = null;
  const startP = waitNext(c1, 'game:choosing', undefined, 5000, 'first choosing');
  c1.emit('game:start');
  firstChoosing = await startP;
  await sleep(200);
  const gs = last('game_started');
  check('game_started: mode classic · players 3 · rounds 1 · drawTime 30 · customWords true', gs && gs.mode === 'classic' && gs.players === 3 && gs.rounds === 1 && gs.drawTime === 30 && gs.customWords === true, gs);

  // 턴 진행: 출제자가 단어 고르고 한 획, 나머지가 정답 → allGuessed → 5초 뒤 다음 턴
  let choosing = firstChoosing;
  for (let turn = 0; turn < 3; turn++) {
    const drawer = all.find((c) => c.playerId === choosing.drawerId);
    const opts = await (drawer === c1 && turn === 0 ? Promise.resolve(firstChoosing) : waitNext(drawer, 'game:choosing', (p) => Array.isArray(p.wordOptions), 8000, 'drawer choosing ' + turn));
    const drawingP = waitNext(c1, 'game:drawing', undefined, 5000, 'drawing ' + turn);
    drawer.emit('word:choose', { word: opts.wordOptions[0] });
    await drawingP;
    drawer.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 1, y: 1 });
    drawer.emit('draw:move', { pts: [[10, 10], [20, 20], [30, 30]] });
    drawer.emit('draw:end');
    const endP = turn < 2 ? waitNext(c1, 'game:choosing', undefined, 12000, 'next choosing ' + turn) : waitNext(c1, 'game:over', undefined, 12000, 'game over');
    for (const c of all) if (c !== drawer) c.emit('chat:message', { text: opts.wordOptions[0] });
    const next = await endP;
    if (turn < 2) choosing = next;
  }
  await sleep(300);
  const gc = last('game_completed');
  check('game_completed: turns 3 · players 3 · durationSec ≥ 10 · bytesOut > 0 · galleryTrimmed false',
    gc && gc.turns === 3 && gc.players === 3 && gc.durationSec >= 10 && gc.bytesOut > 0 && gc.galleryTrimmed === false && gc.mode === 'classic', gc);
  check('game_aborted 아직 없음', count('game_aborted') === 0);

  // ── 방장이 게임 끝내기 → game_aborted reason host ───────────────
  for (const c of all) c.emit('results:done');
  await sleep(300);
  const ch2P = waitNext(c1, 'game:choosing', undefined, 5000, 'second game');
  c1.emit('game:start');
  await ch2P;
  const abortedP = waitNext(c2, 'game:aborted', undefined, 3000);
  c1.emit('game:end');
  await abortedP; await sleep(200);
  const ga = last('game_aborted');
  check('game_aborted(host): reason host · turnsPlayed 0 · players 3 · bytesOut ≥ 0', ga && ga.reason === 'host' && ga.turnsPlayed === 0 && ga.players === 3 && ga.bytesOut >= 0, ga);
  check('game_started 2번째 기록', count('game_started') === 2);

  // ── 인원 부족 → game_aborted reason notEnoughPlayers ────────────
  c3.disconnect(); await sleep(300);
  const ch3P = waitNext(c1, 'game:choosing', undefined, 5000, 'third game');
  c1.emit('game:start');
  await ch3P;
  const overP = waitNext(c1, 'game:over', undefined, 10000, 'over by notEnoughPlayers');
  c2.disconnect();
  await overP; await sleep(300);
  const ga2 = last('game_aborted');
  check('game_aborted(notEnoughPlayers): reason · players 1', ga2 && ga2.reason === 'notEnoughPlayers' && ga2.players === 1, ga2);

  // ── 마지막 사람이 나감 → room_closed ────────────────────────────
  c1.emit('room:leave'); await sleep(300);
  const rcl = last('room_closed');
  check('room_closed: gamesPlayed 3 · peakPlayers 3 · lifetimeSec ≥ 10 · bytesOut ≥ 0', rcl && rcl.room === code && rcl.gamesPlayed === 3 && rcl.peakPlayers === 3 && rcl.lifetimeSec >= 10 && rcl.bytesOut >= 0, rcl);

  // ── 12명 가득 참 → room_full_rejected ──────────────────────────
  const h = await connect();
  const full = await emitAck(h, 'room:create', { name: '가득방장', avatar: {}, token: 'tok-full-h-000001' });
  for (let i = 0; i < 11; i++) {
    const c = await connect();
    const r = await emitAck(c, 'room:join', { roomCode: full.roomCode, name: 'p' + i, avatar: {}, token: 'tok-full-' + String(i).padStart(9, '0') });
    if (!r.ok) check('12명까지 참가', false, r);
  }
  const extra = await connect();
  const rej = await emitAck(extra, 'room:join', { roomCode: full.roomCode, name: '13번째', avatar: {}, token: 'tok-full-extra-01' });
  await sleep(200);
  check('13번째 참가 거절 + room_full_rejected', rej.ok === false && count('room_full_rejected') === 1 && last('room_full_rejected').room === full.roomCode, rej);

  // ── /admin/stats ────────────────────────────────────────────────
  const noKey = await fetch(`${URL}/admin/stats`);
  const wrong = await stats('nope');
  check('/admin/stats: 키 없음 403 · 틀림 403', noKey.status === 403 && wrong.status === 403);
  const okRes = await stats(ADMIN_KEY, 7);
  const body = await okRes.json();
  const today = body.days && body.days[0];
  check('/admin/stats: ok · today · store memory · 오늘 행', okRes.status === 200 && body.ok && body.today === today.day && body.store === 'memory', body);
  const bytesFromLog = metrics.filter((m) => m.ev === 'game_completed' || m.ev === 'game_aborted').reduce((s, m) => s + m.bytesOut, 0);
  check('오늘 누적: rooms 2 · ref:gn 1 · joins 13(link 1 · code 12) · starts 3 · completes 1 · aborts 2(host 1 · notEnoughPlayers 1) · turns 3 · full 1 · closed 1',
    today.rooms === 2 && today['ref:gn'] === 1 && today.joins === 13 && today.joins_link === 1 && today.joins_code === 12 && today.starts === 3 && today.starts_classic === 3
      && today.completes === 1 && today.aborts === 2 && today.aborts_host === 1 && today.aborts_notEnoughPlayers === 1 && today.turns === 3 && today.full === 1 && today.closed === 1
      && today.players_start === 3 + 3 + 2 && today.players_complete === 3, today);
  check('오늘 누적 bytes_out = 로그의 bytesOut 합 (> 0)', today.bytes_out === bytesFromLog && bytesFromLog > 0, { stats: today.bytes_out, log: bytesFromLog });
  check('/healthz 에는 통계가 없다', !('days' in (await (await fetch(`${URL}/healthz`)).json())));

  // ── ADMIN_KEY 없는 서버 → 404 ─────────────────────────────────
  const other = await startServer({ ADMIN_KEY: '' }, PORT + 1);
  const r404 = await fetch(`http://localhost:${PORT + 1}/admin/stats?key=x`);
  check('ADMIN_KEY 미설정: /admin/stats 404', r404.status === 404);
  other.kill();

  cleanup(failures ? 1 : 0);
})().catch((err) => {
  check(`unexpected error: ${err && err.message}`, false, err && err.stack);
  cleanup(1);
});
