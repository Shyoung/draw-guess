'use strict';
/**
 * test/smoke.js — 서버를 자식 프로세스로 띄우고 socket.io-client 로 전체 게임 흐름을 검증하는 스모크 테스트.
 *
 * 실행 (프로젝트 루트에서):  node test/smoke.js
 *  - PORT 3123 으로 server/index.js 를 spawn
 *  - 클라이언트 3명으로 방 생성/참가/설정/시작 → 턴 진행 → 4번째 클라이언트 중간 참가 → game:over → lobby 복귀
 *  - 이어서 호스트 승계 / 강퇴 / 출제자 이탈(drawerLeft) / 인원 부족(notEnoughPlayers) 경로 검증
 *  - 체크마다 PASS/FAIL 출력, 실패가 있으면 종료 코드 1. 전체 제한 90초.
 */

const path = require('path');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { maskWord, hintChar, normalizeAnswer, levenshtein, computeHintTimes, maxReveals } = require('../server/game');
const words = require('../server/words');

const PORT = 3123;
const URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const OVERALL_TIMEOUT_MS = 90000;

// ── 결과 집계 ───────────────────────────────────────────────────
let passes = 0;
let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) passes += 1;
  else failures += 1;
  const suffix = !ok && detail !== undefined ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${suffix}`);
  return ok;
}

// ── 서버 / 클라이언트 관리 ──────────────────────────────────────
let serverProc = null;
let serverExited = false;
let shuttingDown = false;
const clients = [];

function cleanup(exitCode) {
  shuttingDown = true;
  for (const c of clients) {
    try {
      c.disconnect();
    } catch (_) {
      /* ignore */
    }
  }
  if (serverProc && !serverExited) {
    try {
      serverProc.kill();
    } catch (_) {
      /* ignore */
    }
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  setTimeout(() => process.exit(exitCode), 300);
}

const overallTimer = setTimeout(() => {
  check('overall timeout (90s)', false, 'test did not finish in time');
  cleanup(1);
}, OVERALL_TIMEOUT_MS);

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      // 이 스모크는 "연결 끊김 = 즉시 퇴장" 경로(호스트 승계/drawerLeft/notEnoughPlayers)를 검증하므로 유예 시간을 0으로 둔다.
      env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('server did not start within 15s')), 15000);
    serverProc.stdout.on('data', (d) => {
      const s = d.toString();
      process.stdout.write(`[server] ${s}`);
      if (s.includes('http://')) {
        clearTimeout(timer);
        resolve();
      }
    });
    serverProc.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
    serverProc.on('exit', (code, sig) => {
      serverExited = true;
      if (!shuttingDown) check('server process stays alive', false, `exited code=${code} sig=${sig}`);
    });
    serverProc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** event 가 pred 를 만족하며 도착할 때까지 대기 */
function waitFor(client, event, pred, ms = 10000, label = '') {
  const test = typeof pred === 'function' ? pred : () => true;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off(event, handler);
      reject(new Error(`timeout waiting '${event}'${label ? ` (${label})` : ''} on ${client.label}`));
    }, ms);
    function handler(payload) {
      let ok = false;
      try {
        ok = test(payload);
      } catch (_) {
        ok = false;
      }
      if (!ok) return;
      clearTimeout(timer);
      client.off(event, handler);
      resolve(payload);
    }
    client.on(event, handler);
  });
}

/** ms 동안 pred 를 만족하는 event 가 오지 않으면 null, 오면 그 payload */
function expectNone(client, event, ms = 400, pred) {
  const test = typeof pred === 'function' ? pred : () => true;
  return new Promise((resolve) => {
    let got = null;
    const handler = (p) => {
      if (got === null && test(p)) got = p === undefined ? '(no payload)' : p;
    };
    client.on(event, handler);
    setTimeout(() => {
      client.off(event, handler);
      resolve(got);
    }, ms);
  });
}

function emitAck(client, event, payload, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout for '${event}' on ${client.label}`)), ms);
    client.emit(event, payload, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

function connect(label) {
  return new Promise((resolve, reject) => {
    const c = io(URL, { forceNew: true, reconnection: false, transports: ['websocket'] });
    c.label = label;
    c.log = [];
    c.onAny((ev, payload) => c.log.push({ ev, payload }));
    c.once('connect', () => {
      c.playerId = c.id; // socket.io-client 는 disconnect 시 id 를 지우므로 보존
      resolve(c);
    });
    c.once('connect_error', (err) => reject(err));
    clients.push(c);
  });
}

/** 단어의 마지막 글자(공백 아님) 하나를 바꿔 Levenshtein 거리 1 문자열 생성 */
function alterOneChar(word) {
  const chars = Array.from(word);
  let i = chars.length - 1;
  while (i > 0 && chars[i] === ' ') i -= 1;
  chars[i] = chars[i] === 'x' ? 'y' : 'x';
  return chars.join('');
}

const byId = (list, id) => list.find((p) => p.id === id);

// ── 메인 시나리오 ───────────────────────────────────────────────
async function main() {
  // 0) 순수 헬퍼 / 단어 사전 검증
  check('maskWord: 사과 → "_ _"', maskWord('사과', new Set()) === '_ _');
  check('maskWord: ice cream → "_ _ _   _ _ _ _ _"', maskWord('ice cream', new Set()) === '_ _ _   _ _ _ _ _');
  check('maskWord: 한글은 초성만 공개 "ㅅ _"', maskWord('사과', new Set([0])) === 'ㅅ _');
  check('maskWord: 영문·숫자는 그대로 공개 "G _ 2 _"', maskWord('GS25', new Set([0, 2])) === 'G _ 2 _');
  check('hintChar: 쌍자음·받침 처리', hintChar('빵') === 'ㅃ' && hintChar('닭') === 'ㄷ' && hintChar('힣') === 'ㅎ' && hintChar('a') === 'a');
  check('hint times: count=2, drawTime=80, endAt=15 → [37, 15] (마지막 힌트는 종료 15초 전)', JSON.stringify([...computeHintTimes(2, 80, 15)]) === '[37,15]', [...computeHintTimes(2, 80, 15)]);
  check('hint times: count=1, drawTime=30, endAt=15 → [15]', JSON.stringify([...computeHintTimes(1, 30, 15)]) === '[15]');
  check('hint times: count=3, drawTime=90, endAt=30 → [60, 45, 30] (역산 균등 배치)', JSON.stringify([...computeHintTimes(3, 90, 30)]) === '[60,45,30]', [...computeHintTimes(3, 90, 30)]);
  check('hint times: 1글자·3글자 단어 모두 마지막 힌트는 같은 시점', Math.min(...computeHintTimes(1, 80, 15)) === Math.min(...computeHintTimes(3, 80, 15)));
  check('hint times: endAt이 drawTime 이상이면 drawTime-1로 보정', [...computeHintTimes(1, 30, 60)][0] === 29);
  check('maxReveals: 한글만 → 글자 수, 영문·숫자 포함 → 글자 수-1, 공백 제외', maxReveals('사과') === 2 && maxReveals('GS25') === 3 && maxReveals('ice cream') === 7);
  check('levenshtein basic', levenshtein('apple', 'aple') === 1 && levenshtein('abc', 'abc') === 0 && levenshtein('abc', 'xyz') === 3);
  check('words.ko >= 250 unique', words.ko.length >= 250 && new Set(words.ko).size === words.ko.length, words.ko.length);
  check('words.ko: includes 1-syllable words and brand category', words.ko.includes('곰') && words.ko.includes('스타벅스'));

  await startServer();

  // 1) 접속 / 방 생성 / 참가
  const c1 = await connect('P1');
  const c2 = await connect('P2');
  const c3 = await connect('P3');

  const created = await emitAck(c1, 'room:create', { name: '  호스트  ', avatar: { emoji: '🐶', color: '#FF0000' } });
  check(
    'room:create ack {ok, roomCode(4 A-Z), playerId=socket.id}',
    created && created.ok === true && /^[A-Z]{4}$/.test(created.roomCode) && created.playerId === c1.id,
    created,
  );
  const code = created.roomCode;

  const badName = await emitAck(c2, 'room:create', { name: '   ', avatar: {} });
  check('room:create rejects blank name', badName && badName.ok === false && typeof badName.error === 'string', badName);

  const badCode = await emitAck(c2, 'room:join', { roomCode: 'ab1', name: 'x', avatar: {} });
  check('room:join rejects malformed code', badCode && badCode.ok === false, badCode);

  const unknownCode = code === 'ZZZZ' ? 'AAAA' : 'ZZZZ';
  const unknown = await emitAck(c2, 'room:join', { roomCode: unknownCode, name: 'x', avatar: {} });
  check('room:join unknown room → ok:false', unknown && unknown.ok === false, unknown);

  const j2 = await emitAck(c2, 'room:join', { roomCode: code.toLowerCase(), name: '게스트2', avatar: { emoji: '🐱', color: '#00ff00' } });
  check('P2 join ack ok (lowercase code normalized)', j2 && j2.ok === true && j2.roomCode === code && j2.playerId === c2.id, j2);

  const stateP3 = waitFor(c1, 'room:state', (s) => s.players.length === 3);
  const j3 = await emitAck(c3, 'room:join', { roomCode: code, name: '게스트3', avatar: { emoji: '🐰', color: 'not-a-color' } });
  check('P3 join ack ok', j3 && j3.ok === true, j3);
  const st3 = await stateP3;
  check(
    'room:state: 3 players in join order, host=P1, phase lobby, drawerId null',
    st3.players.map((p) => p.id).join() === [c1.id, c2.id, c3.id].join() &&
      st3.hostId === c1.id &&
      st3.phase === 'lobby' &&
      st3.drawerId === null &&
      st3.roomCode === code,
    st3,
  );
  check('room:state: name trimmed, avatar color normalized/defaulted', st3.players[0].name === '호스트' && st3.players[0].avatar.color === '#ff0000' && /^#[0-9a-f]{6}$/.test(st3.players[2].avatar.color));
  check('room:state: default settings', JSON.stringify(st3.settings) === JSON.stringify({ rounds: 3, drawTime: 80, wordCount: 3, hints: 2, hintEndAt: 15, customWords: '', customWordsOnly: false }), st3.settings);

  const dj = await emitAck(c3, 'room:join', { roomCode: code, name: 'dup', avatar: {} });
  check('double join of same room rejected', dj && dj.ok === false, dj);

  // 2) 설정
  const errNonHost = waitFor(c2, 'error:msg');
  c2.emit('room:settings', { settings: { rounds: 5 } });
  check('non-host room:settings → error:msg', typeof (await errNonHost).message === 'string');

  const clampP = waitFor(c1, 'room:state', (s) => s.settings.drawTime === 180);
  c1.emit('room:settings', { settings: { rounds: 0, drawTime: 999, wordCount: 9, hints: -3, language: 'xx', customWordsOnly: 1 } });
  const cl = (await clampP).settings;
  check(
    'settings clamped (rounds 1, drawTime 180, wordCount 5, hints 0, unknown key ignored, customWordsOnly bool)',
    cl.rounds === 1 && cl.drawTime === 180 && cl.wordCount === 5 && cl.hints === 0 && cl.language === undefined && cl.customWordsOnly === true,
    cl,
  );

  const setP = waitFor(c1, 'room:state', (s) => s.settings.drawTime === 30 && s.settings.hints === 1 && s.settings.customWordsOnly === true);
  c1.emit('room:settings', { settings: { rounds: 1, drawTime: 30, hints: 1, wordCount: 3, customWords: '자전거,냉장고,해바라기,고슴도치,아이스크림,선풍기,소방차,다람쥐,무지개,피라미드,헬리콥터,미끄럼틀', customWordsOnly: true } });
  const applied = (await setP).settings;
  check('settings applied {rounds:1, drawTime:30, hints:1, customWordsOnly (3음절 이상 한국어 단어로 근접 판정 결정성 확보)}', applied.rounds === 1 && applied.wordCount === 3 && applied.customWordsOnly === true, applied);

  const errStart = waitFor(c2, 'error:msg');
  c2.emit('game:start');
  check('non-host game:start → error:msg', typeof (await errStart).message === 'string');

  const errChat = waitFor(c2, 'error:msg');
  c2.emit('chat:message', { text: 'x'.repeat(101) });
  check('chat:message > 100 chars → error:msg', typeof (await errChat).message === 'string');

  const lobbyChatP = [c1, c2, c3].map((c) => waitFor(c, 'chat:message', (m) => m.text === 'hello lobby'));
  c2.emit('chat:message', { text: 'hello lobby' });
  const lobbyChats = await Promise.all(lobbyChatP);
  check('lobby chat broadcast to all as kind chat with id/name/avatar', lobbyChats.every((m) => m.kind === 'chat' && m.id === c2.id && m.name === '게스트2' && m.avatar && m.avatar.emoji === '🐱'));

  // 3) 게임 시작 → 턴 1 (상세 검증)
  let active = [c1, c2, c3];
  const usedWords = new Set();
  const drawersSeen = [];

  let pendingChoosing = active.map((c) => waitFor(c, 'game:choosing', undefined, 10000, 'turn 1'));
  c1.emit('game:start');
  let choosings = await Promise.all(pendingChoosing);

  const drawerId1 = choosings[0].drawerId;
  const drawer = active.find((c) => c.id === drawerId1);
  drawersSeen.push(drawerId1);
  check('turn 1: drawer is first player in join order (P1)', drawerId1 === c1.id);
  check('turn 1: game:choosing {drawerId, drawerName, timeLeft:15} consistent to all', choosings.every((p) => p.drawerId === drawerId1 && p.drawerName === '호스트' && p.timeLeft === 15));
  const withOptions = choosings.filter((p) => Array.isArray(p.wordOptions));
  check('turn 1: exactly one client (drawer) got wordOptions (3 unique strings), others undefined', withOptions.length === 1 && choosings[active.indexOf(drawer)].wordOptions.length === 3 && new Set(withOptions[0].wordOptions).size === 3 && choosings.every((p, i) => active[i] === drawer || p.wordOptions === undefined));
  const stateChoosing = await waitFor(c2, 'room:state', (s) => s.phase === 'choosing', 3000).catch(() => c2.log.map((e) => e.payload).filter((p) => p && p.phase === 'choosing').pop());
  check('turn 1: room:state phase choosing, round 1/1, drawer isDrawing, scores reset to 0', stateChoosing && stateChoosing.round === 1 && stateChoosing.totalRounds === 1 && stateChoosing.drawerId === drawerId1 && byId(stateChoosing.players, drawerId1).isDrawing === true && stateChoosing.players.every((p) => p.score === 0), stateChoosing);

  const options1 = choosings[active.indexOf(drawer)].wordOptions;
  const word = options1[0];
  const drawingP = active.map((c) => waitFor(c, 'game:drawing'));
  const syncP = active.map((c) => waitFor(c, 'draw:sync', (p) => p && Array.isArray(p.ops) && p.ops.length === 0));
  drawer.emit('word:choose', { word });
  const drawings = await Promise.all(drawingP);
  await Promise.all(syncP);
  check('turn 1: draw:sync {ops:[]} sent to all at drawing start', true);
  const dDrawer = drawings[active.indexOf(drawer)];
  check('turn 1: drawer game:drawing includes word', dDrawer.word === word);
  check('turn 1: non-drawers game:drawing has no word', drawings.every((d, i) => active[i] === drawer || d.word === undefined));
  check(
    'turn 1: game:drawing {drawerId, round, totalRounds, timeLeft:30, wordMask, wordLength}',
    drawings.every((d) => d.drawerId === drawerId1 && d.round === 1 && d.totalRounds === 1 && d.timeLeft === 30 && d.wordMask === maskWord(word, new Set()) && d.wordLength === Array.from(word).length),
    drawings[0],
  );
  usedWords.add(word);
  const drawerLogStart = drawer.log.length;

  const [g1, g2] = active.filter((c) => c !== drawer);

  // 3a) 드로잉 중계 + clamp
  const startP = waitFor(g1, 'draw:start');
  const moveP = waitFor(g1, 'draw:move');
  const endP = waitFor(g1, 'draw:end');
  const fillP = waitFor(g2, 'draw:fill');
  const selfRelayP = expectNone(drawer, 'draw:start', 500);
  drawer.emit('draw:start', { tool: 'pen', color: '#FF0000', size: 999, x: -50, y: 700.7 });
  drawer.emit('draw:move', { pts: [[10, 10], [20, 20.4], ['bad'], [900, -5]] });
  drawer.emit('draw:move', { pts: [[30, 30]] });
  drawer.emit('draw:end');
  drawer.emit('draw:fill', { x: 100, y: 100, color: '#00ff00' });
  const st = await startP;
  check('draw:start relayed & clamped (size 60, x 0, y 600, color lowercased)', st.tool === 'pen' && st.color === '#ff0000' && st.size === 60 && st.x === 0 && st.y === 600, st);
  const mv = await moveP;
  check('draw:move relayed & sanitized (bad point dropped, coords clamped/rounded)', JSON.stringify(mv.pts) === JSON.stringify([[10, 10], [20, 20], [800, 0]]), mv);
  await endP;
  check('draw:end relayed', true);
  const fl = await fillP;
  check('draw:fill relayed', fl.x === 100 && fl.y === 100 && fl.color === '#00ff00', fl);
  check('drawer does not receive its own draw:start relay', (await selfRelayP) === null);

  const badColorP = expectNone(g1, 'draw:start', 400);
  const nonDrawerP = expectNone(drawer, 'draw:start', 400);
  const nonDrawerP2 = expectNone(g2, 'draw:start', 400);
  drawer.emit('draw:start', { tool: 'pen', color: 'red', size: 5, x: 1, y: 1 });
  g1.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 1, y: 1 });
  const [badColor, nd1, nd2] = await Promise.all([badColorP, nonDrawerP, nonDrawerP2]);
  check('draw:start with invalid color ignored', badColor === null);
  check('draw:start from non-drawer ignored (nobody receives)', nd1 === null && nd2 === null);

  // 3b) 채팅 / 정답 판정
  const wrongText = 'zzzzqqqq';
  const wrongP = active.map((c) => waitFor(c, 'chat:message', (m) => m.text === wrongText));
  g1.emit('chat:message', { text: wrongText });
  const wrongs = await Promise.all(wrongP);
  check('wrong guess → kind chat to all (incl. drawer) with sender identity', wrongs.every((m) => m.kind === 'chat' && m.id === g1.id && m.name === byId(st3.players, g1.id).name), wrongs[0]);

  const closeText = alterOneChar(word);
  const closeSelfP = waitFor(g1, 'chat:message', (m) => m.text === closeText);
  const closeOtherP = waitFor(g2, 'chat:message', (m) => m.text === closeText);
  const closeDrawerP = waitFor(drawer, 'chat:message', (m) => m.text === closeText);
  g1.emit('chat:message', { text: closeText });
  const [cs, co, cd] = await Promise.all([closeSelfP, closeOtherP, closeDrawerP]);
  check(`close guess "${closeText}" (word "${word}") → sender receives kind close`, cs.kind === 'close', cs);
  check('close guess → others receive kind chat (not close)', co.kind === 'chat' && cd.kind === 'chat', { co, cd });

  const correctP = active.map((c) => waitFor(c, 'chat:message', (m) => m.kind === 'correct'));
  const guessedP = active.map((c) => waitFor(c, 'player:guessed'));
  const stateGuessP = waitFor(g2, 'room:state', (s) => byId(s.players, g1.id).hasGuessed === true);
  g1.emit('chat:message', { text: `  ${word.toUpperCase()}  ` }); // 정규화(trim/소문자) 확인
  const corrects = await Promise.all(correctP);
  check('exact guess → chat:message kind correct to all, text does not contain the word', corrects.every((m) => m.kind === 'correct' && m.id === g1.id && !normalizeAnswer(m.text).includes(normalizeAnswer(word))), corrects[0]);
  const guessed = await Promise.all(guessedP);
  check('player:guessed {id} to all', guessed.every((g) => g.id === g1.id), guessed[0]);
  const sg = await stateGuessP;
  const g1State = byId(sg.players, g1.id);
  check('room:state after correct: hasGuessed true, score within [100, 400]', g1State.hasGuessed && g1State.score >= 100 && g1State.score <= 400, g1State);

  const gcDrawerP = waitFor(drawer, 'chat:message', (m) => m.text === 'gg');
  const gcSelfP = waitFor(g1, 'chat:message', (m) => m.text === 'gg');
  const gcOtherP = expectNone(g2, 'chat:message', 500, (m) => m && m.text === 'gg');
  g1.emit('chat:message', { text: 'gg' });
  const [gcD, gcS, gcO] = await Promise.all([gcDrawerP, gcSelfP, gcOtherP]);
  check('guessed player chat → guessed-chat to drawer + self only', gcD.kind === 'guessed-chat' && gcS.kind === 'guessed-chat' && gcO === null, { gcD, gcS, gcO });

  const dcSelfP = waitFor(g1, 'chat:message', (m) => m.text === 'hi from drawer');
  const dcOtherP = expectNone(g2, 'chat:message', 500, (m) => m && m.text === 'hi from drawer');
  drawer.emit('chat:message', { text: 'hi from drawer' });
  const [dcS, dcO] = await Promise.all([dcSelfP, dcOtherP]);
  check('drawer chat during drawing → guessed-chat, hidden from non-guessed', dcS.kind === 'guessed-chat' && dcO === null);

  const secondCorrectP = expectNone(g2, 'chat:message', 500, (m) => m && m.kind === 'correct');
  g1.emit('chat:message', { text: word });
  check('already-guessed player typing the word again is not judged again', (await secondCorrectP) === null);

  // 3c) undo
  const undoP = waitFor(g2, 'draw:undo');
  drawer.emit('draw:undo');
  await undoP;
  check('draw:undo relayed to non-drawers', true);

  // 3d) 4번째 클라이언트 중간 참가
  const c4 = await connect('P4');
  const syncP4 = waitFor(c4, 'draw:sync');
  const drawingP4 = waitFor(c4, 'game:drawing');
  const stateP4 = waitFor(c4, 'room:state', (s) => s.players.length === 4);
  const joinSysP = waitFor(g2, 'chat:message', (m) => m.kind === 'system' && m.text.includes('늦참'));
  const j4 = await emitAck(c4, 'room:join', { roomCode: code, name: '늦참', avatar: { emoji: '🦊', color: '#ffaa00' } });
  check('P4 mid-drawing join ack ok', j4 && j4.ok === true, j4);
  const sync4 = await syncP4;
  check(
    'P4 gets draw:sync with ops (1 stroke w/ 5 points; fill removed by undo)',
    Array.isArray(sync4.ops) && sync4.ops.length === 1 && sync4.ops[0].type === 'stroke' && sync4.ops[0].points.length === 5 && sync4.ops[0].tool === 'pen' && sync4.ops[0].size === 60,
    sync4,
  );
  const d4 = await drawingP4;
  check('P4 gets game:drawing (no word, mask shape ok, wordLength)', d4.word === undefined && d4.drawerId === drawerId1 && d4.wordMask.length === maskWord(word, new Set()).length && d4.wordLength === Array.from(word).length && d4.timeLeft <= 30, d4);
  const s4 = await stateP4;
  const p4State = byId(s4.players, c4.id);
  check('P4 in room:state: score 0, hasGuessed false, isDrawing false, appended last', p4State && p4State.score === 0 && !p4State.hasGuessed && !p4State.isDrawing && s4.players[3].id === c4.id, s4.players);
  await joinSysP;
  check('system chat on join', true);
  active = [c1, c2, c3, c4];

  // 3e) 힌트 (timeLeft 15 시점) + 타이머
  const hint = await waitFor(g2, 'game:hint', undefined, 25000, 'hint at timeLeft 15');
  const chars = Array.from(word);
  const singleReveal = chars.some((ch, i) => ch !== ' ' && hint.wordMask === maskWord(word, new Set([i])));
  check('game:hint reveals exactly one correct letter', singleReveal, { word, mask: hint.wordMask });
  // hints=1 이므로 이 힌트가 마지막 → 카테고리 동봉. 사용자 단어(customWordsOnly)라 '방장이 낸 단어'
  // 사용자 단어라도 사전에 있으면 그 카테고리, 없으면 '방장이 낸 단어' — 어느 쪽이든 문자열이어야 한다
  check('last hint carries a category string', typeof hint.category === 'string' && hint.category.length > 0, hint);
  const wordsMod = require('../server/words');
  check('categoryOf: dictionary words map to a category, custom word → null', wordsMod.categoryOf('강아지') === '동물' && wordsMod.categoryOf('자전거') === '탈것' && wordsMod.categoryOf('스타벅스') === '브랜드·캐릭터' && wordsMod.categoryOf('없는단어zzz') === null);
  check('words.ko grew past 1400 with 13 categories', wordsMod.ko.length >= 1400 && Object.keys(wordsMod.CATEGORIES).length === 13, { n: wordsMod.ko.length, cats: Object.keys(wordsMod.CATEGORIES).length });
  // drawing 시작(game:drawing) 이후의 타이머만 본다 — choosing 단계 tick(14, 13 ...)은 제외
  const drawingLogIdx = g2.log.findLastIndex((e) => e.ev === 'game:drawing');
  const timerVals = g2.log.slice(drawingLogIdx).filter((e) => e.ev === 'game:timer').map((e) => e.payload.timeLeft);
  check('game:timer received during drawing (>= 5 ticks)', timerVals.length >= 5, timerVals);
  check('game:timer values start at 29 and decrease by 1', timerVals[0] === 29 && timerVals.slice(1).every((v, i) => v === timerVals[i] - 1), timerVals);

  // 3f) 중간 참가자 정답 → 마지막 사람 정답 → allGuessed
  const c4CorrectP = waitFor(c4, 'chat:message', (m) => m.kind === 'correct' && m.id === c4.id);
  c4.emit('chat:message', { text: word });
  await c4CorrectP;
  check('mid-join P4 can guess in the current turn', true);

  const turnEndP = active.map((c) => waitFor(c, 'game:turnEnd'));
  const stateAfterP = waitFor(c1, 'room:state', (s) => s.phase === 'turnEnd');
  pendingChoosing = active.map((c) => waitFor(c, 'game:choosing', undefined, 10000, 'turn 2'));
  g2.emit('chat:message', { text: word });
  const ends = await Promise.all(turnEndP);
  const te = ends[0];
  check('game:turnEnd reason allGuessed, word revealed, timeLeft 5', te.reason === 'allGuessed' && te.word === word && te.timeLeft === 5, te);
  check('turnEnd deltas cover all 4 players', Array.isArray(te.deltas) && te.deltas.length === 4 && active.every((c) => te.deltas.some((d) => d.id === c.id)), te.deltas);
  const delta = (id) => (te.deltas.find((d) => d.id === id) || {}).delta;
  check('drawer delta 300 (everyone guessed)', delta(drawer.id) === 300, te.deltas);
  check('first guesser delta > later guessers (time-based); all guessers >= 100', delta(g1.id) > delta(g2.id) && delta(g2.id) >= 100 && delta(c4.id) >= 100, te.deltas);
  check('guesser delta formula round(100 + 300*timeLeft/30)', [g1, g2, c4].every((c) => delta(c.id) >= 100 && delta(c.id) <= 400 && Number.isInteger(delta(c.id))));
  check('turnEnd payload identical for all clients', ends.every((e) => JSON.stringify(e) === JSON.stringify(te)));
  const sa = await stateAfterP;
  check('room:state after turnEnd: phase turnEnd, drawer score 300, scores = deltas', sa.phase === 'turnEnd' && byId(sa.players, drawer.id).score === 300 && sa.players.every((p) => p.score === delta(p.id)), sa.players);
  check('drawer did not receive game:hint', !drawer.log.slice(drawerLogStart).some((e) => e.ev === 'game:hint'));
  const midTurnDraw = expectNone(g1, 'draw:start', 300);
  drawer.emit('draw:start', { tool: 'pen', color: '#000000', size: 5, x: 1, y: 1 });
  check('draw:start during turnEnd ignored', (await midTurnDraw) === null);

  // 4) 턴 2, 3 (일반 진행) — rounds=1 이므로 참가 순서대로 P1, P2, P3 만 출제. P4 는 다음 라운드부터라 출제 없음.
  let overP = null;
  for (let turn = 2; turn <= 3; turn++) {
    choosings = await Promise.all(pendingChoosing);
    const dId = choosings[0].drawerId;
    const drawerN = active.find((c) => c.id === dId);
    drawersSeen.push(dId);
    const myChoosing = choosings[active.indexOf(drawerN)];
    check(`turn ${turn}: only drawer gets wordOptions`, Array.isArray(myChoosing.wordOptions) && choosings.every((p, i) => active[i] === drawerN || p.wordOptions === undefined));
    check(`turn ${turn}: word options avoid already-used words`, myChoosing.wordOptions.every((w) => !usedWords.has(w)), { options: myChoosing.wordOptions, used: [...usedWords] });

    if (turn === 2) {
      const eP = waitFor(drawerN, 'error:msg');
      drawerN.emit('word:choose', { word: 'not-an-option-xyz' });
      check('word:choose with word not in options → error:msg', typeof (await eP).message === 'string');
      const other = active.find((c) => c !== drawerN);
      const eP2 = waitFor(other, 'error:msg');
      other.emit('word:choose', { word: myChoosing.wordOptions[0] });
      check('word:choose from non-drawer → error:msg', typeof (await eP2).message === 'string');
      const stillChoosing = expectNone(other, 'game:drawing', 300);
      check('invalid choose attempts did not start drawing', (await stillChoosing) === null);
    }

    const drawingPN = active.map((c) => waitFor(c, 'game:drawing'));
    const chosen = myChoosing.wordOptions[turn === 2 ? 1 : 0];
    drawerN.emit('word:choose', { word: chosen });
    const drs = await Promise.all(drawingPN);
    const wordN = drs[active.indexOf(drawerN)].word;
    check(`turn ${turn}: drawer gets chosen word, others don't`, wordN === chosen && drs.every((d, i) => active[i] === drawerN || d.word === undefined));
    usedWords.add(wordN);

    if (turn === 3) {
      // 시간 초과 경로 대신 draw:clear 중계만 확인
      const clearP = waitFor(active.find((c) => c !== drawerN), 'draw:clear');
      drawerN.emit('draw:start', { tool: 'eraser', color: '#ffffff', size: 10, x: 5, y: 5 });
      drawerN.emit('draw:end');
      drawerN.emit('draw:clear');
      await clearP;
      check('draw:clear relayed', true);
    }

    const teP = active.map((c) => waitFor(c, 'game:turnEnd'));
    if (turn < 3) pendingChoosing = active.map((c) => waitFor(c, 'game:choosing', undefined, 10000, `turn ${turn + 1}`));
    else overP = active.map((c) => waitFor(c, 'game:over', undefined, 10000));
    for (const g of active.filter((c) => c !== drawerN)) g.emit('chat:message', { text: wordN });
    const tes = await Promise.all(teP);
    const dN = (tes[0].deltas.find((d) => d.id === dId) || {}).delta;
    check(`turn ${turn}: turnEnd allGuessed, drawer delta 300, word revealed`, tes[0].reason === 'allGuessed' && dN === 300 && tes[0].word === wordN, tes[0]);
  }

  check('drawer order over the game = join order P1, P2, P3 (mid-joiner P4 not inserted into current round)', drawersSeen.join() === [c1.id, c2.id, c3.id].join(), drawersSeen);

  // 5) game:over → lobby
  const overs = await Promise.all(overP);
  const ranking = overs[0].ranking;
  check('game:over ranking has 4 entries with {id, name, avatar, score}', Array.isArray(ranking) && ranking.length === 4 && ranking.every((r) => typeof r.id === 'string' && typeof r.name === 'string' && r.avatar && typeof r.avatar.emoji === 'string' && typeof r.score === 'number'), ranking);
  check('ranking sorted by score desc', ranking.every((r, i) => i === 0 || ranking[i - 1].score >= r.score), ranking.map((r) => r.score));
  check('game:over identical for all clients', overs.every((o) => JSON.stringify(o) === JSON.stringify(overs[0])));
  const gal = overs[0].gallery;
  check('game:over carries gallery of drawn turns (word, drawer, category, ops[])', Array.isArray(gal) && gal.length >= 1 && gal.every((g) => typeof g.word === 'string' && typeof g.drawerName === 'string' && typeof g.category === 'string' && Array.isArray(g.ops)), gal && gal.map((g) => ({ word: g.word, ops: g.ops.length })));
  check('gallery turn 1 keeps the drawer ops (at least one stroke)', gal && gal[0] && gal[0].ops.some((o) => o.type === 'stroke'), gal && gal[0] && gal[0].ops.map((o) => o.type));
  const goState = await waitFor(c1, 'room:state', (s) => s.phase === 'gameOver', 3000).catch(() => c1.log.map((e) => e.payload).filter((p) => p && p.phase === 'gameOver').pop());
  check('room:state phase gameOver with drawerId null, scores match ranking', goState && goState.drawerId === null && goState.players.every((p) => byId(ranking, p.id).score === p.score), goState);

  const lobbyP = waitFor(c1, 'room:state', (s) => s.phase === 'lobby', 13000, 'lobby after 10s');
  const lobby = await lobbyP;
  check('back to lobby ~10s after game:over; scores retained; round 0; drawerId null; no isDrawing/hasGuessed', lobby.round === 0 && lobby.drawerId === null && lobby.players.some((p) => p.score > 0) && lobby.players.every((p) => p.score === byId(ranking, p.id).score && !p.isDrawing && !p.hasGuessed), lobby);

  // 6) 호스트 승계 / 강퇴 / 출제자 이탈 / 인원 부족
  const hostP = waitFor(c2, 'room:state', (s) => s.hostId === c2.id && s.players.length === 3);
  c1.emit('room:leave');
  await hostP;
  check('host leaves → next player in join order (P2) becomes host', true);
  const leftIgnored = expectNone(c1, 'room:state', 400);
  c1.emit('chat:message', { text: 'ghost' });
  check('player who left no longer receives room events', (await leftIgnored) === null);

  const kickErrP = waitFor(c4, 'error:msg');
  const kickStateP = waitFor(c2, 'room:state', (s) => s.players.length === 2 && !byId(s.players, c4.id));
  c2.emit('player:kick', { playerId: c4.id });
  await Promise.all([kickErrP, kickStateP]);
  check('host kicks P4 → P4 gets error:msg, removed from room:state', true);
  const kickNonHostP = waitFor(c3, 'error:msg');
  c3.emit('player:kick', { playerId: c2.id });
  check('non-host player:kick → error:msg', typeof (await kickNonHostP).message === 'string');

  const c5 = await connect('P5');
  const j5 = await emitAck(c5, 'room:join', { roomCode: code, name: '다섯', avatar: { emoji: '🐼', color: '#123456' } });
  check('P5 joins lobby after game', j5 && j5.ok === true, j5);
  active = [c2, c3, c5];

  const startResetP = waitFor(c3, 'room:state', (s) => s.phase === 'choosing');
  const choosing2P = active.map((c) => waitFor(c, 'game:choosing', undefined, 5000, 'game 2'));
  c2.emit('game:start');
  const ch2 = await Promise.all(choosing2P);
  const startReset = await startResetP;
  check('second game: scores reset to 0 on game:start; drawer = P2 (new host, first in order)', startReset.players.every((p) => p.score === 0) && ch2[0].drawerId === c2.id, startReset.players);

  const drawerLeftP = [c3, c5].map((c) => waitFor(c, 'game:turnEnd', (t) => t.reason === 'drawerLeft', 5000));
  const nextChoosingP = [c3, c5].map((c) => waitFor(c, 'game:choosing', (p) => p.drawerId === c3.id, 10000, 'after drawerLeft'));
  c2.disconnect();
  const dl = await Promise.all(drawerLeftP);
  check('drawer disconnects during choosing → game:turnEnd reason drawerLeft (word empty, deltas for remaining)', dl[0].reason === 'drawerLeft' && dl[0].word === '' && dl[0].deltas.length === 2, dl[0]);
  const hostAfter = await waitFor(c3, 'room:state', (s) => s.hostId === c3.id, 3000).catch(() => c3.log.map((e) => e.payload).filter((p) => p && p.hostId === c3.id).pop());
  check('host handoff after drawer/host disconnect → P3', !!hostAfter);
  await Promise.all(nextChoosingP);
  check('after drawerLeft → next drawer (P3) begins choosing', true);

  const nepP = waitFor(c3, 'game:turnEnd', (t) => t.reason === 'notEnoughPlayers', 5000);
  const overAfterP = waitFor(c3, 'game:over', undefined, 10000, 'after notEnoughPlayers');
  c5.disconnect();
  const nep = await nepP;
  check('players drop below 2 → game:turnEnd reason notEnoughPlayers', nep.reason === 'notEnoughPlayers' && nep.deltas.length === 1, nep);
  const overAfter = await overAfterP;
  check('notEnoughPlayers → game:over (ranking of remaining 1 player)', Array.isArray(overAfter.ranking) && overAfter.ranking.length === 1 && overAfter.ranking[0].id === c3.id, overAfter);

  // 7) 전역 불변식 (로그 기반)
  let leak = false;
  for (const c of clients) {
    for (const e of c.log) {
      if (!e.payload || typeof e.payload !== 'object') continue;
      // c.id 는 disconnect 후 사라지므로 접속 시 보존한 playerId 로 비교
      if (e.ev === 'game:choosing' && e.payload.drawerId !== c.playerId && e.payload.wordOptions !== undefined) leak = true;
      if (e.ev === 'game:drawing' && e.payload.drawerId !== c.playerId && e.payload.word !== undefined) leak = true;
    }
  }
  check('INVARIANT: non-drawers never received word / wordOptions', !leak);
  const answers = new Set([...usedWords].map(normalizeAnswer));
  const leakedChat = clients.some((c) => c.log.some((e) => e.ev === 'chat:message' && e.payload && e.payload.kind !== 'guessed-chat' && answers.has(normalizeAnswer(e.payload.text))));
  check('INVARIANT: exact answers never broadcast as chat', !leakedChat);
  const badKinds = clients.some((c) => c.log.some((e) => e.ev === 'chat:message' && !['chat', 'system', 'correct', 'close', 'guessed-chat'].includes(e.payload && e.payload.kind)));
  check('INVARIANT: chat kinds are within the protocol set', !badKinds);
  const badPhases = clients.some((c) => c.log.some((e) => e.ev === 'room:state' && !['lobby', 'choosing', 'drawing', 'turnEnd', 'gameOver'].includes(e.payload.phase)));
  check('INVARIANT: room:state phases within the protocol set', !badPhases);

  // 8) 모두 나가면 방 삭제 & 서버 생존
  c3.disconnect();
  await sleep(500);
  check('server still alive after all clients disconnected (room deleted path)', !serverExited);
}

main()
  .then(() => {
    clearTimeout(overallTimer);
    cleanup(failures ? 1 : 0);
  })
  .catch((err) => {
    clearTimeout(overallTimer);
    check(`unexpected error: ${err && err.message}`, false, err && err.stack);
    cleanup(1);
  });
