/**
 * 이어 그리기(relay) 코어 테스트 — docs/product/2026-10-relay-drawing.md R1
 *  ① 순수 헬퍼 relayAssignment: 3명·4명 전 문제 배정(순서 밀기)
 *  ② Room 단위(가짜 io): 나간 주자 처리(차례 전 → order 에서 빠짐, 현재 → 곧바로 다음 구간), 갤러리 drawerIds·guesserId, 스냅샷 왕복
 *  ③ 소켓(3명, ALLOW_SOLO 없음): 인원 검사, 첫 주자 선택·조합 후보, 제시어 공개 범위, 권한, 구간 전환(game:baton·열린 획 닫기),
 *     구간 보호(undo·clear → draw:sync), 주자 채팅, 구간 타이머, 순서 밀기(2번 문제)
 *  node test/relay.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3134;
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let serverProc = null;
const clients = [];
function cleanup(code) {
  for (const c of clients) { try { c.disconnect(); } catch (_) { /* ignore */ } }
  if (serverProc) { try { serverProc.kill(); } catch (_) { /* ignore */ } }
  console.log(`\n${passes} passed, ${failures} failed`);
  setTimeout(() => process.exit(code), 300);
}
setTimeout(() => { console.log('FAIL - overall timeout'); failures += 1; cleanup(2); }, 150000);

// 서버 env 에 ALLOW_SOLO 가 새지 않게(3명 규칙으로 돈다). 단위 테스트의 require 보다 먼저
delete process.env.ALLOW_SOLO;
const game = require('../server/game');
const { maskParts, PART_SEP } = require('../server/words');

// ── ① relayAssignment ──────────────────────────────────────────
{
  const three = [0, 1, 2].map((i) => game.relayAssignment(['A', 'B', 'C'], i));
  check('① 3명: A→B/C, B→C/A, C→A/B', same(three, [
    { runners: ['A', 'B'], guesserId: 'C' },
    { runners: ['B', 'C'], guesserId: 'A' },
    { runners: ['C', 'A'], guesserId: 'B' },
  ]), three);
  const four = [0, 1, 2, 3].map((i) => game.relayAssignment(['A', 'B', 'C', 'D'], i));
  check('① 4명: ABC/D, BCD/A, CDA/B, DAB/C', same(four, [
    { runners: ['A', 'B', 'C'], guesserId: 'D' },
    { runners: ['B', 'C', 'D'], guesserId: 'A' },
    { runners: ['C', 'D', 'A'], guesserId: 'B' },
    { runners: ['D', 'A', 'B'], guesserId: 'C' },
  ]), four);
  const guessers = [0, 1, 2, 3].map((i) => four[i].guesserId).sort();
  check('① 4명: 모두 한 번씩 맞힌다', same(guessers, ['A', 'B', 'C', 'D']));
  check('① i ≥ n 은 나머지로', same(game.relayAssignment(['A', 'B', 'C'], 4), three[1]));
  check('① 빈 순서 → 주자 없음', same(game.relayAssignment([], 0), { runners: [], guesserId: null }));
  check('① 최소·최대 인원 상수', game.RELAY_MIN_PLAYERS === 3 && game.RELAY_MAX_PLAYERS === 6);
}

// ── ② Room 단위(가짜 io) ───────────────────────────────────────
function fakeIo(sent) {
  return {
    to(t) {
      const target = { emit(ev, p) { sent.push({ t, ev, p }); }, except() { return target; } };
      return target;
    },
  };
}
{
  const sent = [];
  const room = new game.Room(fakeIo(sent), 'UNIT');
  for (const id of ['A', 'B', 'C', 'D', 'E']) room.addPlayer({ id, name: id + '님', avatar: {}, token: 'tok-' + id, socketId: id });
  room.updateSettings('A', { mode: 'relay', drawTime: 15, wordCount: 2 });
  check('② 6명 초과 아님 → 5명 시작', room.start('A') === null);
  check('② 1번 문제: 주자 A,B,C,D / 맞히는 사람 E, 요소 3개',
    same(room.relay.order, ['A', 'B', 'C', 'D']) && room.relay.guesserId === 'E' && room.wordOptions.every((w) => w.split(PART_SEP).length === 3),
    { relay: room.relay, options: room.wordOptions });
  room.chooseWord('A', room.wordOptions[0]);
  check('② drawing: timeLeft = 15 × 4', room.phase === 'drawing' && room.timeLeft === 60 && room.relay.totalTime === 60);
  room.removePlayer('C', 'left'); // 차례 전 주자
  check('② 차례 전 주자가 나가면 order 에서 빠지고 문제 시간이 한 구간 준다',
    same(room.relay.order, ['A', 'B', 'D']) && room.relay.legCount === 3 && room.timeLeft === 45 && room.relay.totalTime === 45, room.relay);
  room.handleDraw('A', 'fill', { x: 1, y: 1, color: '#000000' });
  for (let i = 0; i < 5; i++) room.tick();
  room.removePlayer('A', 'left'); // 현재 주자
  check('② 현재 주자가 나가면 곧바로 다음 구간(남은 구간 시간만큼 준다)',
    room.drawerId === 'B' && room.relay.legIndex === 1 && room.relay.legTimeLeft === 15 && room.timeLeft === 30 && room.relay.legStartOps === 1,
    { drawerId: room.drawerId, relay: room.relay, timeLeft: room.timeLeft });
  const baton = sent.filter((x) => x.ev === 'game:baton').pop();
  check('② 이때도 game:baton', baton && baton.p.drawerId === 'B' && baton.p.legIndex === 1);
  const snap = JSON.parse(JSON.stringify(room.toSnapshot()));
  const restored = game.Room.fromSnapshot(fakeIo([]), snap);
  check('② 스냅샷 왕복: relay·parts·comboOptions 유지',
    same(restored.relay, room.relay) && same(restored.parts, room.parts) && restored.comboOptions.size === room.comboOptions.size && restored.isRelay(),
    { restored: restored.relay, parts: restored.parts });
  restored.destroy();
  for (let i = 0; i < 15; i++) room.tick(); // B 구간 끝 → D
  check('② 경계에서 다음 주자 D', room.drawerId === 'D' && room.relay.legIndex === 2 && room.timeLeft === 15);
  for (let i = 0; i < 15; i++) room.tick();
  check('② 마지막 구간이 끝나면 turnEnd(time)', room.phase === 'turnEnd' && room.lastTurnEnd.reason === 'time' && room.lastTurnEnd.deltas.every((d) => d.delta === 0));
  const g = room.gallery[0];
  check('② 갤러리: drawerIds = 구간을 가진 주자, drawerId = 첫 주자, guesserId, category null',
    g && same(g.drawerIds, ['A', 'B', 'D']) && g.drawerId === 'A' && g.guesserId === 'E' && g.category === null && g.word.includes(PART_SEP), g);
  room.gameOver();
  const over = sent.filter((x) => x.ev === 'game:over').pop();
  check('② game:over.gallery 에 drawerIds·guesserId', over && same(over.p.gallery[0].drawerIds, ['A', 'B', 'D']) && over.p.gallery[0].guesserId === 'E');
  check('② game:over 뒤 room:state.relay = null', room.toState().relay === null && room.relay === null);
  room.destroy();
}
{
  // classic 갤러리도 형식 통일: drawerIds:[drawerId], guesserId:null
  const room = new game.Room(fakeIo([]), 'UNI2');
  for (const id of ['A', 'B']) room.addPlayer({ id, name: id, avatar: {}, token: 'tok2-' + id, socketId: id });
  room.start('A');
  room.chooseWord('A', room.wordOptions[0]);
  room.endTurn('time');
  const g = room.gallery[0];
  check('② classic 갤러리: drawerIds=[drawerId], guesserId=null', g && same(g.drawerIds, ['A']) && g.guesserId === null && typeof g.category === 'string', g);
  check('② classic room:state.relay = null', room.toState().relay === null);
  room.destroy();
}
{
  // choosing 중 첫 주자가 나가면 다음 주자가 새 후보로 고른다
  const room = new game.Room(fakeIo([]), 'UNI3');
  for (const id of ['A', 'B', 'C', 'D']) room.addPlayer({ id, name: id, avatar: {}, token: 'tok3-' + id, socketId: id });
  room.updateSettings('A', { mode: 'relay', drawTime: 15 });
  room.start('A');
  room.removePlayer('A', 'left');
  check('② choosing 중 첫 주자가 나가면 다음 주자가 고른다', room.phase === 'choosing' && room.drawerId === 'B' && same(room.relay.order, ['B', 'C']) && room.relay.guesserId === 'D', room.relay);
  room.destroy();
}

// ── ③ 소켓 ─────────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(PORT) };
    delete env.ALLOW_SOLO;
    serverProc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    c.once('connect', () => resolve(c));
    c.once('connect_error', reject);
  });
}
const emitAck = (c, ev, data) => new Promise((resolve) => c.emit(ev, data, resolve));
function waitNext(c, ev, pred, timeout = 8000, label = '') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.off(ev, h); reject(new Error(`timeout waiting ${ev} ${label} (${c.label})`)); }, timeout);
    const h = (p) => { if (!pred || pred(p)) { clearTimeout(timer); c.off(ev, h); resolve(p); } };
    c.on(ev, h);
  });
}
const lastState = (c) => { const e = c.log.filter((x) => x.ev === 'room:state').pop(); return e ? e.payload : null; };
const evsSince = (c, mark, ev) => c.log.slice(mark).filter((x) => x.ev === ev);
const chatsSince = (c, mark, kind) => evsSince(c, mark, 'chat:message').map((x) => x.payload).filter((m) => !kind || m.kind === kind);

(async () => {
  await startServer();
  const a = await connect('A'), b = await connect('B'), c = await connect('C');
  const created = await emitAck(a, 'room:create', { name: '에이', avatar: {}, token: 'tok-relay-a-000001' });
  const code = created.roomCode;
  const A = created.playerId;
  const jb = await emitAck(b, 'room:join', { roomCode: code, name: '비', avatar: {}, token: 'tok-relay-b-000002' });
  const B = jb.playerId;
  const setP = waitNext(a, 'room:state', (s) => s.settings.mode === 'relay' && s.settings.drawTime === 15, 5000, 'relay settings');
  a.emit('room:settings', { settings: { mode: 'relay', drawTime: 15, wordCount: 3, hints: 3 } });
  const stSet = await setP;
  check('③ settings.mode = relay 저장, lobby 의 room:state.relay = null', stSet.settings.mode === 'relay' && stSet.relay === null, stSet);

  // 1. 2명이면 거절
  const errP = waitNext(a, 'error:msg', undefined, 3000, '2명 시작');
  a.emit('game:start');
  const err = await errP;
  check('③ 2명이면 game:start 거절(3명부터 6명까지)', /3명부터 6명까지/.test(err.message), err);
  await sleep(200);
  check('③ 거절 뒤에도 lobby', lastState(a).phase === 'lobby');

  const jc = await emitAck(c, 'room:join', { roomCode: code, name: '씨', avatar: {}, token: 'tok-relay-c-000003' });
  const C = jc.playerId;
  await sleep(200);

  // 2. 1번 문제 choosing
  const chAP = waitNext(a, 'game:choosing', undefined, 5000, 'A choosing');
  const chBP = waitNext(b, 'game:choosing', undefined, 5000, 'B choosing');
  const chCP = waitNext(c, 'game:choosing', undefined, 5000, 'C choosing');
  const stChP = waitNext(c, 'room:state', (s) => s.phase === 'choosing', 5000, 'state choosing');
  a.emit('game:start');
  const [chA, chB, chC] = await Promise.all([chAP, chBP, chCP]);
  check('③ 1번 문제 choosing: drawerId = A', chA.drawerId === A && chB.drawerId === A && chC.drawerId === A, { chA, chB });
  check('③ A 에게만 wordOptions', Array.isArray(chA.wordOptions) && chB.wordOptions === undefined && chC.wordOptions === undefined);
  check('③ 후보 3개, 전부 " · " 조합에 요소 2개(3명 방)',
    chA.wordOptions.length === 3 && chA.wordOptions.every((w) => w.includes(PART_SEP) && w.split(PART_SEP).length === 2), chA.wordOptions);
  const stCh = await stChP;
  check('③ choosing 중 room:state.relay = { order:[A,B], guesserId:C, legIndex:0, legCount:2 }, 문제 1/3',
    stCh.relay && same(stCh.relay, { order: [A, B], guesserId: C, legIndex: 0, legCount: 2 }) && stCh.round === 1 && stCh.totalRounds === 3, stCh);

  const word = chA.wordOptions[1];
  const parts = word.split(PART_SEP);
  const dAP = waitNext(a, 'game:drawing', undefined, 5000, 'A drawing');
  const dBP = waitNext(b, 'game:drawing', undefined, 5000, 'B drawing');
  const dCP = waitNext(c, 'game:drawing', undefined, 5000, 'C drawing');
  const stDP = waitNext(c, 'room:state', (s) => s.phase === 'drawing', 5000, 'state drawing');
  a.emit('word:choose', { word });
  const [dA, dB, dC] = await Promise.all([dAP, dBP, dCP]);
  check('③ game:drawing.relay: order [A,B], guesserId C, legIndex 0, legCount 2, legTime 15, totalTime 30',
    dA.relay && same(dA.relay.order, [A, B]) && dA.relay.guesserId === C && dA.relay.legIndex === 0 && dA.relay.legCount === 2
      && dA.relay.legTime === 15 && dA.relay.totalTime === 30 && dA.relay.hintsUsed === 0 && dA.relay.hintsMax === 3, dA.relay);
  check('③ timeLeft = 문제 전체 30초', dA.timeLeft === 30 && dC.timeLeft === 30);
  check('③ word 는 A(현재 주자)에게만', dA.word === word && dB.word === undefined && dC.word === undefined, { dA: dA.word, dB: dB.word, dC: dC.word });
  check('③ B·C 는 요소별 마스크(" · " 포함)', dB.wordMask === maskParts(parts) && dC.wordMask.includes(PART_SEP), { dB: dB.wordMask, dC: dC.wordMask });
  check('③ relay 에는 category 가 없다', dA.category === undefined && dB.category === undefined);
  const stD = await stDP;
  check('③ room:state: drawerId A, nextDrawerId B, isDrawing 은 A 만',
    stD.drawerId === A && stD.nextDrawerId === B && stD.players.every((p) => p.isDrawing === (p.id === A)) && stD.relay.legIndex === 0, stD);

  // 3. 권한: B(차례 전 주자)의 그림은 중계되지 않는다. A 의 그림은 B·C 모두 실시간으로
  let mark = c.log.length, markA = a.log.length;
  b.emit('draw:start', { tool: 'pen', color: '#ff0000', size: 5, x: 10, y: 10 });
  b.emit('draw:end');
  await sleep(400);
  check('③ 차례가 아닌 B 의 draw:start 는 아무에게도 안 간다', !evsSince(c, mark, 'draw:start').length && !evsSince(a, markA, 'draw:start').length);
  const aStartB = waitNext(b, 'draw:start', undefined, 3000, 'A→B');
  const aStartC = waitNext(c, 'draw:start', undefined, 3000, 'A→C');
  a.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 100, y: 100 });
  a.emit('draw:move', { pts: [[110, 110], [120, 120]] });
  a.emit('draw:end');
  await Promise.all([aStartB, aStartC]);
  check('③ A 의 획은 B·C(맞히는 사람) 모두에게 중계', true);
  // 두 번째 획은 열어 둔 채로 구간을 넘긴다(op 2개)
  a.emit('draw:start', { tool: 'pen', color: '#0000ff', size: 8, x: 200, y: 200 });
  a.emit('draw:move', { pts: [[210, 220]] });
  await sleep(300);

  // 6. 채팅(A 구간 중): 주자 채팅은 주자끼리만, C 의 채팅은 전원에게, 조합 그대로 쳐도 correct 없음
  mark = c.log.length; markA = a.log.length; let markB = b.log.length;
  a.emit('chat:message', { text: '이거 뭐로 보여?' });
  b.emit('chat:message', { text: '모르겠어' });
  await sleep(400);
  check('③ 주자(A·B) 채팅은 A·B 에게 guessed-chat',
    chatsSince(a, markA, 'guessed-chat').length === 2 && chatsSince(b, markB, 'guessed-chat').length === 2, { a: chatsSince(a, markA), b: chatsSince(b, markB) });
  check('③ 주자 채팅은 C(맞히는 사람)에게 안 간다', !chatsSince(c, mark).some((m) => m.text === '이거 뭐로 보여?' || m.text === '모르겠어'), chatsSince(c, mark));
  mark = c.log.length; markA = a.log.length; markB = b.log.length;
  c.emit('chat:message', { text: '강아지?' });
  c.emit('chat:message', { text: word });
  await sleep(400);
  const cChats = [chatsSince(a, markA), chatsSince(b, markB), chatsSince(c, mark)];
  check('③ C 의 채팅은 전원에게 chat', cChats.every((list) => list.filter((m) => m.kind === 'chat' && m.id === C).length === 2), cChats);
  check('③ 조합 문자열을 그대로 쳐도 correct 없음(판정은 R2)', cChats.every((list) => !list.some((m) => m.kind === 'correct' || m.kind === 'close')));

  // 4·7. 15초 경계: 열린 획 닫기 → game:baton → room:state
  const batonA = waitNext(a, 'game:baton', undefined, 20000, 'baton A');
  const batonB = waitNext(b, 'game:baton', undefined, 20000, 'baton B');
  const batonC = waitNext(c, 'game:baton', undefined, 20000, 'baton C');
  const stBP = waitNext(c, 'room:state', (s) => s.phase === 'drawing' && s.drawerId === B, 20000, 'state B');
  const [bA, bB, bC] = await Promise.all([batonA, batonB, batonC]);
  check('③ game:baton { legIndex 1, legCount 2, drawerId B, legTimeLeft 15 } 전원',
    [bA, bB, bC].every((x) => x.legIndex === 1 && x.legCount === 2 && x.drawerId === B && x.drawerName === '비' && x.legTimeLeft === 15), bA);
  check('③ baton.word 는 B(새 주자)에게만', bB.word === word && bA.word === undefined && bC.word === undefined, { bA, bB, bC });
  for (const [cl, label] of [[b, 'B'], [c, 'C']]) {
    const iBaton = cl.log.findIndex((x) => x.ev === 'game:baton');
    const iEnd = cl.log.map((x) => x.ev).lastIndexOf('draw:end', iBaton);
    const iMove = cl.log.map((x) => x.ev).lastIndexOf('draw:move', iBaton);
    check(`③ ${label}: 열린 획의 draw:end 가 game:baton 보다 먼저`, iEnd > iMove && iEnd < iBaton, { iMove, iEnd, iBaton });
  }
  const stB = await stBP;
  check('③ baton 뒤 room:state: drawerId B, nextDrawerId null, isDrawing 은 B 만, legIndex 1',
    stB.nextDrawerId === null && stB.players.every((p) => p.isDrawing === (p.id === B)) && stB.relay.legIndex === 1, stB);
  const iDrawing = c.log.findIndex((x) => x.ev === 'game:drawing');
  const timers = c.log.slice(iDrawing).filter((x) => x.ev === 'game:timer').map((x) => x.payload); // choosing 중 timer 는 legTimeLeft 가 없다
  check('③ game:timer 에 legTimeLeft', timers.length > 0 && timers.every((t) => typeof t.legTimeLeft === 'number'), timers.slice(-3));
  const atBoundary = timers.find((t) => t.timeLeft === 15);
  check('③ 경계 직전 timer: timeLeft 15, legTimeLeft 0', atBoundary && atBoundary.legTimeLeft === 0, atBoundary);
  const tNext = await waitNext(c, 'game:timer', undefined, 3000, 'timer after baton');
  check('③ 경계 뒤 구간 타이머가 다시 흐른다(timeLeft 14, legTimeLeft 14)', tNext.timeLeft === 14 && tNext.legTimeLeft === 14, tNext);

  // 5. 구간 보호
  mark = c.log.length; markA = a.log.length;
  b.emit('draw:undo');
  await sleep(300);
  check('③ B 구간에 그린 게 없으면 draw:undo 무시(앞 주자 그림 보호)', !evsSince(c, mark, 'draw:undo').length && !evsSince(a, markA, 'draw:undo').length);
  mark = c.log.length;
  a.emit('draw:fill', { x: 5, y: 5, color: '#00ff00' });
  await sleep(300);
  check('③ 지난 주자 A 는 더 못 그린다', !evsSince(c, mark, 'draw:fill').length);
  const fillC = waitNext(c, 'draw:fill', undefined, 3000, 'B fill');
  b.emit('draw:fill', { x: 300, y: 300, color: '#ff00ff' });
  await fillC;
  const undoC = waitNext(c, 'draw:undo', undefined, 3000, 'B undo');
  const undoA = waitNext(a, 'draw:undo', undefined, 3000, 'B undo → A');
  b.emit('draw:undo');
  await Promise.all([undoC, undoA]);
  check('③ B 의 op 가 있으면 draw:undo 중계', true);
  mark = c.log.length; markA = a.log.length; markB = b.log.length;
  b.emit('draw:fill', { x: 400, y: 400, color: '#ff00ff' });
  await sleep(200);
  const syncs = [waitNext(a, 'draw:sync', undefined, 3000, 'sync A'), waitNext(b, 'draw:sync', undefined, 3000, 'sync B'), waitNext(c, 'draw:sync', undefined, 3000, 'sync C')];
  b.emit('draw:clear');
  const [sA, sB, sC] = await Promise.all(syncs);
  check('③ B 의 draw:clear → B 포함 전원에게 draw:sync, ops 2개(A 의 그림) 남음',
    [sA, sB, sC].every((s) => Array.isArray(s.ops) && s.ops.length === 2 && s.ops[0].type === 'stroke' && s.ops[1].color === '#0000ff'), sA);
  await sleep(200);
  check('③ draw:clear 는 중계되지 않는다', !evsSince(a, markA, 'draw:clear').length && !evsSince(c, mark, 'draw:clear').length && !evsSince(b, markB, 'draw:clear').length);
  mark = c.log.length;
  b.emit('draw:undo');
  await sleep(300);
  check('③ clear 뒤 undo 도 앞 주자 그림은 못 지운다', !evsSince(c, mark, 'draw:undo').length);

  // 8. 문제 끝(time) → 2번 문제: B→C / A
  const teP = waitNext(c, 'game:turnEnd', undefined, 20000, 'turnEnd 1');
  const ch2P = waitNext(b, 'game:choosing', (p) => Array.isArray(p.wordOptions), 30000, 'choosing 2');
  const te = await teP;
  check('③ 30초 뒤 game:turnEnd reason time, deltas 전원 0, word = 조합',
    te.reason === 'time' && te.deltas.length === 3 && te.deltas.every((d) => d.delta === 0) && te.word === word, te);
  const stTe = lastState(c);
  check('③ turnEnd 중 room:state.relay 유지, nextDrawerId null', stTe.phase === 'turnEnd' && stTe.relay && stTe.nextDrawerId === null, stTe);
  const ch2 = await ch2P;
  check('③ 2번 문제 choosing: drawerId = B', ch2.drawerId === B && ch2.wordOptions.every((w) => w.split(PART_SEP).length === 2), ch2);
  check('③ 2번 문제 후보는 1번 조합과 다르다', !ch2.wordOptions.includes(word), ch2.wordOptions);
  const d2B = waitNext(b, 'game:drawing', undefined, 5000, 'drawing 2 B');
  const d2C = waitNext(c, 'game:drawing', undefined, 5000, 'drawing 2 C');
  const d2A = waitNext(a, 'game:drawing', undefined, 5000, 'drawing 2 A');
  b.emit('word:choose', { word: ch2.wordOptions[0] });
  const [x2B, x2C, x2A] = await Promise.all([d2B, d2C, d2A]);
  check('③ 2번 문제: order [B,C], guesserId A(순서 밀기)', same(x2B.relay.order, [B, C]) && x2B.relay.guesserId === A && x2B.round === 2, x2B.relay);
  check('③ 2번 문제: word 는 B 에게만, C(뒤 주자)·A 는 마스크', x2B.word === ch2.wordOptions[0] && x2C.word === undefined && x2A.word === undefined && x2C.wordMask.includes(PART_SEP));
  await sleep(200);
  const st2 = lastState(a);
  check('③ 2번 문제 room:state: drawerId B, nextDrawerId C, round 2/3', st2.drawerId === B && st2.nextDrawerId === C && st2.round === 2 && st2.totalRounds === 3, st2);

  // 9. 방장이 끝냄
  const abP = waitNext(c, 'game:aborted', undefined, 3000, 'aborted');
  const lobbyP = waitNext(c, 'room:state', (s) => s.phase === 'lobby', 3000, 'lobby');
  a.emit('game:end');
  await abP;
  const stL = await lobbyP;
  check('③ game:end → lobby, relay null', stL.relay === null && stL.drawerId === null, stL);

  cleanup(failures ? 1 : 0);
})().catch((e) => {
  console.log('FAIL - exception', e && e.stack ? e.stack : e);
  failures += 1;
  cleanup(1);
});
