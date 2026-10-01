/**
 * 단어 헬퍼 단위 테스트 (서버 없이)
 *  - 이어 그리기 제시어: pickRelayWords(단어 후보) · maskParts · revealPartsAll · matchParts
 *  - textmatch.js로 옮긴 헬퍼가 game.js에서 같은 이름으로 그대로 나오는지
 *  node test/words.js
 */
'use strict';
const words = require('../server/words');
const game = require('../server/game');
const textmatch = require('../server/textmatch');

const { pickRelayWords, maskParts, revealPartsAll, matchParts, categoryOf, PART_SEP, RELAY_PART_COUNT } = words;

let passes = 0, failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) passes += 1; else failures += 1;
  const suffix = !ok && detail !== undefined ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${suffix}`);
  return ok;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const distinct = (list) => new Set(list).size === list.length;
const REPEAT = 200; // 무작위라 여러 번 돌려 본다

check('구분자는 가운뎃점(U+00B7) 양쪽 공백 1개', PART_SEP === ' · ');
check('relay 요소 수는 항상 2', RELAY_PART_COUNT === 2);
check('조합 템플릿은 더 쓰지 않는다(내보내지 않음)', words.COMBO_TEMPLATES === undefined && words.pickCombos === undefined);

// ── ① 전체 카테고리, 후보 6개 ──
{
  let okCount = true, okCats = true, okLen = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const list = pickRelayWords({ categories: [] }, new Set(), 6);
    if (list.length !== 6 || !distinct(list)) { okCount = false; bad = list; }
    if (list.some((w) => typeof w !== 'string' || Array.from(w).length < 2)) { okLen = false; bad = list; }
    const cats = list.map(categoryOf);
    if (cats.some((x) => !x) || !distinct(cats)) { okCats = false; bad = { list, cats }; }
  }
  check('① 후보 6개, 서로 다른 단어', okCount, bad);
  check('① 두 글자 이상만', okLen, bad);
  check('① 카테고리 13개 중 6개 → 6개 모두 서로 다른 카테고리', okCats, bad);
}

// ── ② count clamp(3~8, 기본 6) ──
check('② count 2 → 3개', pickRelayWords({}, new Set(), 2).length === 3);
check('② count 9 → 8개', pickRelayWords({}, new Set(), 9).length === 8);
check('② count 8 → 8개(서로 다름)', (() => { const l = pickRelayWords({}, new Set(), 8); return l.length === 8 && distinct(l); })());
check('② count 이상한 값 → 6개', pickRelayWords({}, new Set(), 'x').length === 6);

// ── ③ 켜진 카테고리만, 돌아가며 고르게 ──
{
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const list = pickRelayWords({ categories: ['동물', '음식'] }, new Set(), 6);
    const cats = list.map(categoryOf);
    const a = cats.filter((c) => c === '동물').length, b = cats.filter((c) => c === '음식').length;
    if (list.length !== 6 || !distinct(list) || a !== 3 || b !== 3) { ok = false; bad = { list, cats }; }
  }
  check('③ categories 동물·음식, 6개 → 동물 3·음식 3(돌아가며 하나씩)', ok, bad);
}
{
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const list = pickRelayWords({ categories: ['악기'] }, new Set(), 8);
    if (list.length !== 8 || !distinct(list) || list.some((w) => categoryOf(w) !== '악기')) { ok = false; bad = list; }
  }
  check('③ 카테고리 하나만 켬 → 그 카테고리에서 서로 다른 8개', ok, bad);
}
{
  // 4개 켜고 6개 → 한 카테고리가 2개를 넘지 않는다
  let ok = true, bad = null;
  const four = ['동물', '음식', '탈것', '악기'];
  for (let r = 0; r < REPEAT; r++) {
    const cats = pickRelayWords({ categories: four }, new Set(), 6).map(categoryOf);
    if (four.some((c) => cats.filter((x) => x === c).length > 2) || cats.some((c) => !four.includes(c))) { ok = false; bad = cats; }
  }
  check('③ 카테고리 4개·후보 6개 → 카테고리마다 1~2개', ok, bad);
}

// ── ④ 사용자 단어 ──
{
  const custom = ['사과나무', '포도밭', '수박씨', '자두잼', '딸기잼', '귤껍질', '감나무'];
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const list = pickRelayWords({ customWordsOnly: true, customWords: custom.join(','), categories: [] }, new Set(), 6);
    if (list.length !== 6 || !distinct(list) || list.some((w) => !custom.includes(w))) { ok = false; bad = list; }
  }
  check('④ customWordsOnly · 사용자 단어 ≥ 후보 수 → 사용자 단어만', ok, bad);
  let okFew = true, badFew = null;
  for (let r = 0; r < REPEAT; r++) {
    const few = pickRelayWords({ customWordsOnly: true, customWords: '사과나무,포도밭', categories: ['동물'] }, new Set(), 6);
    if (few.length !== 6 || !distinct(few) || !few.includes('사과나무') || !few.includes('포도밭')
      || few.filter((w) => w !== '사과나무' && w !== '포도밭').some((w) => categoryOf(w) !== '동물')) { okFew = false; badFew = few; }
  }
  check('④ 사용자 단어가 모자라면 전부 넣고 나머지는 켜진 카테고리에서', okFew, badFew);
}
{
  // customWordsOnly가 아니면 사용자 단어가 섞인다(확률) — 많이 넣으면 한 번쯤은 나온다
  const list = Array.from({ length: 300 }, (_, i) => `내단어${i}`);
  let seen = false;
  for (let r = 0; r < 50 && !seen; r++) {
    if (pickRelayWords({ customWords: list.join(','), categories: ['동물', '음식'] }, new Set(), 6).some((w) => w.startsWith('내단어'))) seen = true;
  }
  check('④ customWords는 후보 풀에 섞인다', seen);
}
{
  // 한 글자 단어·가운뎃점이 든 단어는 후보로 쓰지 않는다(기본 사전·사용자 단어 모두)
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    for (const w of pickRelayWords({ categories: [] }, new Set(), 8).concat(
      pickRelayWords({ customWords: '곰,소,말,게,배,감,가·나', categories: ['동물', '음식'] }, new Set(), 8))) {
      if (Array.from(w).length < 2 || w.includes('·')) { ok = false; bad = w; }
    }
  }
  const only = pickRelayWords({ customWordsOnly: true, customWords: '곰,소,사과나무,포도밭,수박씨' }, new Set(), 3);
  if (only.some((w) => Array.from(w).length < 2)) { ok = false; bad = only; }
  check('④ 한 글자 단어(곰·소·게 등)·가운뎃점 단어는 후보로 안 나온다', ok, bad);
}

// ── ⑤ exclude ──
{
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const list = pickRelayWords({ customWordsOnly: true, customWords: '가나,다라,마바,사아,자차' }, new Set(['가나', '다라']), 3);
    if (!same(list.slice().sort(), ['마바', '사아', '자차'].sort())) { ok = false; bad = list; }
  }
  check('⑤ exclude의 단어는 풀이 충분하면 안 나온다', ok, bad);
  const all = pickRelayWords({ customWordsOnly: true, customWords: '가나,다라,마바' }, new Set(['가나', '다라', '마바']), 3);
  check('⑤ 전부 제외돼도 count개를 돌려준다(재사용)', all.length === 3 && distinct(all), all);
}
{
  const animals = words.CATEGORIES['동물'].filter((w) => categoryOf(w) === '동물' && Array.from(w).length >= 2);
  const keep = ['고양이', '강아지'];
  const ex = new Set(animals.filter((w) => !keep.includes(w)));
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const a = pickRelayWords({ categories: ['동물', '음식'] }, ex, 4).filter((w) => categoryOf(w) === '동물');
    if (!same(a.slice().sort(), keep.slice().sort())) { ok = false; bad = a; }
  }
  check('⑤ 기본 사전 exclude: 동물 두 마리만 남기면 그 둘만', ok, bad);
}

// ── ⑥ matchParts ──
check('⑥ "고양이가 축구해" → 두 요소 모두(순서·조사 무관)',
  same(matchParts('고양이가 축구해', ['고양이', '축구']).solved, [0, 1]) && same(matchParts('축구하는 고양이', ['고양이', '축구']).solved, [0, 1]));
{
  const m = matchParts('고양이', ['고양이', '축구']);
  check('⑥ "고양이"만 → solved [0]', same(m.solved, [0]) && same(m.close, []), m);
}
{
  const m = matchParts('고앙이', ['고양이', '축구']);
  check('⑥ "고앙이" → close에 0', same(m.solved, []) && m.close.includes(0), m);
}
check('⑥ 토큰 근접: "바다 고앙이" → 바다 solved, 고양이 close',
  same(matchParts('바다 고앙이', ['고양이', '바다']), { solved: [1], close: [0] }));
check('⑥ 2글자 요소는 근접 대상이 아니다', same(matchParts('축고', ['고양이', '축구']).close, []));
check('⑥ 대소문자·공백 정규화', same(matchParts('  ICE   Cream!! ', ['ice cream']).solved, [0]));
check('⑥ 공백 뺀 판끼리: "아이스 크림" ↔ "아이스크림"',
  same(matchParts('아이스 크림', ['아이스크림']).solved, [0]) && same(matchParts('아이스크림', ['아이스 크림']).solved, [0]));
check('⑥ 빈 입력 → 없음', same(matchParts('   ', ['고양이']), { solved: [], close: [] }));
check('⑥ parts가 이상해도 예외 없음', same(matchParts('고양이', null), { solved: [], close: [] }));

// ── ⑦ maskParts / revealPartsAll ──
check('⑦ maskParts 공개 없음', maskParts(['고양이', '축구']) === '_ _ _ · _ _', maskParts(['고양이', '축구']));
check('⑦ maskParts 초성 공개', maskParts(['고양이', '축구'], [new Set([0]), new Set([1])]) === 'ㄱ _ _ · _ ㄱ',
  maskParts(['고양이', '축구'], [new Set([0]), new Set([1])]));
check('⑦ maskParts 요소 안 공백은 maskWord 규칙', maskParts(['ice cream', '곰']) === '_ _ _   _ _ _ _ _ · _');
check('⑦ revealPartsAll 맞힌 요소만 글자', revealPartsAll(['고양이', '축구'], new Set([1])) === '_ _ _ · 축 구',
  revealPartsAll(['고양이', '축구'], new Set([1])));
check('⑦ revealPartsAll 나머지는 힌트 공개분 유지',
  revealPartsAll(['고양이', '축구'], new Set([0]), [new Set(), new Set([0])]) === '고 양 이 · ㅊ _');
check('⑦ 요소별 마스크는 maskWord와 같다',
  maskParts(['사과']) === game.maskWord('사과', new Set()));

// ── ⑧ 방어 ──
for (const [label, st] of [['null', null], ['undefined', undefined], ['숫자', 42], ['이상한 필드', { categories: 'x', customWords: 5, customWordsOnly: 'y' }], ['없는 카테고리', { categories: ['없는카테고리'] }]]) {
  const got = pickRelayWords(st, null, 6);
  check(`⑧ settings=${label} → 예외 없이 6개`, got.length === 6 && got.every((w) => typeof w === 'string' && Array.from(w).length >= 2) && distinct(got), got);
}

// ── textmatch 재내보내기 ──
for (const name of ['maskWord', 'revealAll', 'hintChar', 'isHangulSyllable', 'normalizeAnswer', 'levenshtein']) {
  check(`game.${name} === textmatch.${name}`, typeof game[name] === 'function' && game[name] === textmatch[name]);
}
check('game.maskWord 기존 동작', game.maskWord('사과', new Set([0])) === 'ㅅ _' && game.maskWord('ice cream') === '_ _ _   _ _ _ _ _');
check('game.normalizeAnswer 기존 동작', game.normalizeAnswer('  A   b ') === 'a b');
check('game.levenshtein 기존 동작', game.levenshtein('고양이', '고앙이') === 1);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
