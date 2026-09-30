/**
 * 이어 그리기(relay) 코어 테스트 — docs/product/2026-10-relay-drawing.md R1
 *  ① 순수 헬퍼 relayAssignment: 3명·4명 전 문제 배정(순서 밀기)
 *  ② Room 단위(가짜 io): 나간 주자 처리(차례 전 → order 에서 빠짐, 현재 → 곧바로 다음 구간), 갤러리 drawerIds·guesserId, 스냅샷 왕복
 *  ③ 소켓(3명, ALLOW_SOLO 없음): 인원 검사, 첫 주자 선택·조합 후보, 제시어 공개 범위, 권한, 구간 전환(game:baton·열린 획 닫기),
 *     구간 보호(undo·clear → draw:sync), 주자 채팅, 구간 타이머, 순서 밀기(2번 문제)
 *  ④ R2 맞히기(소켓, 3명, hints 2·wordCount 2): 비주자 hint:request 무시, 힌트(받는 사람·감점 횟수·상한), 부분 정답(close + partial),
 *     누적 정답(correct·allGuessed·점수 ×0.5·구간 가진 주자 200), 두 구간 뒤 정답, 시간 초과 → game:over 점수 합·갤러리 guessed,
 *     guesserLeft(→ notEnoughPlayers 로 게임 종료). Room 단위: 스냅샷의 hintsUsed·revealedByPart·solvedIdx, 공개할 글자가 없으면 힌트 무시
 *  ⑤ R3 끊김·복원. Room 단위: 끊긴 주자의 구간은 비워 두고 경계에서 넘어감(안내), 맞히는 사람·주자가 모두 나간 문제 건너뛰기(round 증가),
 *     인원(끊김만이면 계속·재접속 대기 / 실제 퇴장으로 모자라면 notEnoughPlayers), choosing 복원(같은 후보), 구간 경계 복원(시간 불변식).
 *     소켓(기본 유예): 차례 전 주자·맞히는 사람·현재 주자 끊김 → 복귀 catch-up, 끊긴 주자 경계 넘김 → 지난 주자로 복귀(권한 없음),
 *     turnEnd 중 복귀(deltas 중복 없음). 소켓(유예 2.5초, 3135): 현재 주자 유예 만료 → 곧바로 다음 구간, 맞히는 사람 유예 만료 → guesserLeft,
 *     나간 맞히는 사람의 문제 건너뛰기, 인원 부족. 소켓(파일 저장소, 3136): 2구간째 서버 재시작 → 같은 구간·마스크·힌트 수·그림, 시간 불변식, 정답까지
 *  node test/relay.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const OFFSET = Number(process.env.TEST_PORT_OFFSET ?? 0);
const PORT = 3134 + OFFSET;
const PORT_GRACE = 3135 + OFFSET; // ⑤ 짧은 유예(RECONNECT_GRACE_MS) 서버
const PORT_STORE = 3136 + OFFSET; // ⑤ 파일 저장소 재시작 복원 서버
let URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const fs = require('fs');
const STATE_FILE = path.join(ROOT, 'test', '.tmp-relay-state.json');

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
const procs = [];
const clients = [];
function cleanup(code) {
  for (const c of clients) { try { c.disconnect(); } catch (_) { /* ignore */ } }
  for (const p of procs) { if (!p.exited) { try { p.kill(); } catch (_) { /* ignore */ } } }
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* ignore */ }
  console.log(`\n${passes} passed, ${failures} failed`);
  setTimeout(() => process.exit(code), 300);
}
setTimeout(() => { console.log('FAIL - overall timeout'); failures += 1; cleanup(2); }, 420000);

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

{
  // R2: 힌트·부분 정답이 스냅샷에 남는다 / 공개할 글자가 없으면 hintsUsed 를 올리지 않는다 / choosing 중 맞히는 사람이 나가면 guesserLeft
  const sent = [];
  const room = new game.Room(fakeIo(sent), 'UNI4');
  for (const id of ['A', 'B', 'C']) room.addPlayer({ id, name: id, avatar: {}, token: 'tok4-' + id, socketId: id });
  room.updateSettings('A', { mode: 'relay', drawTime: 15, wordCount: 2, hints: 5, customWords: '가나,다라,마바,사아,자차,카타', customWordsOnly: true });
  room.start('A');
  room.chooseWord('A', room.wordOptions[0]);
  const parts = room.parts.slice();
  check('② 사용자 단어끼리 조합(요소 2개, 두 글자)', parts.length === 2 && parts.every((w) => Array.from(w).length === 2), parts);
  room.requestHint('A'); // 주자 → 무시
  check('② 주자의 hint:request 는 무시', room.relay.hintsUsed === 0);
  room.handleChat('C', parts[0]);
  check('② 부분 정답: solvedIdx {0}', same([...room.relay.solvedIdx], [0]) && room.phase === 'drawing');
  for (let i = 0; i < 5; i++) room.requestHint('C');
  check('② 못 맞힌 요소(두 글자)만 공개 → 2회까지만 쓰이고 나머지는 무시', room.relay.hintsUsed === 2 && room.relay.revealedByPart[0].size === 0 && room.relay.revealedByPart[1].size === 2,
    { hintsUsed: room.relay.hintsUsed, rev: room.relay.revealedByPart.map((x) => [...x]) });
  const hintsToB = sent.filter((x) => x.ev === 'game:hint' && [].concat(x.t).includes('B')).map((x) => x.p);
  check('② 차례 전 주자 B 에게도 힌트(부분 정답은 안 보이는 판)', hintsToB.length === 2 && hintsToB[1].wordMask === maskParts(parts, [new Set(), new Set([0, 1])]) && hintsToB[1].hintsUsed === 2, hintsToB);
  const snap = JSON.parse(JSON.stringify(room.toSnapshot()));
  check('② 스냅샷: hintsUsed·revealedByPart·solvedIdx 가 배열로', snap.relay.hintsUsed === 2 && same(snap.relay.solvedIdx, [0])
    && same(snap.relay.revealedByPart.map((x) => x.slice().sort()), [[], [0, 1]]), snap.relay);
  const restored = game.Room.fromSnapshot(fakeIo([]), snap);
  check('② 복원: Set 으로 돌아오고 마스크가 같다', restored.relay.solvedIdx instanceof Set && restored.relay.revealedByPart.every((x) => x instanceof Set)
    && restored.relayGuesserMask() === room.relayGuesserMask() && restored.relayMask() === room.relayMask(), { a: restored.relayGuesserMask(), b: room.relayGuesserMask() });
  restored.destroy();
  room.handleChat('C', parts[1]);
  check('② 나머지 요소를 맞히면 turnEnd(allGuessed), C 는 힌트 2회라 ×0.5, A 200, B 0',
    room.phase === 'turnEnd' && room.lastTurnEnd.reason === 'allGuessed'
      && same(room.lastTurnEnd.deltas.map((d) => d.id), ['A', 'B', 'C'])
      && room.lastTurnEnd.deltas[0].delta === 200 && room.lastTurnEnd.deltas[1].delta === 0
      && room.lastTurnEnd.deltas[2].delta === Math.max(50, Math.round((100 + 300 * room.timeLeft / 30) * 0.5)), room.lastTurnEnd);
  check('② 갤러리 guessed = 1', room.gallery[0] && room.gallery[0].guessed === 1, room.gallery[0]);
  room.destroy();
}
{
  const room = new game.Room(fakeIo([]), 'UNI5');
  for (const id of ['A', 'B', 'C', 'D']) room.addPlayer({ id, name: id, avatar: {}, token: 'tok5-' + id, socketId: id });
  room.updateSettings('A', { mode: 'relay', drawTime: 15 });
  room.start('A');
  room.removePlayer('D', 'left'); // 1번 문제의 맞히는 사람
  check('② choosing 중 맞히는 사람이 나가면 turnEnd(guesserLeft), 전원 0', room.phase === 'turnEnd' && room.lastTurnEnd.reason === 'guesserLeft'
    && room.lastTurnEnd.deltas.every((d) => d.delta === 0) && room.gallery.length === 0, room.lastTurnEnd);
  room.destroy();
}

// ── ⑤ R3 끊김·복원 (Room 단위, 가짜 io) ─────────────────────────
const sysTexts = (list) => list.filter((x) => x.ev === 'chat:message' && x.p && x.p.kind === 'system').map((x) => x.p.text);
function relayRoom(sent, code, ids, settings) {
  const room = new game.Room(fakeIo(sent), code);
  for (const id of ids) room.addPlayer({ id, name: id, avatar: {}, token: `tok-${code}-${id}`, socketId: id });
  room.updateSettings(ids[0], { mode: 'relay', drawTime: 15, wordCount: 2, ...(settings || {}) });
  return room;
}
/** 시간 불변식: 문제 전체 남은 시간 = 현재 구간 남은 시간 + 구간 시간 × 남은 뒤 구간 수 */
const legInvariant = (tl, r) => tl === r.legTimeLeft + r.legTime * (r.legCount - 1 - r.legIndex);
{
  // 끊긴 주자: 문제는 계속, 경계에서 넘어가고, 끊긴 채로 자기 구간이 오면 비워 두고 안내한 뒤 경계에서 넘어간다
  const sent = [];
  const room = relayRoom(sent, 'R3A', ['A', 'B', 'C']);
  room.start('A');
  room.chooseWord('A', room.wordOptions[0]);
  room.handleDraw('A', 'start', { tool: 'pen', color: '#000000', size: 5, x: 1, y: 1 });
  const mark = sent.length;
  room.markDisconnected('A');
  check('⑤ 현재 주자 A 가 끊김: 열린 획을 닫아 draw:end 중계, 문제는 계속(drawerLeft 없음)',
    room.phase === 'drawing' && room.drawerId === 'A' && room.currentStroke === null && sent.slice(mark).some((x) => x.ev === 'draw:end'));
  check('⑤ 안내: "A님의 연결이 끊어졌습니다. 구간이 끝나기 전에 돌아오면 이어서 그려요."',
    sysTexts(sent.slice(mark)).includes('A님의 연결이 끊어졌습니다. 구간이 끝나기 전에 돌아오면 이어서 그려요.'), sysTexts(sent.slice(mark)));
  room.markDisconnected('B');
  for (let i = 0; i < 15; i++) room.tick();
  check('⑤ 경계에서 끊긴 B 에게 구간이 넘어간다(건너뛰지 않음), 시간 불변식',
    room.phase === 'drawing' && room.drawerId === 'B' && room.relay.legIndex === 1 && room.relay.legTimeLeft === 15 && legInvariant(room.timeLeft, room.relay), room.relay);
  check('⑤ 안내: "B님 연결을 기다리는 중… 구간이 끝나면 다음 사람이 그려요."',
    sysTexts(sent).includes('B님 연결을 기다리는 중… 구간이 끝나면 다음 사람이 그려요.') && !sysTexts(sent).includes('B님이 이어서 그립니다.'), sysTexts(sent).slice(-3));
  for (let i = 0; i < 15; i++) room.tick();
  check('⑤ 비워 둔 구간이 끝나면 문제 종료(time)', room.phase === 'turnEnd' && room.lastTurnEnd.reason === 'time', room.lastTurnEnd);
  room.destroy();
}
{
  // 4명: 맞히는 사람이 이미 나간 문제는 건너뛰고 안내, round 는 올라간다
  const sent = [];
  const room = relayRoom(sent, 'R3B', ['A', 'B', 'C', 'D']);
  room.start('A');
  room.removePlayer('A', 'left');
  check('⑤ 4명 중 1번 문제 첫 주자 A 가 choosing 중 나감 → B 가 고른다', room.phase === 'choosing' && room.drawerId === 'B'
    && same(room.relay.order, ['B', 'C']) && room.relay.guesserId === 'D', room.relay);
  room.chooseWord('B', room.wordOptions[0]);
  room.handleChat('D', room.parts.join(' '));
  check('⑤ D 정답 → turnEnd(allGuessed)', room.phase === 'turnEnd' && room.lastTurnEnd.reason === 'allGuessed', room.lastTurnEnd);
  const mark = sent.length;
  room.nextTurn();
  const msgs = sysTexts(sent.slice(mark));
  check('⑤ 2번 문제(맞히는 사람 A 가 나감)는 건너뛰고 "문제 2/4: A님이 나가서 이 문제는 건너뛰어요."', msgs.includes('문제 2/4: A님이 나가서 이 문제는 건너뛰어요.'), msgs);
  const st = room.toState();
  check('⑤ 곧바로 3번 문제: round 3/4, 주자 C→D(나간 A 는 빠짐), 맞히는 사람 B', room.phase === 'choosing' && st.round === 3 && st.totalRounds === 4
    && same(st.relay.order, ['C', 'D']) && st.relay.guesserId === 'B' && st.drawerId === 'C', st.relay);
  const ch = sent.slice(mark).filter((x) => x.ev === 'game:choosing');
  check('⑤ 건너뛴 문제에는 game:choosing 이 없다(3번 문제 것만)', ch.length === 2 && ch.every((x) => x.p.drawerId === 'C'), ch.map((x) => x.p.drawerId));
  room.destroy();
}
{
  // 주자가 모두 나간 문제도 건너뛴다(관전자가 있어 인원은 된다). 마지막 문제까지 건너뛰면 게임 종료
  const sent = [];
  const room = relayRoom(sent, 'R3C', ['A', 'B', 'C']);
  room.start('A');
  room.addPlayer({ id: 'D', name: 'D', avatar: {}, token: 'tok-R3C-D', socketId: 'D' }); // 중간 참가(관전)
  room.addPlayer({ id: 'E', name: 'E', avatar: {}, token: 'tok-R3C-E', socketId: 'E' });
  room.chooseWord('A', room.wordOptions[0]);
  room.handleChat('C', room.parts.join(' '));
  room.removePlayer('B', 'left'); // turnEnd 중 2번 문제 주자 B·C 가 나간다(맞히는 사람 A 는 남음)
  room.removePlayer('C', 'left');
  const mark = sent.length;
  room.nextTurn();
  const msgs = sysTexts(sent.slice(mark));
  check('⑤ 주자가 모두 나간 2번 문제·맞히는 사람이 나간 3번 문제를 건너뛴다',
    msgs.includes('문제 2/3: 그릴 사람이 모두 나가서 이 문제는 건너뛰어요.') && msgs.includes('문제 3/3: B님이 나가서 이 문제는 건너뛰어요.'), msgs);
  check('⑤ 남은 문제가 없으면 game:over(gallery 1개)', sent.slice(mark).some((x) => x.ev === 'game:over' && x.p.gallery.length === 1) && room.phase === 'lobby');
  room.destroy();
}
{
  // 인원: 끊김만이면 문제를 계속하고, 실제 퇴장으로 전체 인원(유예 포함)이 모자라면 notEnoughPlayers
  const sent = [];
  const room = relayRoom(sent, 'R3D', ['A', 'B', 'C', 'D']);
  room.start('A');
  room.chooseWord('A', room.wordOptions[0]);
  room.markDisconnected('C'); // 차례 전 주자(유예 중)
  room.removePlayer('B', 'left'); // 차례 전 주자(퇴장) → 접속 2명(A·D), 전체 3명
  check('⑤ 접속 2명이라도 유예 중 포함 3명이면 문제 계속(B 는 order 에서 빠짐, 끊긴 C 는 남음)',
    room.phase === 'drawing' && same(room.relay.order, ['A', 'C']) && room.relay.legCount === 2, { phase: room.phase, relay: room.relay });
  room.removePlayer('C', 'left'); // 유예 만료 → 전체 2명
  check('⑤ 실제 퇴장으로 전체 2명 → turnEnd(notEnoughPlayers)', room.phase === 'turnEnd' && room.lastTurnEnd.reason === 'notEnoughPlayers', room.lastTurnEnd);
  room.destroy();

  const sent2 = [];
  const r2 = relayRoom(sent2, 'R3E', ['A', 'B', 'C']);
  r2.start('A');
  r2.chooseWord('A', r2.wordOptions[0]);
  r2.markDisconnected('B');
  r2.endTurn('time');
  const mark = sent2.length;
  r2.nextTurn();
  check('⑤ 다음 문제 때 접속 2명·유예 포함 3명 → 재접속을 기다린다(turnEnd 유지, 안내)', r2.phase === 'turnEnd'
    && sysTexts(sent2.slice(mark)).includes('다른 참가자의 재접속을 기다리고 있어요…'), sysTexts(sent2.slice(mark)));
  r2.reconnect('B', 'B2');
  r2.nextTurn();
  check('⑤ B 가 돌아오면 2번 문제(B 가 고름)', r2.phase === 'choosing' && r2.round === 2 && r2.drawerId === 'B', { phase: r2.phase, round: r2.round });
  r2.destroy();
}
{
  // choosing 중 저장 → 복원: 첫 주자에게 같은 후보, 나머지는 후보 없음. 고르면 저장된 요소로 이어진다
  const room = relayRoom([], 'R3F', ['A', 'B', 'C']);
  room.start('A');
  const opts = room.wordOptions.slice();
  const combos = new Map(room.comboOptions);
  const snap = JSON.parse(JSON.stringify(room.toSnapshot()));
  room.destroy();
  check('⑤ 스냅샷에 turnOrder·relay·comboOptions', same(snap.turnOrder, ['A', 'B', 'C']) && snap.relay && same(snap.relay.order, ['A', 'B']) && snap.comboOptions.length === opts.length, snap.relay);
  const sent = [];
  const r2 = game.Room.fromSnapshot(fakeIo(sent), snap);
  r2.resumeAfterRestore();
  r2.reconnect('A', 'A2');
  r2.reconnect('B', 'B2');
  const chA = sent.find((x) => x.ev === 'game:choosing' && x.t === 'A2');
  const chB = sent.find((x) => x.ev === 'game:choosing' && x.t === 'B2');
  check('⑤ choosing 복원: 첫 주자 A 에게 같은 후보, B 에게는 후보 없음', chA && same(chA.p.wordOptions, opts) && chB && chB.p.wordOptions === undefined && chA.p.timeLeft > 0, { chA, chB });
  check('⑤ choosing 복원: room:state.relay 유지', same(r2.toState().relay, { order: ['A', 'B'], guesserId: 'C', legIndex: 0, legCount: 2 }), r2.toState().relay);
  r2.chooseWord('A', opts[1]);
  check('⑤ 복원 뒤 고르면 저장된 요소로 drawing(timeLeft 30)', r2.phase === 'drawing' && same(r2.parts, combos.get(opts[1])) && r2.timeLeft === 30 && r2.relay.totalTime === 30, r2.parts);
  r2.destroy();
}
{
  // 구간 경계 바로 그때 저장된 스냅샷 → 복원하면 곧바로 다음 구간(시간 불변식 유지). 구간 중간이면 그 구간 남은 시간으로
  const room = relayRoom([], 'R3G', ['A', 'B', 'C', 'D']);
  room.start('A');
  room.chooseWord('A', room.wordOptions[0]);
  const snap = JSON.parse(JSON.stringify(room.toSnapshot()));
  room.destroy();
  const at = (secs) => { const now = Date.now(); return { ...JSON.parse(JSON.stringify(snap)), savedAt: now, phaseEndsAt: now + secs * 1000 }; };
  const sent = [];
  const r2 = game.Room.fromSnapshot(fakeIo(sent), at(30));
  r2.resumeAfterRestore();
  check('⑤ 남은 30초(첫 구간 0초)로 복원 → 곧바로 2구간(B), legTimeLeft 15, 불변식', r2.relay.legIndex === 1 && r2.drawerId === 'B' && r2.relay.legTimeLeft === 15
    && r2.timeLeft === 30 && legInvariant(r2.timeLeft, r2.relay) && sent.some((x) => x.ev === 'game:baton' && x.p.drawerId === 'B'), { relay: r2.relay, timeLeft: r2.timeLeft });
  r2.destroy();
  const r3 = game.Room.fromSnapshot(fakeIo([]), at(37));
  r3.resumeAfterRestore();
  check('⑤ 남은 37초로 복원 → 1구간(A) 7초, 불변식', r3.relay.legIndex === 0 && r3.drawerId === 'A' && r3.relay.legTimeLeft === 7 && legInvariant(r3.timeLeft, r3.relay), { relay: r3.relay, timeLeft: r3.timeLeft });
  r3.destroy();
}

// ── ③ 소켓 ─────────────────────────────────────────────────────
/** 테스트 서버 띄우기(ALLOW_SOLO 없이). EADDRINUSE 면 300ms 뒤 재시도(최대 3회) — 직전 프로세스가 닫은 포트가 아직 안 풀렸을 때 */
function startServer(port = PORT, extraEnv = {}, label = 'server', attemptsLeft = 3) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), ...extraEnv };
    delete env.ALLOW_SOLO;
    const proc = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    procs.push(proc);
    proc.logs = '';
    let addrInUse = false;
    let settled = false;
    proc.stdout.on('data', (d) => {
      proc.logs += String(d);
      if (!settled && String(d).includes('listening')) { settled = true; resolve(proc); }
    });
    proc.stderr.on('data', (d) => {
      proc.logs += String(d);
      if (String(d).includes('EADDRINUSE')) addrInUse = true;
      process.stderr.write(`[${label}:err] ` + d);
    });
    proc.on('exit', (code, sig) => {
      proc.exited = { code, sig };
      if (settled) return;
      settled = true;
      if (addrInUse && attemptsLeft > 1) setTimeout(() => { startServer(port, extraEnv, label, attemptsLeft - 1).then(resolve, reject); }, 300);
      else reject(new Error(label + ' exited'));
    });
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
  serverProc = await startServer();
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
  // (R2 부터 맞히는 사람의 채팅은 요소 판정 대상이라, 여기서는 어떤 요소와도 겹치지 않는 자모만 보낸다)
  c.emit('chat:message', { text: 'ㅋㅋㅋ' });
  c.emit('chat:message', { text: 'ㅎㅎ 뭘까' });
  await sleep(400);
  const cChats = [chatsSince(a, markA), chatsSince(b, markB), chatsSince(c, mark)];
  check('③ C 의 채팅은 전원에게 chat', cChats.every((list) => list.filter((m) => m.kind === 'chat' && m.id === C).length === 2), cChats);
  check('③ 요소와 상관없는 채팅은 correct·close 없음', cChats.every((list) => !list.some((m) => m.kind === 'correct' || m.kind === 'close')));

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

  // ── ④ R2 맞히기 ────────────────────────────────────────────────
  const revealed = (mask) => mask.split(' ').filter((t) => t && t !== '_' && t !== '·');
  const fullMask = (ps) => ps.map((x) => Array.from(x).join(' ')).join(PART_SEP);
  // 이번 문제(마지막 game:drawing 뒤)의 마지막 game:timer. 없으면 fallback
  const lastTimer = (cl, fallback) => {
    const from = cl.log.map((x) => x.ev).lastIndexOf('game:drawing');
    const e = cl.log.slice(from).filter((x) => x.ev === 'game:timer').pop();
    return e ? e.payload.timeLeft : fallback;
  };
  const nearPts = (got, f, tl) => [tl - 1, tl, tl + 1].some((t) => got === f(t));
  const setR2 = waitNext(a, 'room:state', (s) => s.settings.hints === 2 && s.settings.wordCount === 2, 5000, 'R2 settings');
  a.emit('room:settings', { settings: { mode: 'relay', drawTime: 15, wordCount: 2, hints: 2 } });
  await setR2;
  const r1chA = waitNext(a, 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, 'R2 choosing 1');
  a.emit('game:start');
  const r1ch = await r1chA;
  check('④ 새 게임 1번 문제: A 가 후보 2개', r1ch.drawerId === A && r1ch.wordOptions.length === 2, r1ch);
  const w1 = r1ch.wordOptions[0];
  const p1 = w1.split(PART_SEP);
  const r1d = [waitNext(a, 'game:drawing', undefined, 5000, 'R2 d A'), waitNext(b, 'game:drawing', undefined, 5000, 'R2 d B'), waitNext(c, 'game:drawing', undefined, 5000, 'R2 d C')];
  a.emit('word:choose', { word: w1 });
  const [r1dA] = await Promise.all(r1d);
  check('④ game:drawing.relay.hintsUsed 0, hintsMax 2', r1dA.relay.hintsUsed === 0 && r1dA.relay.hintsMax === 2 && r1dA.word === w1, r1dA.relay);

  // 1. 비주자 힌트 무시
  mark = c.log.length; markA = a.log.length; markB = b.log.length;
  a.emit('hint:request');
  b.emit('hint:request');
  await sleep(400);
  check('④ 주자(A·B)의 hint:request 는 무시(아무 game:hint 없음)',
    !evsSince(a, markA, 'game:hint').length && !evsSince(b, markB, 'game:hint').length && !evsSince(c, mark, 'game:hint').length);

  // 2. 힌트: C·B 에게, A 에게는 안 감
  markA = a.log.length;
  let hC = waitNext(c, 'game:hint', undefined, 3000, 'hint1 C');
  let hB = waitNext(b, 'game:hint', undefined, 3000, 'hint1 B');
  c.emit('hint:request');
  const [h1C, h1B] = await Promise.all([hC, hB]);
  check('④ 힌트 1회: C·B 에게 hintsUsed 1, 마스크에 초성 1개', h1C.hintsUsed === 1 && h1B.hintsUsed === 1 && revealed(h1C.wordMask).length === 1
    && /^[ㄱ-ㅎA-Za-z0-9]$/.test(revealed(h1C.wordMask)[0]) && h1B.wordMask === h1C.wordMask, { h1C, h1B });
  hC = waitNext(c, 'game:hint', undefined, 3000, 'hint2 C');
  hB = waitNext(b, 'game:hint', undefined, 3000, 'hint2 B');
  c.emit('hint:request');
  const [h2C, h2B] = await Promise.all([hC, hB]);
  check('④ 힌트 2회: hintsUsed 2, 공개 2개', h2C.hintsUsed === 2 && h2B.hintsUsed === 2 && revealed(h2C.wordMask).length === 2, { h2C, h2B });
  mark = c.log.length; markB = b.log.length;
  c.emit('hint:request');
  await sleep(400);
  check('④ 세 번째 hint:request 는 무시(hints 2)', !evsSince(c, mark, 'game:hint').length && !evsSince(b, markB, 'game:hint').length);
  check('④ A(현재 주자)에게는 힌트가 안 간다', !evsSince(a, markA, 'game:hint').length);

  // 3. 부분 정답: 다른 요소를 품지 않은 쪽을 먼저 보낸다(포함 관계면 한 번에 둘 다 맞아 버린다)
  const firstIdx = p1[0].includes(p1[1]) ? 1 : 0;
  const restIdx = 1 - firstIdx;
  mark = c.log.length; markA = a.log.length; markB = b.log.length;
  const closeP = waitNext(c, 'chat:message', (m) => m.kind === 'close', 3000, 'partial close');
  const hintP = waitNext(c, 'game:hint', undefined, 3000, 'partial hint');
  c.emit('chat:message', { text: p1[firstIdx] });
  const [closeMsg, partialHint] = await Promise.all([closeP, hintP]);
  check('④ 부분 정답: C 에게 close + partial { solved:1, total:2 }', same(closeMsg.partial, { solved: 1, total: 2 }) && closeMsg.text === p1[firstIdx] && closeMsg.id === C, closeMsg);
  const maskPartsOf = (m) => m.split(PART_SEP);
  check('④ 부분 정답: C 의 game:hint 에서 그 요소가 글자로, hintsUsed 2', maskPartsOf(partialHint.wordMask)[firstIdx] === Array.from(p1[firstIdx]).join(' ')
    && maskPartsOf(partialHint.wordMask)[restIdx].includes('_') && partialHint.hintsUsed === 2, partialHint);
  await sleep(300);
  check('④ 부분 정답: A·B 에게는 같은 text 의 chat', [chatsSince(a, markA), chatsSince(b, markB)].every((list) => list.some((m) => m.kind === 'chat' && m.id === C && m.text === p1[firstIdx])
    && !list.some((m) => m.kind === 'close' || m.kind === 'correct')), [chatsSince(a, markA), chatsSince(b, markB)]);
  check('④ 부분 정답: B 에게 game:hint 없음, correct 없음', !evsSince(b, markB, 'game:hint').length && !chatsSince(c, mark, 'correct').length);

  // 4. 누적 정답
  mark = c.log.length; markA = a.log.length; markB = b.log.length;
  const guessText = `혹시 ${p1[restIdx]}인가`;
  const tl1 = lastTimer(c, 30);
  const te1 = [waitNext(a, 'game:turnEnd', undefined, 5000, 'te1 A'), waitNext(b, 'game:turnEnd', undefined, 5000, 'te1 B'), waitNext(c, 'game:turnEnd', undefined, 5000, 'te1 C')];
  c.emit('chat:message', { text: guessText });
  const [te1A] = await Promise.all(te1);
  check('④ 누적 정답 → turnEnd(allGuessed), word = 조합', te1A.reason === 'allGuessed' && te1A.word === w1, te1A);
  for (const [cl, from, label] of [[a, markA, 'A'], [b, markB, 'B'], [c, mark, 'C']]) {
    check(`④ ${label}: correct 메시지·player:guessed(C), 보낸 문장은 안 보임`, chatsSince(cl, from, 'correct').some((m) => m.id === C)
      && evsSince(cl, from, 'player:guessed').some((x) => x.payload.id === C) && !chatsSince(cl, from).some((m) => m.text === guessText));
  }
  const d1 = Object.fromEntries(te1A.deltas.map((d) => [d.id, d.delta]));
  const fHalf = (t) => Math.max(50, Math.round((100 + 300 * t / 30) * 0.5));
  check('④ 점수: C = 힌트 2회 ×0.5, A = 200(구간 가짐), B = 0(아직 안 그림)', nearPts(d1[C], fHalf, tl1) && d1[A] === 200 && d1[B] === 0 && te1A.deltas.length === 3, { d1, tl1 });
  const lastHintC = evsSince(c, mark, 'game:hint').pop();
  check('④ C 의 마지막 game:hint 는 전체 공개(_ 없음)', lastHintC && !lastHintC.payload.wordMask.includes('_') && lastHintC.payload.wordMask === fullMask(p1), lastHintC);

  // 5. 2번 문제(B→C / A): 두 구간 뒤 한 번에 정답
  const r2ch = await waitNext(b, 'game:choosing', (p) => Array.isArray(p.wordOptions), 10000, 'R2 choosing 2');
  const w2 = r2ch.wordOptions[0];
  const p2 = w2.split(PART_SEP);
  const r2d = waitNext(a, 'game:drawing', undefined, 5000, 'R2 d2 A');
  b.emit('word:choose', { word: w2 });
  const r2dA = await r2d;
  check('④ 2번 문제: A 가 맞히는 사람, hintsUsed 0 으로 새로 시작', r2dA.relay.guesserId === A && r2dA.relay.hintsUsed === 0 && !revealed(r2dA.wordMask).length, r2dA);
  const baton2 = await waitNext(a, 'game:baton', undefined, 20000, 'R2 baton');
  check('④ game:baton 에 hintsUsed', baton2.hintsUsed === 0 && baton2.drawerId === C, baton2);
  await sleep(1200);
  const tl2 = lastTimer(a, 15);
  const te2P = waitNext(a, 'game:turnEnd', undefined, 5000, 'te2');
  a.emit('chat:message', { text: `${p2[0]} ${p2[1]}` });
  const te2 = await te2P;
  const d2 = Object.fromEntries(te2.deltas.map((d) => [d.id, d.delta]));
  const fFull = (t) => Math.max(50, Math.round(100 + 300 * t / 30));
  check('④ 두 구간 뒤 정답: B·C 200, A = 힌트 0회 공식', te2.reason === 'allGuessed' && d2[B] === 200 && d2[C] === 200 && nearPts(d2[A], fFull, tl2), { d2, tl2 });

  // 6. 3번 문제(C→A / B): 힌트는 차례 전 주자 A 에게도, 현재 주자 C 에게는 안 감 → 시간 초과
  const r3ch = await waitNext(c, 'game:choosing', (p) => Array.isArray(p.wordOptions), 10000, 'R2 choosing 3');
  const r3d = waitNext(b, 'game:drawing', undefined, 5000, 'R2 d3 B');
  c.emit('word:choose', { word: r3ch.wordOptions[0] });
  await r3d;
  mark = c.log.length;
  const h3A = waitNext(a, 'game:hint', undefined, 3000, 'hint3 A');
  const h3B = waitNext(b, 'game:hint', undefined, 3000, 'hint3 B');
  b.emit('hint:request');
  const [x3A, x3B] = await Promise.all([h3A, h3B]);
  await sleep(300);
  check('④ 3번 문제 힌트: 차례 전 주자 A·맞히는 사람 B 에게, 현재 주자 C 에게는 안 감', x3A.hintsUsed === 1 && x3B.hintsUsed === 1 && x3A.wordMask === x3B.wordMask
    && !evsSince(c, mark, 'game:hint').length, { x3A, x3B });
  const te3 = await waitNext(a, 'game:turnEnd', undefined, 40000, 'te3');
  check('④ 아무도 못 맞히면 turnEnd(time), 전원 0', te3.reason === 'time' && te3.deltas.every((d) => d.delta === 0), te3);
  const over = await waitNext(a, 'game:over', undefined, 10000, 'R2 game:over');
  const total = (id) => (d1[id] || 0) + (d2[id] || 0);
  const rk = Object.fromEntries(over.ranking.map((r) => [r.id, r.score]));
  check('④ game:over: mode relay, ranking 점수 = 문제별 합', over.mode === 'relay' && rk[A] === total(A) && rk[B] === total(B) && rk[C] === total(C), { rk, d1, d2 });
  check('④ game:over.gallery: drawerIds [A]·[B,C]·[C,A], guesserId C·A·B, guessed 1·1·0',
    over.gallery.length === 3 && same(over.gallery.map((g) => g.drawerIds), [[A], [B, C], [C, A]])
      && same(over.gallery.map((g) => g.guesserId), [C, A, B]) && same(over.gallery.map((g) => g.guessed), [1, 1, 0]),
    over.gallery.map((g) => ({ drawerIds: g.drawerIds, guesserId: g.guesserId, guessed: g.guessed })));

  // 7. guesserLeft: 새 방 3명, 1번 문제 drawing 중 맞히는 사람이 나감
  const d = await connect('D'), e = await connect('E'), f = await connect('F');
  const cd = await emitAck(d, 'room:create', { name: '디', avatar: {}, token: 'tok-relay-d-000004' });
  const D = cd.playerId;
  const je = await emitAck(e, 'room:join', { roomCode: cd.roomCode, name: '이', avatar: {}, token: 'tok-relay-e-000005' });
  const E = je.playerId;
  const jf = await emitAck(f, 'room:join', { roomCode: cd.roomCode, name: '에프', avatar: {}, token: 'tok-relay-f-000006' });
  const F = jf.playerId;
  const setG = waitNext(d, 'room:state', (s) => s.settings.mode === 'relay', 5000, 'G settings');
  d.emit('room:settings', { settings: { mode: 'relay', drawTime: 15, wordCount: 2 } });
  await setG;
  const gch = waitNext(d, 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, 'G choosing');
  d.emit('game:start');
  const gc = await gch;
  const gdr = waitNext(e, 'game:drawing', undefined, 5000, 'G drawing');
  d.emit('word:choose', { word: gc.wordOptions[0] });
  const gd = await gdr;
  check('④ guesserLeft 준비: 주자 D→E, 맞히는 사람 F', same(gd.relay.order, [D, E]) && gd.relay.guesserId === F, gd.relay);
  const gte = waitNext(d, 'game:turnEnd', undefined, 5000, 'G turnEnd');
  const gover = waitNext(d, 'game:over', undefined, 12000, 'G over');
  f.emit('room:leave');
  const gt = await gte;
  check('④ 맞히는 사람이 나가면 즉시 turnEnd(guesserLeft), deltas 0', gt.reason === 'guesserLeft' && gt.deltas.length === 2 && gt.deltas.every((x) => x.delta === 0), gt);
  const go = await gover;
  await sleep(200);
  check('④ 그 뒤 2명이라 게임 종료(game:over → lobby)', go.mode === 'relay' && go.gallery.length === 1 && go.gallery[0].guessed === 0 && lastState(d).phase === 'lobby',
    { go: go.gallery, phase: lastState(d).phase });
  check('④ (참고) E 도 같은 결과', lastState(e) && lastState(e).phase === 'lobby' && !!E);

  // ── ⑤ R3 끊김·복원(소켓, 기본 유예 60초) ─────────────────────────
  const byId = (list, id) => list.find((p) => p.id === id);
  const offline = (cl, id, label) => waitNext(cl, 'room:state', (s) => byId(s.players, id) && byId(s.players, id).connected === false, 5000, label);
  const lastEvOf = (cl, ev) => { const e = cl.log.filter((x) => x.ev === ev).pop(); return e ? e.payload : null; };
  /** 새 소켓으로 room:rejoin 하고 catch-up(game:drawing + draw:sync)을 받는다 */
  async function rejoinDrawing(label, roomCode, token) {
    const cl = await connect(label);
    const dP = waitNext(cl, 'game:drawing', undefined, 5000, label + ' catch-up');
    const sP = waitNext(cl, 'draw:sync', undefined, 5000, label + ' sync');
    const ack = await emitAck(cl, 'room:rejoin', { roomCode, token });
    const [dr, sy] = await Promise.all([dP, sP]);
    return { cl, ack, dr, sy };
  }
  /** 다른 요소를 품지 않은 요소 하나(그것만 보내면 그 요소 하나만 맞는다) */
  const loneIdx = (ps) => ps.findIndex((w, i) => ps.every((o, j) => j === i || !w.includes(o)));
  const TK = { X: 'tok-relay-x-000007', Y: 'tok-relay-y-000008', Z: 'tok-relay-z-000009' };
  let x = await connect('X'), y = await connect('Y'), z = await connect('Z');
  const cx = await emitAck(x, 'room:create', { name: '엑스', avatar: {}, token: TK.X });
  const code5 = cx.roomCode;
  const X = cx.playerId;
  const Y = (await emitAck(y, 'room:join', { roomCode: code5, name: '와이', avatar: {}, token: TK.Y })).playerId;
  const Z = (await emitAck(z, 'room:join', { roomCode: code5, name: '제트', avatar: {}, token: TK.Z })).playerId;
  const set5 = waitNext(x, 'room:state', (s) => s.settings.mode === 'relay' && s.settings.hints === 2, 5000, '⑤ settings');
  x.emit('room:settings', { settings: { mode: 'relay', drawTime: 15, wordCount: 2, hints: 2 } });
  await set5;
  const ch5P = waitNext(x, 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, '⑤ choosing');
  x.emit('game:start');
  const w5 = (await ch5P).wordOptions[0];
  const p5 = w5.split(PART_SEP);
  const d5 = [x, y, z].map((cl) => waitNext(cl, 'game:drawing', undefined, 5000, '⑤ drawing'));
  x.emit('word:choose', { word: w5 });
  const [d5X] = await Promise.all(d5);
  check('⑤ 준비: 주자 X→Y, 맞히는 사람 Z', same(d5X.relay.order, [X, Y]) && d5X.relay.guesserId === Z, d5X.relay);
  // X 가 획 하나, Z 가 부분 정답 1개 + 힌트 1회
  const zEnd = waitNext(z, 'draw:end', undefined, 3000, '⑤ X stroke');
  x.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 50, y: 50 });
  x.emit('draw:move', { pts: [[60, 60], [70, 70]] });
  x.emit('draw:end');
  await zEnd;
  const fi5 = loneIdx(p5), ri5 = 1 - fi5;
  const zPart = waitNext(z, 'game:hint', undefined, 3000, '⑤ partial');
  z.emit('chat:message', { text: p5[fi5] });
  await zPart;
  const zH = waitNext(z, 'game:hint', (h) => h.hintsUsed === 1, 3000, '⑤ hint Z');
  const yH = waitNext(y, 'game:hint', (h) => h.hintsUsed === 1, 3000, '⑤ hint Y');
  z.emit('hint:request');
  const [hz5, hy5] = await Promise.all([zH, yH]);

  // 3. 차례 전 주자 Y 끊김 → 복귀: word 없음, 마스크(힌트 반영, 부분 정답은 안 보임)
  let off = offline(x, Y, '⑤ Y off');
  y.disconnect();
  await off;
  let rj = await rejoinDrawing('Y2', code5, TK.Y);
  y = rj.cl;
  check('⑤ 차례 전 주자 Y 복귀: 같은 id, word 없음, wordMask = 힌트 반영 마스크, relay.legIndex 0·hintsUsed 1',
    rj.ack.ok && rj.ack.playerId === Y && rj.dr.word === undefined && rj.dr.wordMask === hy5.wordMask && rj.dr.relay.legIndex === 0 && rj.dr.relay.hintsUsed === 1,
    { ack: rj.ack, dr: rj.dr, hy5 });
  check('⑤ Y 복귀 draw:sync 에 X 의 획', rj.sy.ops.length === 1 && rj.sy.ops[0].points.length === 3, rj.sy.ops);

  // 4. 맞히는 사람 Z 끊김 → 복귀: 맞힌 요소가 글자로, hintsUsed 1, draw:sync
  off = offline(x, Z, '⑤ Z off');
  z.disconnect();
  await off;
  rj = await rejoinDrawing('Z2', code5, TK.Z);
  z = rj.cl;
  check('⑤ 맞히는 사람 Z 복귀: 마스크에 맞힌 요소가 글자로(끊기기 전과 같음), hintsUsed 1, word 없음',
    rj.dr.wordMask === hz5.wordMask && rj.dr.wordMask.split(PART_SEP)[fi5] === Array.from(p5[fi5]).join(' ') && rj.dr.wordMask.split(PART_SEP)[ri5].includes('_')
      && rj.dr.relay.hintsUsed === 1 && rj.dr.word === undefined, { dr: rj.dr, hz5 });
  check('⑤ Z 복귀 draw:sync 에 X 의 획', rj.sy.ops.length === 1, rj.sy.ops);

  // 2. 현재 주자 X 끊김 → 자기 구간 안에 복귀: 남은 구간 시간·word·ops, 이어서 그린다
  const sysOnY = waitNext(y, 'chat:message', (m) => m.kind === 'system' && /엑스님의 연결이 끊어졌습니다\. 구간이 끝나기 전에 돌아오면 이어서 그려요/.test(m.text), 5000, '⑤ X off msg');
  off = offline(y, X, '⑤ X off');
  x.disconnect();
  await Promise.all([off, sysOnY]);
  await sleep(1500);
  rj = await rejoinDrawing('X2', code5, TK.X);
  x = rj.cl;
  const zLeg = lastEvOf(z, 'game:timer');
  check('⑤ 현재 주자 X 가 자기 구간 안에 복귀: word, legIndex 0, legTimeLeft 가 남은 구간 시간과 ±1, 불변식',
    rj.dr.word === w5 && rj.dr.drawerId === X && rj.dr.relay.legIndex === 0 && zLeg && Math.abs(rj.dr.relay.legTimeLeft - zLeg.legTimeLeft) <= 1
      && rj.dr.relay.legTimeLeft < 15 && legInvariant(rj.dr.timeLeft, rj.dr.relay), { relay: rj.dr.relay, timeLeft: rj.dr.timeLeft, zLeg });
  check('⑤ X 복귀 draw:sync 에 끊기기 전 획', rj.sy.ops.length === 1 && rj.sy.ops[0].points.length === 3, rj.sy.ops);
  const zS = waitNext(z, 'draw:start', undefined, 3000, '⑤ X draws again');
  const yS = waitNext(y, 'draw:start', undefined, 3000, '⑤ X draws again Y');
  x.emit('draw:start', { tool: 'pen', color: '#ff0000', size: 5, x: 300, y: 300 });
  x.emit('draw:move', { pts: [[310, 310]] });
  x.emit('draw:end');
  await Promise.all([zS, yS]);
  check('⑤ 복귀한 X 의 그림이 다시 중계된다', true);

  // 1. 현재 주자 X 가 끊긴 채 경계 → Y 에게 baton(문제는 안 끝남) → X 가 Y 구간 중 복귀: word 는 받고 그림은 무시
  off = offline(y, X, '⑤ X off 2');
  x.disconnect();
  await off;
  const byP = waitNext(y, 'game:baton', undefined, 17000, '⑤ baton Y');
  const bzP = waitNext(z, 'game:baton', undefined, 17000, '⑤ baton Z');
  const [by5, bz5] = await Promise.all([byP, bzP]);
  check('⑤ 끊긴 X 의 구간 경계에서 Y 에게 baton(word 는 Y 에게만), 문제 계속',
    by5.drawerId === Y && by5.legIndex === 1 && by5.word === w5 && bz5.word === undefined && !z.log.some((q) => q.ev === 'game:turnEnd'), { by5, bz5 });
  rj = await rejoinDrawing('X3', code5, TK.X);
  x = rj.cl;
  check('⑤ 구간이 끝난 뒤 복귀한 X(지난 주자): word 받음, drawerId Y, legIndex 1', rj.dr.word === w5 && rj.dr.drawerId === Y && rj.dr.relay.legIndex === 1, rj.dr);
  check('⑤ X 복귀 draw:sync 에 X 의 두 획', rj.sy.ops.length === 2, rj.sy.ops.length);
  let mz = z.log.length;
  x.emit('draw:start', { tool: 'pen', color: '#00ff00', size: 5, x: 500, y: 500 });
  x.emit('draw:end');
  await sleep(400);
  check('⑤ 지난 주자 X 의 draw:start 는 무시된다', !evsSince(z, mz, 'draw:start').length && !evsSince(y, 0, 'draw:start').some((q) => q.payload.x === 500));

  // 4(이어서). Z 가 나머지 요소를 맞히면 정답: 힌트 1회 ×0.75, X·Y 200
  const tl5 = (() => { const t = lastEvOf(z, 'game:timer'); return t ? t.timeLeft : 15; })();
  const te5P = waitNext(z, 'game:turnEnd', undefined, 5000, '⑤ turnEnd');
  z.emit('chat:message', { text: p5[ri5] });
  const te5 = await te5P;
  const dd5 = Object.fromEntries(te5.deltas.map((q) => [q.id, q.delta]));
  const f75 = (t) => Math.max(50, Math.round((100 + 300 * t / 30) * 0.75));
  check('⑤ 복귀한 Z 가 나머지 요소로 정답: allGuessed, Z = 힌트 1회 ×0.75, X·Y 200', te5.reason === 'allGuessed' && dd5[X] === 200 && dd5[Y] === 200
    && [tl5 - 1, tl5, tl5 + 1].some((t) => dd5[Z] === f75(t)), { dd5, tl5 });

  // turnEnd 중 복귀: game:turnEnd 재전송, 자기 delta 가 한 줄만
  off = offline(x, Y, '⑤ Y off 2');
  y.disconnect();
  await off;
  const y3 = await connect('Y3');
  const teCP = waitNext(y3, 'game:turnEnd', undefined, 5000, '⑤ turnEnd catch-up');
  await emitAck(y3, 'room:rejoin', { roomCode: code5, token: TK.Y });
  const teC = await teCP;
  check('⑤ turnEnd 중 복귀: game:turnEnd 재전송, Y 의 delta 가 한 줄(200), 3명', teC.reason === 'allGuessed' && teC.deltas.length === 3
    && teC.deltas.filter((q) => q.id === Y).length === 1 && teC.deltas.find((q) => q.id === Y).delta === 200, teC.deltas);
  for (const cl of [x, y3, z]) cl.emit('room:leave');
  await sleep(300);

  // ── ⑤ 유예 만료(RECONNECT_GRACE_MS 2.5초, 5명) ─────────────────────
  const GRACE = 2500;
  const gproc = await startServer(PORT_GRACE, { RECONNECT_GRACE_MS: String(GRACE), HOST_RETURN_MS: '800' }, 'grace');
  URL = `http://localhost:${PORT_GRACE}`;
  const g = [];
  for (let i = 0; i < 5; i++) g.push(await connect('G' + (i + 1)));
  const gc0 = await emitAck(g[0], 'room:create', { name: '지일', avatar: {}, token: 'tok-relay-g1-00010' });
  const G = [gc0.playerId];
  const gNames = ['지일', '지이', '지삼', '지사', '지오'];
  for (let i = 1; i < 5; i++) G.push((await emitAck(g[i], 'room:join', { roomCode: gc0.roomCode, name: gNames[i], avatar: {}, token: `tok-relay-g${i + 1}-0001${i}` })).playerId);
  const gSet = waitNext(g[0], 'room:state', (s) => s.settings.mode === 'relay', 5000, 'G5 settings');
  g[0].emit('room:settings', { settings: { mode: 'relay', drawTime: 15, wordCount: 2 } });
  await gSet;
  const gChP = waitNext(g[0], 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, 'G5 choosing');
  g[0].emit('game:start');
  const gCh = await gChP;
  const gDP = waitNext(g[1], 'game:drawing', undefined, 5000, 'G5 drawing');
  g[0].emit('word:choose', { word: gCh.wordOptions[0] });
  const gD = await gDP;
  check('⑤ 유예 준비: 5명, 주자 1~4, 맞히는 사람 5, 문제 1/5', same(gD.relay.order, G.slice(0, 4)) && gD.relay.guesserId === G[4] && gD.totalRounds === 5, gD.relay);
  // 현재 주자(1)의 유예 만료 → 완전히 나감 → 경계를 기다리지 않고 곧바로 다음 구간(2)
  const gBP = waitNext(g[1], 'game:baton', undefined, GRACE + 4000, 'G5 baton after grace');
  const tOff = Date.now();
  g[0].disconnect();
  const gB = await gBP;
  const gEl = Date.now() - tOff;
  check(`⑤ 현재 주자 유예 만료(${gEl}ms) → 곧바로 다음 주자에게 baton(legTimeLeft 15)`, gB.drawerId === G[1] && gB.legTimeLeft === 15 && gEl >= GRACE - 300 && gEl < GRACE + 3000, { gB, gEl });
  // 맞히는 사람(5)의 유예 만료 → guesserLeft
  const gTP = waitNext(g[1], 'game:turnEnd', undefined, GRACE + 4000, 'G5 guesserLeft');
  g[4].disconnect();
  const gT = await gTP;
  check('⑤ 맞히는 사람 유예 만료 → game:turnEnd { reason:"guesserLeft" }, 전원 0', gT.reason === 'guesserLeft' && gT.deltas.every((q) => q.delta === 0), gT);
  // 2번 문제(맞히는 사람 1 은 나감) 건너뛰고 3번 문제: 주자 3→4(5·1 은 나감), 맞히는 사람 2
  const gSkipP = waitNext(g[1], 'chat:message', (m) => m.kind === 'system' && m.text === '문제 2/5: 지일님이 나가서 이 문제는 건너뛰어요.', 8000, 'G5 skip msg');
  const gCh3P = waitNext(g[2], 'game:choosing', (p) => Array.isArray(p.wordOptions), 8000, 'G5 choosing 3');
  const [, gCh3] = await Promise.all([gSkipP, gCh3P]);
  await sleep(200);
  const gSt = lastState(g[1]);
  check('⑤ 나간 사람이 맞힐 2번 문제는 안내 뒤 건너뛰고 3번 문제(round 3/5, 주자 3→4, 맞히는 사람 2)', gCh3.drawerId === G[2] && gSt.round === 3 && gSt.totalRounds === 5
    && same(gSt.relay.order, [G[2], G[3]]) && gSt.relay.guesserId === G[1], gSt && { round: gSt.round, relay: gSt.relay });
  // 한 명 더 나가면(3명 → 2명) 문제 중 notEnoughPlayers → game:over
  const gNP = waitNext(g[1], 'game:turnEnd', undefined, 3000, 'G5 notEnough');
  const gOverP = waitNext(g[1], 'game:over', undefined, 9000, 'G5 over');
  g[3].emit('room:leave');
  const gN = await gNP;
  check('⑤ 문제 중 실제 퇴장으로 2명 → turnEnd(notEnoughPlayers)', gN.reason === 'notEnoughPlayers', gN);
  await gOverP;
  check('⑤ 그 뒤 game:over', true);
  for (const cl of [g[1], g[2]]) cl.emit('room:leave');
  await sleep(300);
  await stopServer(gproc);

  // ── ⑤ 서버 재시작 복원(파일 저장소, 4명, 2구간째) ─────────────────
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* ignore */ }
  const storeEnv = { STORE_URL: 'file:' + STATE_FILE, RECONNECT_GRACE_MS: '60000', HOST_RETURN_MS: '1500' };
  let sproc = await startServer(PORT_STORE, storeEnv, 'storeA');
  URL = `http://localhost:${PORT_STORE}`;
  const sT = ['tok-relay-s1-000021', 'tok-relay-s2-000022', 'tok-relay-s3-000023', 'tok-relay-s4-000024'];
  const sc = [];
  for (let i = 0; i < 4; i++) sc.push(await connect('S' + (i + 1)));
  const s0 = await emitAck(sc[0], 'room:create', { name: '에스일', avatar: {}, token: sT[0] });
  const scode = s0.roomCode;
  const S = [s0.playerId];
  for (let i = 1; i < 4; i++) S.push((await emitAck(sc[i], 'room:join', { roomCode: scode, name: '에스' + (i + 1), avatar: {}, token: sT[i] })).playerId);
  const sSet = waitNext(sc[0], 'room:state', (st) => st.settings.mode === 'relay' && st.settings.hints === 2, 5000, 'S settings');
  sc[0].emit('room:settings', { settings: { mode: 'relay', drawTime: 15, wordCount: 2, hints: 2 } });
  await sSet;
  const sChP = waitNext(sc[0], 'game:choosing', (p) => Array.isArray(p.wordOptions), 5000, 'S choosing');
  sc[0].emit('game:start');
  const sw = (await sChP).wordOptions[0];
  const sp = sw.split(PART_SEP);
  const sDP = waitNext(sc[3], 'game:drawing', undefined, 5000, 'S drawing');
  sc[0].emit('word:choose', { word: sw });
  const sD = await sDP;
  check('⑤ 복원 준비: 4명, 주자 1→2→3, 맞히는 사람 4, 요소 3개', same(sD.relay.order, S.slice(0, 3)) && sD.relay.guesserId === S[3] && sp.length === 3, { relay: sD.relay, sp });
  const sEnd = waitNext(sc[3], 'draw:end', undefined, 3000, 'S stroke 1');
  sc[0].emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 20, y: 20 });
  sc[0].emit('draw:move', { pts: [[30, 30]] });
  sc[0].emit('draw:end');
  await sEnd;
  const sfi = loneIdx(sp);
  const sPart = waitNext(sc[3], 'game:hint', undefined, 3000, 'S partial');
  sc[3].emit('chat:message', { text: sp[sfi] });
  await sPart;
  const sH4 = waitNext(sc[3], 'game:hint', (h) => h.hintsUsed === 1, 3000, 'S hint 4');
  const sH3 = waitNext(sc[2], 'game:hint', (h) => h.hintsUsed === 1, 3000, 'S hint 3');
  sc[3].emit('hint:request');
  const [sh4, sh3] = await Promise.all([sH4, sH3]);
  const sBP = waitNext(sc[1], 'game:baton', undefined, 17000, 'S baton 2');
  await sBP;
  const sEnd2 = waitNext(sc[3], 'draw:end', undefined, 3000, 'S stroke 2');
  sc[1].emit('draw:start', { tool: 'pen', color: '#0000ff', size: 9, x: 400, y: 300 });
  sc[1].emit('draw:move', { pts: [[410, 310], [420, 320]] });
  sc[1].emit('draw:end');
  await sEnd2;
  await sleep(800); // 저장 스로틀(300ms) 여유
  const sBefore = lastEvOf(sc[3], 'game:timer');
  const snapA = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))[scode];
  check('⑤ 저장된 스냅샷: relay(legIndex 1·hintsUsed 1·solvedIdx·revealedByPart)·parts·turnOrder',
    snapA && snapA.relay && snapA.relay.legIndex === 1 && snapA.relay.hintsUsed === 1 && same(snapA.relay.solvedIdx, [sfi])
      && snapA.relay.revealedByPart.length === 3 && same(snapA.parts, sp) && same(snapA.turnOrder, S) && snapA.ops.length === 2, snapA && snapA.relay);
  const sDisc = Promise.all(sc.map((cl) => new Promise((r) => cl.once('disconnect', r))));
  await stopServer(sproc);
  await sDisc;
  await sleep(1500); // 다운타임 — 게임 시간에서 빠지지 않아야 한다
  sproc = await startServer(PORT_STORE, storeEnv, 'storeB');
  const sb = [];
  for (let i = 0; i < 4; i++) sb.push(await connect('SB' + (i + 1)));
  const sCu = sb.map((cl, i) => Promise.all([waitNext(cl, 'game:drawing', undefined, 5000, 'SB drawing ' + i), waitNext(cl, 'draw:sync', undefined, 5000, 'SB sync ' + i)]));
  const sAcks = [];
  for (let i = 0; i < 4; i++) sAcks.push(await emitAck(sb[i], 'room:rejoin', { roomCode: scode, token: sT[i] }));
  const sGot = await Promise.all(sCu);
  check('⑤ 재시작 뒤 복원(서버 로그), 전원 같은 id 로 복귀', /restored room [A-Z]{4} from store \(phase drawing, 4 players\)/.test(sproc.logs)
    && sAcks.every((ak, i) => ak.ok && ak.playerId === S[i]), sAcks);
  const sDr = sGot.map((x2) => x2[0]);
  const sSy = sGot.map((x2) => x2[1]);
  check('⑤ 복원: 전원 같은 구간(legIndex 1/3, drawerId 2), hintsUsed 1', sDr.every((dr) => dr.relay.legIndex === 1 && dr.relay.legCount === 3 && dr.drawerId === S[1] && dr.relay.hintsUsed === 1 && dr.relay.guesserId === S[3]),
    sDr.map((dr) => ({ relay: dr.relay, drawerId: dr.drawerId })));
  check('⑤ 복원: word 는 지난 주자 1·현재 주자 2 에게만', sDr[0].word === sw && sDr[1].word === sw && sDr[2].word === undefined && sDr[3].word === undefined, sDr.map((dr) => dr.word));
  check('⑤ 복원: 차례 전 주자 3 은 힌트 반영 마스크, 맞히는 사람 4 는 맞힌 요소까지 같은 마스크', sDr[2].wordMask === sh3.wordMask && sDr[3].wordMask === sh4.wordMask
    && sDr[3].wordMask.split(PART_SEP)[sfi] === Array.from(sp[sfi]).join(' '), { m3: sDr[2].wordMask, h3: sh3.wordMask, m4: sDr[3].wordMask, h4: sh4.wordMask });
  check('⑤ 복원: draw:sync 에 두 주자의 획(ops 2)', sSy.every((sy) => sy.ops.length === 2 && sy.ops[1].color === '#0000ff'), sSy.map((sy) => sy.ops.length));
  const sTl = sDr[3].timeLeft;
  check('⑤ 복원: 시간 불변식 timeLeft = legTimeLeft + 15 × 1, 다운타임은 빼지 않음(±2)', legInvariant(sTl, sDr[3].relay) && sBefore && sTl <= sBefore.timeLeft + 2 && sTl >= sBefore.timeLeft - 2,
    { sTl, relay: sDr[3].relay, before: sBefore });
  const sTk = await waitNext(sb[3], 'game:timer', undefined, 3000, 'SB tick');
  check('⑤ 복원 뒤 타이머가 흐르고 legTimeLeft 도 같이', typeof sTk.legTimeLeft === 'number' && sTk.timeLeft === sTk.legTimeLeft + 15, sTk);
  const sRel = waitNext(sb[3], 'draw:start', undefined, 3000, 'SB relay draw');
  sb[1].emit('draw:start', { tool: 'pen', color: '#ff0000', size: 5, x: 600, y: 100 });
  sb[1].emit('draw:end');
  await sRel;
  check('⑤ 복원 뒤 현재 주자 2 의 그림이 중계된다', true);
  const sTl2 = sTk.timeLeft;
  const sTeP = waitNext(sb[0], 'game:turnEnd', undefined, 5000, 'SB turnEnd');
  sb[3].emit('chat:message', { text: sp.filter((_, i) => i !== sfi).join(' 그리고 ') });
  const sTe = await sTeP;
  const sdd = Object.fromEntries(sTe.deltas.map((q) => [q.id, q.delta]));
  const f75s = (t) => Math.max(50, Math.round((100 + 300 * t / 45) * 0.75));
  check('⑤ 복원 뒤 나머지 요소로 정답: allGuessed, 주자 1·2 200, 3 0, 맞히는 사람 = 힌트 1회 ×0.75', sTe.reason === 'allGuessed' && sdd[S[0]] === 200 && sdd[S[1]] === 200 && sdd[S[2]] === 0
    && [sTl2 - 2, sTl2 - 1, sTl2, sTl2 + 1].some((t) => sdd[S[3]] === f75s(t)), { sdd, sTl2 });
  for (const cl of sb) cl.emit('room:leave');
  await sleep(500);
  await stopServer(sproc);

  cleanup(failures ? 1 : 0);
})().catch((e) => {
  console.log('FAIL - exception', e && e.stack ? e.stack : e);
  failures += 1;
  cleanup(1);
});
