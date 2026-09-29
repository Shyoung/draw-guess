'use strict';
/**
 * profanity.js — 욕설 필터 (닉네임 · 채팅)
 *
 * - 채팅: 걸린 부분만 '*' 로 가린다(maskProfanity). 정답 판정은 원문으로 먼저 하고, 보여 주는 글만 가린다.
 * - 닉네임: 걸리면 거절(containsProfanity). 방 설정과 무관하게 항상.
 * - 비교 전에 문장부호·기호·숫자·이모지를 지우고 소문자로 만든다("시.발", "f*u*c*k" 같은 우회 대응).
 *   띄어쓰기는 지우지 않는다 — "다시 발로" 같은 문장이 걸리지 않게. 그래서 "시 발"은 못 잡는다(의도한 한계).
 * - 목록은 일부러 짧게: 자주 쓰는 욕과 비하어만. "새끼"(동물 새끼) · "보지"(보다) · "호로"(호로록) 처럼
 *   보통 말에 섞이는 것은 단독으로 넣지 않고 합성어로만 넣는다.
 */

const WORDS = [
  // 한국어 욕
  '시발', '씨발', '씨바', '씨빨', '씨팔', '시팔', '싯팔', '씨부랄', '씨불', '시부랄',
  '개새끼', '개새', '개색', '개쉑', '개년', '개놈', '개자식', '개같은', '개같이', '개소리',
  '병신', '븅신', '빙신', '병쉰', '븅', '지랄', '지럴', '좆', '좃', '존나', '존내', '존니', '졸라',
  '미친놈', '미친년', '미친새끼', '미친새', '또라이', '돌아이', '썅', '쌍놈', '쌍년', '염병', '옘병',
  '씹새', '씹알', '씹창', '씹년', '씹놈', '씹덕', '엠창', '엿먹', '니미럴', '니애미', '니에미', '느금', '니년', '니놈',
  '호로새끼', '호로자식', '후레자식', '창녀', '창년', '걸레년', '보슬아치',
  '빠큐', '뻑큐', '뻐큐', '퍽큐',
  // 비하어
  '짱깨', '짱개', '쪽바리', '쪽발이', '깜둥이', '흑형', '한남충', '김치녀', '된장녀', '틀딱', '맘충', '급식충', '한녀충',
  // 초성
  'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅄ', 'ㅈㄹ', 'ㅈㄴ', 'ㅁㅊ', 'ㄲㅈ', 'ㅅㄲ',
  // 영어
  'fuck', 'fuk', 'fck', 'shit', 'bitch', 'asshole', 'cunt', 'pussy', 'dick', 'nigger', 'nigga', 'faggot', 'retard',
  'motherfucker', 'bastard', 'whore', 'slut', 'wtf',
];

// 정규화 후 문자열끼리 비교하므로 목록도 같은 규칙으로
const PATTERNS = Array.from(new Set(WORDS.map((w) => normalizeChar(w)).filter(Boolean)));

/** 비교에 남길 글자만: 한글 음절·자모, 영문. 나머지(공백 제외)는 버린다 */
function keep(ch) {
  return /[가-힣ㄱ-ㅎㅏ-ㅣa-z]/.test(ch);
}
function normalizeChar(s) {
  return Array.from(String(s).normalize('NFC').toLowerCase()).filter(keep).join('');
}

/**
 * 원문에서 욕설 구간을 찾는다. 반환: 가릴 원문 인덱스 집합(Set<number>). 비었으면 없음
 * 공백은 경계로 남기고, 그 사이의 기호·숫자·이모지는 건너뛰어 붙여 본다.
 */
function findRanges(text) {
  const chars = Array.from(String(text).normalize('NFC'));
  const marked = new Set();
  // 공백으로 나눈 조각마다: 남길 글자만 모아 (정규화 문자열, 원문 인덱스 배열)
  let buf = '', map = [];
  const flush = () => {
    if (buf) {
      for (const pat of PATTERNS) {
        let from = 0;
        while (true) {
          const i = buf.indexOf(pat, from);
          if (i < 0) break;
          const a = map[i], b = map[i + pat.length - 1];
          for (let k = a; k <= b; k++) marked.add(k);
          from = i + 1;
        }
      }
    }
    buf = ''; map = [];
  };
  chars.forEach((ch, idx) => {
    if (/\s/.test(ch)) { flush(); return; }
    const low = ch.toLowerCase();
    if (keep(low)) { buf += low; map.push(idx); }
  });
  flush();
  return marked;
}

/** @returns {boolean} */
function containsProfanity(text) {
  return findRanges(text).size > 0;
}

/** 걸린 글자를 '*' 로. @returns {{ text: string, hit: boolean }} */
function maskProfanity(text) {
  const marked = findRanges(text);
  if (!marked.size) return { text: String(text), hit: false };
  const chars = Array.from(String(text).normalize('NFC'));
  return { text: chars.map((ch, i) => (marked.has(i) ? '*' : ch)).join(''), hit: true };
}

module.exports = { containsProfanity, maskProfanity, WORDS };
