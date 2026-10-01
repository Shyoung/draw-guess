'use strict';
/**
 * textmatch.js — 한글 마스크·정답 판정에 쓰는 순수 헬퍼 (의존성 없음)
 *
 * game.js와 words.js가 둘 다 쓰므로 여기에 둔다(game.js → words.js 순환 참조 방지).
 * game.js는 기존 이름(maskWord·revealAll·hintChar·isHangulSyllable·normalizeAnswer·levenshtein)을 그대로 다시 내보낸다.
 *
 * exports:
 *   normalizeAnswer(s)        : 정답 판정용 정규화(NFC·trim·소문자·연속 공백 1개)
 *   levenshtein(a, b)         : 문자 단위 편집 거리
 *   CHOSEONG                  : 초성 표
 *   isHangulSyllable(ch)      : 완성형 한글 음절인지
 *   hintChar(ch)              : 힌트 글자(한글은 초성, 그 외는 그대로)
 *   maskWord(word, revealed)  : '_ _ _' 마스크(공개 위치는 초성)
 *   revealAll(word)           : 실제 글자를 마스크와 같은 공백 규칙으로
 */

/** 정답 판정용 정규화: NFC, trim, 소문자, 연속 공백 1개 */
function normalizeAnswer(s) {
  return String(s == null ? '' : s)
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Levenshtein 거리 (문자 단위) */
function levenshtein(a, b) {
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length];
}

const CHOSEONG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** 완성형 한글 음절(가~힣)인지 */
function isHangulSyllable(ch) {
  const code = String(ch).codePointAt(0);
  return code >= 0xac00 && code <= 0xd7a3;
}

/** 힌트로 보여줄 글자: 한글 음절은 초성만, 그 외(영문·숫자 등)는 글자 그대로 */
function hintChar(ch) {
  return isHangulSyllable(ch) ? CHOSEONG[Math.floor((ch.codePointAt(0) - 0xac00) / 588)] : ch;
}

/**
 * 단어 마스크. 각 글자 → '_', 공백은 그대로, 글자 사이 공백 1개.
 * 결과적으로 단어 사이 경계는 공백 3개로 보인다. 예) 'ice cream' → '_ _ _   _ _ _ _ _'
 * 공개된 위치는 hintChar()로 표시한다. 예) '사과', {0} → 'ㅅ _'
 * @param {string} word
 * @param {Set<number>} revealed 공개된 글자 인덱스(Array.from 기준)
 */
function maskWord(word, revealed) {
  const chars = Array.from(String(word));
  const rev = revealed || new Set();
  return chars.map((ch, i) => (ch === ' ' ? ' ' : rev.has(i) ? hintChar(ch) : '_')).join(' ');
}

/**
 * 전체 공개(정답을 맞힌 사람 전용). 초성이 아니라 실제 글자를 그대로 보여준다.
 * maskWord와 같은 공백 규칙(글자 사이 1칸, 단어 사이 3칸)을 유지해 클라이언트 렌더링을 그대로 재사용한다.
 * @param {string} word
 */
function revealAll(word) {
  return Array.from(String(word)).join(' ');
}

module.exports = { normalizeAnswer, levenshtein, CHOSEONG, isHangulSyllable, hintChar, maskWord, revealAll };
