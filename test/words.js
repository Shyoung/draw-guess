/**
 * 단어 헬퍼 단위 테스트 (서버 없이)
 *  - 이어 그리기 조합 제시어: pickCombos · maskParts · revealPartsAll · matchParts
 *  - textmatch.js로 옮긴 헬퍼가 game.js에서 같은 이름으로 그대로 나오는지
 *  node test/words.js
 */
'use strict';
const words = require('../server/words');
const game = require('../server/game');
const textmatch = require('../server/textmatch');

const { pickCombos, maskParts, revealPartsAll, matchParts, categoryOf, COMBO_TEMPLATES, CATEGORY_NAMES, PART_SEP } = words;

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

// ── 템플릿 ──
check('템플릿 카테고리 이름이 전부 사전에 있다',
  COMBO_TEMPLATES.every((t) => t.every((c) => CATEGORY_NAMES.includes(c))));
check('템플릿에 신체·건강, 나라·도시·랜드마크가 없다',
  COMBO_TEMPLATES.every((t) => !t.includes('신체·건강') && !t.includes('나라·도시·랜드마크')));
check('템플릿 안의 카테고리는 서로 다르다', COMBO_TEMPLATES.every((t) => distinct(t)));
check('구분자는 가운뎃점(U+00B7) 양쪽 공백 1개', PART_SEP === ' · ');

// ── ① 전체 카테고리, 3개 조합 3후보 ──
{
  let okWords = true, okCats = true, okShape = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const combos = pickCombos({ categories: [] }, new Set(), 3, 3);
    if (combos.length !== 3 || !distinct(combos.map((c) => c.word))) { okWords = false; bad = combos; }
    for (const c of combos) {
      if (!Array.isArray(c.parts) || c.parts.length !== 3 || c.word !== c.parts.join(' · ')) { okShape = false; bad = c; }
      const cats = c.parts.map(categoryOf);
      if (cats.some((x) => !x) || !distinct(cats)) { okCats = false; bad = { c, cats }; }
    }
  }
  check('① 후보 3개, word가 서로 다르다', okWords, bad);
  check('① word = parts.join(" · "), 요소 3개', okShape, bad);
  check('① 한 조합의 요소는 서로 다른 카테고리에서', okCats, bad);
}

// ── ② partCount clamp ──
check('② partCount 1 → 요소 2개', pickCombos({}, new Set(), 2, 1).every((c) => c.parts.length === 2));
check('② partCount 9 → 요소 3개', pickCombos({}, new Set(), 2, 9).every((c) => c.parts.length === 3));
check('② partCount 2 → 요소 2개', pickCombos({}, new Set(), 2, 2).every((c) => c.parts.length === 2));
check('② partCount 이상한 값 → 2~3개', pickCombos({}, new Set(), 2, 'x').every((c) => c.parts.length >= 2 && c.parts.length <= 3));

// ── ③ 켜진 카테고리만 ──
{
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    for (const c of pickCombos({ categories: ['동물', '음식'] }, new Set(), 3, 2)) {
      const cats = c.parts.map(categoryOf).sort();
      if (!same(cats, ['동물', '음식'].sort())) { ok = false; bad = c; }
    }
  }
  check('③ categories 동물·음식 → 요소가 동물 하나·음식 하나', ok, bad);
}
{
  // 맞는 3개 템플릿이 없음 → 켜진 카테고리 중 서로 다른 카테고리로
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    for (const c of pickCombos({ categories: ['악기', '옷·장신구', '스포츠·운동'] }, new Set(), 3, 3)) {
      const cats = c.parts.map(categoryOf);
      if (!distinct(cats) || cats.some((x) => !['악기', '옷·장신구', '스포츠·운동'].includes(x))) { ok = false; bad = c; }
    }
  }
  check('③ 템플릿 없는 카테고리 조합 → 켜진 카테고리에서 서로 다르게', ok, bad);
}
{
  // 켜진 카테고리가 요소 수보다 적음 → 같은 카테고리에서 서로 다른 단어로
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    for (const c of pickCombos({ categories: ['악기'] }, new Set(), 3, 3)) {
      if (c.parts.length !== 3 || !distinct(c.parts) || c.parts.some((w) => categoryOf(w) !== '악기')) { ok = false; bad = c; }
    }
  }
  check('③ 카테고리 하나만 켬 → 그 카테고리에서 서로 다른 요소 3개', ok, bad);
}

// ── ④ 사용자 단어만 ──
{
  const custom = ['사과', '포도', '수박', '자두'];
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const combos = pickCombos({ customWordsOnly: true, customWords: '사과,포도,수박,자두', categories: [] }, new Set(), 3, 2);
    if (combos.length !== 3 || !distinct(combos.map((c) => c.word))) { ok = false; bad = combos; }
    for (const c of combos) {
      if (c.parts.length !== 2 || !distinct(c.parts) || c.parts.some((w) => !custom.includes(w))) { ok = false; bad = c; }
    }
  }
  check('④ customWordsOnly → 사용자 단어끼리, 조합 안 중복 없음', ok, bad);
  const few = pickCombos({ customWordsOnly: true, customWords: '사과,포도', categories: ['동물', '음식'] }, new Set(), 3, 3);
  check('④ 사용자 단어가 요소 수보다 적으면 카테고리 풀로 채운다',
    few.length === 3 && few.every((c) => c.parts.length === 3 && distinct(c.parts)), few);
}
{
  // customWordsOnly가 아니면 사용자 단어가 섞인다(확률) — 많이 넣으면 한 번쯤은 나온다
  const list = Array.from({ length: 300 }, (_, i) => `내단어${i}`);
  let seen = false;
  for (let r = 0; r < 50 && !seen; r++) {
    for (const c of pickCombos({ customWords: list.join(','), categories: ['동물', '음식'] }, new Set(), 3, 2)) {
      if (c.parts.some((w) => w.startsWith('내단어'))) seen = true;
    }
  }
  check('④ customWords는 요소 풀에 섞인다', seen);
}

{
  // 한 글자 단어는 요소로 쓰지 않는다(기본 사전·사용자 단어 모두)
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    for (const c of pickCombos({ categories: [] }, new Set(), 3, 3).concat(
      pickCombos({ customWords: '곰,소,말,게,배,감', categories: ['동물', '음식'] }, new Set(), 3, 2))) {
      if (c.parts.some((w) => Array.from(w).length < 2)) { ok = false; bad = c; }
    }
  }
  const onlyOne = pickCombos({ customWordsOnly: true, customWords: '곰,소,사과,포도' }, new Set(), 3, 2);
  if (onlyOne.some((c) => c.parts.some((w) => Array.from(w).length < 2))) { ok = false; bad = onlyOne; }
  check('④ 한 글자 단어(곰·소·게 등)는 조합 요소로 안 나온다', ok, bad);
}

// ── ⑤ exclude ──
{
  // 사용자 단어 3개 → 조합은 3쌍뿐. 두 쌍을 빼면(순서 무관) 남은 한 쌍만 나와야 한다
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    const ex = new Set(['사과 · 포도', '수박 · 사과']);
    const [c] = pickCombos({ customWordsOnly: true, customWords: '사과,포도,수박' }, ex, 1, 2);
    if (!same(c.parts.slice().sort(), ['수박', '포도'].sort())) { ok = false; bad = c; }
  }
  check('⑤ exclude의 조합은 (순서 무관) 풀이 충분하면 안 나온다', ok, bad);
  const all = pickCombos({ customWordsOnly: true, customWords: '사과,포도,수박' }, new Set(['사과 · 포도', '포도 · 수박', '수박 · 사과']), 2, 2);
  check('⑤ 전부 제외돼도 count개를 돌려준다(재사용)', all.length === 2 && all.every((c) => c.parts.length === 2), all);
}
{
  // 요소 단어 exclude: 동물 카테고리에서 두 마리만 남기고 다 빼면 그 둘만 나온다
  const animals = words.CATEGORIES['동물'].filter((w) => categoryOf(w) === '동물');
  const keep = ['고양이', '강아지'];
  const ex = new Set(animals.filter((w) => !keep.includes(w)));
  let ok = true, bad = null;
  for (let r = 0; r < REPEAT; r++) {
    for (const c of pickCombos({ categories: ['동물', '음식'] }, ex, 2, 2)) {
      const a = c.parts.find((w) => categoryOf(w) === '동물');
      if (!keep.includes(a)) { ok = false; bad = c; }
    }
  }
  check('⑤ exclude의 요소 단어는 풀이 충분하면 안 나온다', ok, bad);
}

// ── ⑥ matchParts ──
check('⑥ "바다에서 고양이가 축구해" → 세 요소 모두',
  same(matchParts('바다에서 고양이가 축구해', ['고양이', '축구', '바다']).solved, [0, 1, 2]));
{
  const m = matchParts('고양이', ['고양이', '축구', '바다']);
  check('⑥ "고양이"만 → solved [0]', same(m.solved, [0]) && same(m.close, []), m);
}
{
  const m = matchParts('고앙이', ['고양이', '축구', '바다']);
  check('⑥ "고앙이" → close에 0', same(m.solved, []) && m.close.includes(0), m);
}
check('⑥ 토큰 근접: "바다 고앙이" → 바다 solved, 고양이 close',
  same(matchParts('바다 고앙이', ['고양이', '축구', '바다']), { solved: [2], close: [0] }));
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
check('⑦ revealPartsAll 맞힌 요소만 글자', revealPartsAll(['고양이', '축구', '바다'], new Set([0, 2])) === '고 양 이 · _ _ · 바 다',
  revealPartsAll(['고양이', '축구', '바다'], new Set([0, 2])));
check('⑦ revealPartsAll 나머지는 힌트 공개분 유지',
  revealPartsAll(['고양이', '축구'], new Set([0]), [new Set(), new Set([0])]) === '고 양 이 · ㅊ _');
check('⑦ 요소별 마스크는 maskWord와 같다',
  maskParts(['사과']) === game.maskWord('사과', new Set()));

// ── ⑧ 방어 ──
for (const [label, st] of [['null', null], ['undefined', undefined], ['숫자', 42], ['이상한 필드', { categories: 'x', customWords: 5, customWordsOnly: 'y' }], ['없는 카테고리', { categories: ['없는카테고리'] }]]) {
  const got = pickCombos(st, null, 3, 3);
  check(`⑧ settings=${label} → 예외 없이 3개`,
    got.length === 3 && got.every((c) => c.parts.length === 3 && typeof c.word === 'string' && distinct(c.parts)), got);
}
check('⑧ count 이상한 값 → 기본 3개', pickCombos({}, new Set(), 'abc', 2).length === 3);

// ── textmatch 재내보내기 ──
for (const name of ['maskWord', 'revealAll', 'hintChar', 'isHangulSyllable', 'normalizeAnswer', 'levenshtein']) {
  check(`game.${name} === textmatch.${name}`, typeof game[name] === 'function' && game[name] === textmatch[name]);
}
check('game.maskWord 기존 동작', game.maskWord('사과', new Set([0])) === 'ㅅ _' && game.maskWord('ice cream') === '_ _ _   _ _ _ _ _');
check('game.normalizeAnswer 기존 동작', game.normalizeAnswer('  A   b ') === 'a b');
check('game.levenshtein 기존 동작', game.levenshtein('고양이', '고앙이') === 1);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
