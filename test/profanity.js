/**
 * 욕설 필터
 *  - 단위: maskProfanity / containsProfanity — 우회(기호·대문자) 잡기, 보통 말은 안 건드리기
 *  - 소켓: 닉네임 거절(create·join·player:update) · 채팅은 원문 text + 가린 판 textSafe(chat · guessed-chat, 보낸 사람 포함)
 *          · 정답·근접은 원문으로 판정 · 욕설 없으면 textSafe 없음 · 방 설정에 개인 설정 키 없음
 *  node test/profanity.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');
const { maskProfanity, containsProfanity } = require('../server/profanity');

const PORT = 3132;
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
setTimeout(() => { console.log('FAIL - overall timeout'); cleanup(2); }, 60000);

function startServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(PORT), RECONNECT_GRACE_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (d) => { if (String(d).includes('listening')) resolve(); });
    serverProc.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d));
    serverProc.on('exit', () => reject(new Error('server exited')));
  });
}
function connect() {
  const c = io(URL, { transports: ['websocket'], reconnection: false, forceNew: true });
  c.log = [];
  c.onAny((ev, payload) => c.log.push({ ev, payload }));
  clients.push(c);
  return new Promise((resolve, reject) => {
    c.once('connect', () => { c.playerId = c.id; resolve(c); });
    c.once('connect_error', reject);
  });
}
const emitAck = (c, ev, data) => new Promise((resolve) => c.emit(ev, data, resolve));
function waitNext(c, ev, pred, timeout = 6000, label = '') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.off(ev, h); reject(new Error(`timeout waiting ${ev} ${label}`)); }, timeout);
    const h = (p) => { if (!pred || pred(p)) { clearTimeout(timer); c.off(ev, h); resolve(p); } };
    c.on(ev, h);
  });
}
const chats = (c) => c.log.filter((x) => x.ev === 'chat:message').map((x) => x.payload);

(async () => {
  // ── 단위 ────────────────────────────────────────────────────
  const m = (t) => maskProfanity(t).text;
  check('가림: 한국어 욕 부분만 *', m('야 시발 뭐야') === '야 ** 뭐야');
  check('가림: 기호로 끊은 우회("씨.발")', m('씨.발 진짜') === '*** 진짜');
  check('가림: 초성 욕', m('ㅅㅂ 뭐임') === '** 뭐임');
  check('가림: 영어 대문자·기호 우회', m('what the FUCK') === 'what the ****' && m('f.u.c.k') === '*******');
  check('가림: 합성어("개새끼야" → ***야)', m('개새끼야') === '***야');
  check('안 가림: 띄어쓴 보통 말("다시 발로 차")', m('다시 발로 차') === '다시 발로 차');
  check('안 가림: 동물 새끼 · 보다 · 호로록 · 시바견 · classic', ['고양이 새끼 귀엽다', '안 보지?', '호로록 먹어', '시바견', 'classic'].every((t) => m(t) === t && !containsProfanity(t)));
  check('안 가림: 이모지·빈 문자열 그대로', m('사과 🍎!') === '사과 🍎!' && m('') === '');
  check('containsProfanity', containsProfanity('병신아') && !containsProfanity('정답 사과!'));

  // ── 소켓 ────────────────────────────────────────────────────
  await startServer();
  const c1 = await connect(), c2 = await connect(), c3 = await connect();
  const bad = await emitAck(c1, 'room:create', { name: '시발놈', avatar: {} });
  check('닉네임 욕설: room:create 거절', bad.ok === false && /닉네임에 쓸 수 없는 말/.test(bad.error), bad);
  const created = await emitAck(c1, 'room:create', { name: '방장', avatar: {}, token: 'tok-pf-1-00000001' });
  const code = created.roomCode;
  const badJoin = await emitAck(c2, 'room:join', { roomCode: code, name: 'f.u.c.k', avatar: {} });
  check('닉네임 욕설: room:join 거절(기호 우회)', badJoin.ok === false && /닉네임/.test(badJoin.error), badJoin);
  await emitAck(c2, 'room:join', { roomCode: code, name: '둘째', avatar: {}, token: 'tok-pf-2-00000002' });
  await emitAck(c3, 'room:join', { roomCode: code, name: '셋째', avatar: {}, token: 'tok-pf-3-00000003' });
  const badUpd = await emitAck(c2, 'player:update', { name: '병신', avatar: {} });
  check('닉네임 욕설: player:update 거절', badUpd.ok === false && /닉네임/.test(badUpd.error), badUpd);
  await sleep(200);
  const st = c3.log.filter((x) => x.ev === 'room:state').pop().payload;
  check('room:state 설정에 개인 설정(profanityFilter/streamerMode)은 없다', !('profanityFilter' in st.settings) && !('streamerMode' in st.settings), st.settings);

  // 대기실 채팅: 모두에게(보낸 사람 포함) 가려서
  const p1 = waitNext(c1, 'chat:message', (x) => x.kind === 'chat' && x.id === c2.playerId, 3000, 'self');
  const p3 = waitNext(c3, 'chat:message', (x) => x.kind === 'chat' && x.id === c2.playerId, 3000, 'other');
  c2.emit('chat:message', { text: '아 씨발 왜 안 돼' });
  const [s1, s3] = await Promise.all([p1, p3]);
  check('대기실 채팅: text 원문 + textSafe 가린 판(보낸 사람 포함)', s1.text === '아 씨발 왜 안 돼' && s1.textSafe === '아 ** 왜 안 돼' && s3.text === '아 씨발 왜 안 돼' && s3.textSafe === '아 ** 왜 안 돼', [s1, s3]);

  // 게임 중: 정답에 욕이 섞여도 판정은 원문, 근접(close)·정답자 채팅도 가림
  c1.emit('room:settings', { settings: { mode: 'classic', rounds: 1, drawTime: 40, hints: 0, wordCount: 2, customWords: '해바라기,냉장고,자전거,고슴도치', customWordsOnly: true } });
  c1.emit('lobby:step', { step: 'settings' });
  await sleep(200);
  const chP = waitNext(c1, 'game:choosing', (x) => Array.isArray(x.wordOptions), 5000, 'choosing');
  c1.emit('game:start');
  const ch = await chP;
  const word = ch.wordOptions[0];
  const drP = waitNext(c2, 'game:drawing', undefined, 5000, 'drawing');
  c1.emit('word:choose', { word });
  await drP;
  const wrongP = waitNext(c3, 'chat:message', (x) => x.kind === 'chat' && x.id === c2.playerId, 3000, 'wrong guess');
  c2.emit('chat:message', { text: '병신 ' + word + '아니지' });
  const wrong = await wrongP;
  check('게임 중 오답 채팅: textSafe 는 욕설만 가림', wrong.text === '병신 ' + word + '아니지' && wrong.textSafe === '** ' + word + '아니지', wrong);
  const corrP = waitNext(c3, 'chat:message', (x) => x.kind === 'correct' && x.id === c2.playerId, 3000, 'correct');
  c2.emit('chat:message', { text: word });
  await corrP;
  check('정답은 그대로 판정', true);
  const gcP = waitNext(c1, 'chat:message', (x) => x.kind === 'guessed-chat' && x.id === c2.playerId, 3000, 'guessed-chat');
  c2.emit('chat:message', { text: '존나 쉽네 ㅋㅋ' });
  const gc = await gcP;
  check('정답자 전용 채팅도 textSafe', gc.text === '존나 쉽네 ㅋㅋ' && gc.textSafe === '** 쉽네 ㅋㅋ', gc);
  const c3sees = chats(c3).some((x) => x.kind === 'guessed-chat');
  check('정답자 채팅은 못 맞힌 사람에게 안 감(기존 동작 유지)', !c3sees);
  // 근접(close): 정답 3글자 이상 + 편집거리 1 → 보낸 사람에게 close 로, 욕은 가림
  const near = word.slice(0, -1) + '나';
  const closeP = waitNext(c3, 'chat:message', (x) => x.kind === 'close', 3000, 'close');
  c3.emit('chat:message', { text: near });
  const cl = await closeP;
  check('근접 판정은 원문 기준 · 욕설 없으면 textSafe 없음', cl.text === near && !('textSafe' in cl), cl);

  // 욕설 없는 채팅에는 textSafe 가 붙지 않는다 · 옛 설정 키를 보내도 방 설정에 안 생긴다
  c1.emit('game:end'); await sleep(300);
  const cleanP = waitNext(c3, 'chat:message', (x) => x.kind === 'chat' && x.id === c2.playerId, 3000, 'clean');
  c2.emit('chat:message', { text: '다시 발로 차자' });
  const clean = await cleanP;
  check('보통 말: textSafe 없음', clean.text === '다시 발로 차자' && !('textSafe' in clean), clean);
  const stP = waitNext(c3, 'room:state', (x) => x.settings.rounds === 2, 3000, 'settings');
  c1.emit('room:settings', { settings: { rounds: 2, profanityFilter: false, streamerMode: true } });
  const st2 = await stP;
  check('옛 방 설정 키(profanityFilter/streamerMode)는 무시', !('profanityFilter' in st2.settings) && !('streamerMode' in st2.settings), st2.settings);
  const badUpd2 = await emitAck(c2, 'player:update', { name: '병신', avatar: {} });
  check('닉네임 검사는 항상', badUpd2.ok === false, badUpd2);

  cleanup(failures ? 1 : 0);
})().catch((err) => {
  check(`unexpected error: ${err && err.message}`, false, err && err.stack);
  cleanup(1);
});
