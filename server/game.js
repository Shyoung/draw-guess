'use strict';
/**
 * game.js — 방(Room) 상태 머신. 프레임워크 비의존: `io` 인스턴스와 방 코드만 받는다.
 *
 * PROTOCOL.md 의 이벤트/페이로드/규칙을 그대로 구현한다.
 *  - phase: 'lobby' | 'choosing' | 'drawing' | 'turnEnd' | 'gameOver'
 *  - 모든 phase 전환 및 방 삭제 시 타이머를 전부 정리한다 (interval / timeout 누수 없음)
 *  - word / wordOptions 는 출제자에게만 보낸다
 */

const { pickWords } = require('./words');

// ── 상수 ────────────────────────────────────────────────────────
const CANVAS_W = 800;
const CANVAS_H = 600;
const CHOOSING_TIME = 15; // 초
const TURN_END_TIME = 5; // 초
const GAME_OVER_TIME = 10; // 초

const MAX_OPS = 3000; // 턴당 op 상한 (메모리 보호)
const MAX_STROKE_POINTS = 5000; // stroke 하나의 점 상한
const MAX_MOVE_BATCH = 500; // draw:move 한 번의 점 상한
const MAX_CUSTOM_WORDS_LEN = 2000; // customWords 원문 길이 상한

const DEFAULT_SETTINGS = Object.freeze({
  rounds: 3,
  drawTime: 80,
  wordCount: 3,
  hints: 2,
  customWords: '',
  customWordsOnly: false,
});
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ── 순수 헬퍼 ───────────────────────────────────────────────────

/** 정수 clamp. 숫자가 아니면 fallback */
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

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

/** 힌트 시점(잔여 초) 집합. hints=2, drawTime=80 → {53, 27} */
function computeHintTimes(hints, drawTime) {
  const times = new Set();
  for (let i = 1; i <= hints; i++) {
    const t = Math.round((drawTime * (hints + 1 - i)) / (hints + 1));
    if (t > 0 && t < drawTime) times.add(t);
  }
  return times;
}

function clampCoord(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(0, Math.round(n)));
}

/** draw:start 페이로드 검증/정규화. 잘못되면 null */
function sanitizeStart(p) {
  if (!p || typeof p !== 'object') return null;
  const tool = p.tool === 'eraser' ? 'eraser' : p.tool === 'pen' ? 'pen' : null;
  if (!tool) return null;
  if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) return null;
  const size = clampInt(p.size, 1, 60, null);
  if (size === null) return null;
  const x = clampCoord(p.x, CANVAS_W);
  const y = clampCoord(p.y, CANVAS_H);
  if (x === null || y === null) return null;
  return { tool, color: p.color.toLowerCase(), size, x, y };
}

/** draw:move 의 pts 검증/정규화. [[x,y],...] 만 남긴다 */
function sanitizePts(pts) {
  if (!Array.isArray(pts)) return [];
  const out = [];
  for (const pt of pts.slice(0, MAX_MOVE_BATCH)) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const x = clampCoord(pt[0], CANVAS_W);
    const y = clampCoord(pt[1], CANVAS_H);
    if (x === null || y === null) continue;
    out.push([x, y]);
  }
  return out;
}

/** draw:fill 페이로드 검증/정규화 */
function sanitizeFill(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) return null;
  const x = clampCoord(p.x, CANVAS_W);
  const y = clampCoord(p.y, CANVAS_H);
  if (x === null || y === null) return null;
  return { x, y, color: p.color.toLowerCase() };
}

// ── Room ────────────────────────────────────────────────────────

class Room {
  /**
   * @param {import('socket.io').Server} io
   * @param {string} code 4글자 대문자 방 코드
   */
  constructor(io, code) {
    this.io = io;
    this.code = code;

    /** @type {{id:string,name:string,avatar:{emoji:string,color:string},score:number,isDrawing:boolean,hasGuessed:boolean}[]} */
    this.players = []; // 참가 순서
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS };

    this.phase = 'lobby';
    this.round = 0;
    this.totalRounds = this.settings.rounds;
    this.turnOrder = []; // 현재 라운드의 출제 순서 (player id)
    this.turnIndex = -1;

    this.drawerId = null;
    this.word = null;
    this.wordOptions = [];
    this.revealed = new Set();
    this.hintTimes = new Set();
    this.drawTime = this.settings.drawTime; // 현재 턴 drawTime 스냅샷
    this.timeLeft = 0;

    this.ops = [];
    this.currentStroke = null;

    this.usedWords = new Set(); // 이번 게임에서 이미 나온 단어
    this.turnPoints = new Map(); // 이번 턴 획득 점수 (id → delta)

    this.lastTurnEnd = null; // 중간 참가자 재전송용
    this.lastGameOver = null;
    this.phaseEndsAt = 0;

    this._interval = null;
    this._timeout = null;
    this.destroyed = false;
  }

  // ── 전송 헬퍼 ──────────────────────────────────────────────
  emitAll(event, payload) {
    if (this.destroyed) return;
    if (payload === undefined) this.io.to(this.code).emit(event);
    else this.io.to(this.code).emit(event, payload);
  }

  emitTo(id, event, payload) {
    if (this.destroyed || !id) return;
    this.io.to(id).emit(event, payload);
  }

  emitExcept(id, event, payload) {
    if (this.destroyed) return;
    const target = id ? this.io.to(this.code).except(id) : this.io.to(this.code);
    if (payload === undefined) target.emit(event);
    else target.emit(event, payload);
  }

  emitToIds(ids, event, payload) {
    if (this.destroyed || !ids.length) return;
    this.io.to(ids).emit(event, payload);
  }

  systemMessage(text) {
    this.emitAll('chat:message', { text, kind: 'system' });
  }

  // ── 타이머 ─────────────────────────────────────────────────
  clearTimers() {
    if (this._interval) clearInterval(this._interval);
    if (this._timeout) clearTimeout(this._timeout);
    this._interval = null;
    this._timeout = null;
  }

  /** 1초 tick 시작 (choosing / drawing) */
  startTicker() {
    this.clearTimers();
    this.phaseEndsAt = Date.now() + this.timeLeft * 1000;
    this._interval = setInterval(() => this.tick(), 1000);
  }

  /** 단발 phase 타이머 (turnEnd / gameOver) */
  setPhaseTimeout(ms, fn) {
    this.clearTimers();
    this.phaseEndsAt = Date.now() + ms;
    this._timeout = setTimeout(() => {
      this._timeout = null;
      if (!this.destroyed) fn();
    }, ms);
  }

  /** 방 삭제 시 호출. 이후 모든 콜백/전송은 no-op */
  destroy() {
    this.clearTimers();
    this.destroyed = true;
  }

  // ── 조회 ───────────────────────────────────────────────────
  getPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  isEmpty() {
    return this.players.length === 0;
  }

  isHost(id) {
    return !!id && id === this.hostId;
  }

  remainingSeconds() {
    return Math.max(0, Math.ceil((this.phaseEndsAt - Date.now()) / 1000));
  }

  toState() {
    return {
      roomCode: this.code,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      totalRounds: this.totalRounds,
      drawerId: this.phase === 'lobby' ? null : this.drawerId,
      settings: { ...this.settings },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: { ...p.avatar },
        score: p.score,
        isDrawing: p.isDrawing,
        hasGuessed: p.hasGuessed,
      })),
    };
  }

  broadcastState() {
    this.emitAll('room:state', this.toState());
  }

  // ── 플레이어 입퇴장 ─────────────────────────────────────────

  /**
   * 플레이어 추가. 소켓은 호출 전에 이미 this.code 룸에 join 되어 있어야 한다.
   * 게임 중이면 현재 진행 상황(choosing/drawing/turnEnd/gameOver)을 개별 전송한다.
   */
  addPlayer({ id, name, avatar }) {
    if (this.getPlayer(id)) return this.getPlayer(id);
    const p = { id, name, avatar, score: 0, isDrawing: false, hasGuessed: false };
    this.players.push(p);
    if (!this.hostId) this.hostId = id;

    this.systemMessage(`${name}님이 입장했습니다.`);
    this.broadcastState();

    // 중간 참가자에게 현재 진행 상황 전달 (단어/후보는 절대 포함하지 않음)
    const drawer = this.getPlayer(this.drawerId);
    if (this.phase === 'choosing') {
      this.emitTo(id, 'game:choosing', {
        drawerId: this.drawerId,
        drawerName: drawer ? drawer.name : '',
        timeLeft: this.timeLeft,
      });
    } else if (this.phase === 'drawing') {
      this.emitTo(id, 'game:drawing', {
        drawerId: this.drawerId,
        round: this.round,
        totalRounds: this.totalRounds,
        timeLeft: this.timeLeft,
        wordMask: maskWord(this.word, this.revealed),
        wordLength: Array.from(this.word).length,
      });
      this.emitTo(id, 'draw:sync', { ops: this.ops });
    } else if (this.phase === 'turnEnd' && this.lastTurnEnd) {
      this.emitTo(id, 'game:turnEnd', {
        ...this.lastTurnEnd,
        deltas: [...this.lastTurnEnd.deltas, { id, delta: 0 }],
        timeLeft: this.remainingSeconds(),
      });
    } else if (this.phase === 'gameOver' && this.lastGameOver) {
      this.emitTo(id, 'game:over', this.lastGameOver);
    }
    return p;
  }

  /**
   * 플레이어 제거 (퇴장/연결 끊김/강퇴). 호스트 승계, 진행 중 턴 처리까지 수행.
   * @param {string} id
   * @param {'left'|'kicked'} reason
   * @returns {boolean} 제거 여부
   */
  removePlayer(id, reason = 'left') {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    const [p] = this.players.splice(idx, 1);

    if (this.players.length === 0) {
      // 마지막 사람이 나감 → 호출자가 방을 삭제한다
      this.clearTimers();
      this.hostId = null;
      return true;
    }

    // 호스트 승계: 참가 순서상 다음 사람
    if (this.hostId === id) {
      this.hostId = this.players[0].id;
    }

    this.systemMessage(
      reason === 'kicked' ? `${p.name}님이 강퇴되었습니다.` : `${p.name}님이 나갔습니다.`,
    );

    if (this.phase === 'choosing' || this.phase === 'drawing') {
      if (this.players.length < 2) {
        this.endTurn('notEnoughPlayers');
      } else if (id === this.drawerId) {
        this.endTurn('drawerLeft');
      } else if (this.phase === 'drawing' && this.allGuessed()) {
        this.endTurn('allGuessed');
      } else {
        this.broadcastState();
      }
    } else {
      // lobby / turnEnd / gameOver: 다음 전환 시점에 인원 검사
      this.broadcastState();
    }
    return true;
  }

  // ── 설정 ───────────────────────────────────────────────────

  /**
   * 설정 변경 (호스트, lobby). 범위 밖 값은 clamp. 성공 시 room:state 브로드캐스트.
   * @returns {string|null} 오류 메시지 또는 null
   */
  updateSettings(id, patch) {
    if (!this.isHost(id)) return '호스트만 설정을 변경할 수 있습니다.';
    if (this.phase !== 'lobby') return '게임 중에는 설정을 변경할 수 없습니다.';
    if (!patch || typeof patch !== 'object') return '잘못된 설정 값입니다.';

    const s = { ...this.settings };
    if ('rounds' in patch) s.rounds = clampInt(patch.rounds, 1, 10, s.rounds);
    if ('drawTime' in patch) s.drawTime = clampInt(patch.drawTime, 30, 180, s.drawTime);
    if ('wordCount' in patch) s.wordCount = clampInt(patch.wordCount, 2, 5, s.wordCount);
    if ('hints' in patch) s.hints = clampInt(patch.hints, 0, 5, s.hints);
    if ('customWords' in patch) {
      // 원문은 그대로 보존(입력 중 커서 튐 방지), 파싱/검증은 pickWords 시점에 수행
      const raw = typeof patch.customWords === 'string' ? patch.customWords : '';
      s.customWords = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, MAX_CUSTOM_WORDS_LEN);
    }
    if ('customWordsOnly' in patch) s.customWordsOnly = Boolean(patch.customWordsOnly);

    this.settings = s;
    this.totalRounds = s.rounds;
    this.broadcastState();
    return null;
  }

  // ── 게임 흐름 ──────────────────────────────────────────────

  /** game:start (호스트, lobby, 2명 이상) */
  start(id) {
    if (!this.isHost(id)) return '호스트만 게임을 시작할 수 있습니다.';
    if (this.phase !== 'lobby') return '이미 게임이 진행 중입니다.';
    if (this.players.length < 2) return '게임을 시작하려면 2명 이상이 필요합니다.';

    this.clearTimers();
    for (const p of this.players) {
      p.score = 0;
      p.hasGuessed = false;
      p.isDrawing = false;
    }
    this.usedWords = new Set();
    this.round = 1;
    this.totalRounds = this.settings.rounds;
    this.turnOrder = this.players.map((p) => p.id);
    this.turnIndex = -1;
    this.lastTurnEnd = null;
    this.lastGameOver = null;

    this.systemMessage('게임이 시작되었습니다!');
    this.nextTurn();
    return null;
  }

  /** 다음 출제자로 진행. 라운드 종료/게임 종료 판정 포함 */
  nextTurn() {
    if (this.destroyed) return;
    if (this.players.length < 2) {
      this.gameOver();
      return;
    }
    // 무한 루프 방지: 최대 (turnOrder + players) 만큼만 탐색
    for (let guard = 0; guard < this.turnOrder.length + this.players.length + 2; guard++) {
      this.turnIndex += 1;
      if (this.turnIndex >= this.turnOrder.length) {
        // 현재 라운드의 출제 순서를 모두 소진 → 라운드 종료 판정
        if (this.turnOrder.length > 0) {
          if (this.round >= this.totalRounds) {
            this.gameOver();
            return;
          }
          this.round += 1;
        }
        // 새 라운드 출제 순서: 현재 참가 순서 (중간 참가자는 여기서부터 포함)
        this.turnOrder = this.players.map((p) => p.id);
        this.turnIndex = 0;
      }
      const drawerId = this.turnOrder[this.turnIndex];
      if (this.getPlayer(drawerId)) {
        this.beginChoosing(drawerId);
        return;
      }
      // 이미 나간 플레이어는 건너뜀
    }
    // 여기 도달하면 비정상 — 안전하게 게임 종료
    this.gameOver();
  }

  /** choosing 단계 시작 */
  beginChoosing(drawerId) {
    this.clearTimers();
    const drawer = this.getPlayer(drawerId);
    if (!drawer) {
      this.nextTurn();
      return;
    }
    this.phase = 'choosing';
    this.drawerId = drawerId;
    this.word = null;
    this.revealed = new Set();
    this.hintTimes = new Set();
    this.ops = [];
    this.currentStroke = null;
    this.turnPoints = new Map();
    this.lastTurnEnd = null;
    for (const p of this.players) {
      p.isDrawing = p.id === drawerId;
      p.hasGuessed = false;
    }

    let options = pickWords(this.settings, this.usedWords, this.settings.wordCount);
    if (!options.length) options = ['사과']; // 방어: 절대 비어있지 않게
    this.wordOptions = options;
    this.timeLeft = CHOOSING_TIME;

    const base = { drawerId, drawerName: drawer.name, timeLeft: this.timeLeft };
    this.emitExcept(drawerId, 'game:choosing', base);
    this.emitTo(drawerId, 'game:choosing', { ...base, wordOptions: this.wordOptions.slice() });
    this.broadcastState();
    this.systemMessage(`${drawer.name}님이 단어를 고르고 있습니다.`);
    this.startTicker();
  }

  /** word:choose (출제자, choosing, 후보 중 하나) */
  chooseWord(id, word) {
    if (this.phase !== 'choosing') return '지금은 단어를 선택할 수 없습니다.';
    if (id !== this.drawerId) return '출제자만 단어를 선택할 수 있습니다.';
    if (typeof word !== 'string' || !this.wordOptions.includes(word)) {
      return '제시된 후보 중에서 선택해 주세요.';
    }
    this.beginDrawing(word);
    return null;
  }

  /** drawing 단계 시작 */
  beginDrawing(word) {
    this.clearTimers();
    const drawer = this.getPlayer(this.drawerId);
    if (!drawer) {
      this.endTurn('drawerLeft');
      return;
    }
    this.phase = 'drawing';
    this.word = word;
    this.revealed = new Set();
    this.ops = [];
    this.currentStroke = null;
    this.drawTime = this.settings.drawTime;
    this.timeLeft = this.drawTime;
    this.hintTimes = computeHintTimes(this.settings.hints, this.drawTime);

    const base = {
      drawerId: this.drawerId,
      round: this.round,
      totalRounds: this.totalRounds,
      timeLeft: this.timeLeft,
      wordMask: maskWord(word, this.revealed),
      wordLength: Array.from(word).length,
    };
    this.emitExcept(this.drawerId, 'game:drawing', base);
    this.emitTo(this.drawerId, 'game:drawing', { ...base, word });
    this.emitAll('draw:sync', { ops: [] });
    this.broadcastState();
    this.systemMessage(`${drawer.name}님이 그림을 그립니다.`);
    this.startTicker();
  }

  /** 1초마다: game:timer, 힌트, 시간 초과 처리 */
  tick() {
    if (this.destroyed) return;
    if (this.phase !== 'choosing' && this.phase !== 'drawing') {
      this.clearTimers();
      return;
    }
    this.timeLeft = Math.max(0, this.timeLeft - 1);
    this.emitAll('game:timer', { timeLeft: this.timeLeft });

    if (this.phase === 'drawing' && this.hintTimes.has(this.timeLeft)) {
      this.revealHint();
    }

    if (this.timeLeft <= 0) {
      if (this.phase === 'choosing') {
        // 시간 초과 → 첫 후보 자동 선택
        this.beginDrawing(this.wordOptions[0]);
      } else if (this.phase === 'drawing') {
        this.endTurn('time');
      }
    }
  }

  /**
   * 미공개 글자 위치 중 무작위 1개의 초성 공개.
   * 한글만으로 된 단어는 모든 글자의 초성까지 공개 가능(초성만으로는 정답이 드러나지 않음).
   * 영문·숫자가 섞인 단어는 글자가 그대로 드러나므로 전체 글자 수 - 1 까지만.
   */
  revealHint() {
    if (!this.word) return;
    const chars = Array.from(this.word);
    const letterIdx = [];
    chars.forEach((c, i) => {
      if (c !== ' ') letterIdx.push(i);
    });
    const allHangul = letterIdx.every((i) => isHangulSyllable(chars[i]));
    const maxReveal = allHangul ? letterIdx.length : letterIdx.length - 1;
    if (this.revealed.size >= maxReveal) return;
    const candidates = letterIdx.filter((i) => !this.revealed.has(i));
    if (!candidates.length) return;
    this.revealed.add(candidates[Math.floor(Math.random() * candidates.length)]);
    this.emitExcept(this.drawerId, 'game:hint', { wordMask: maskWord(this.word, this.revealed) });
  }

  /** 출제자를 제외한 모든 플레이어가 맞혔는지 */
  allGuessed() {
    const guessers = this.players.filter((p) => p.id !== this.drawerId);
    return guessers.length > 0 && guessers.every((p) => p.hasGuessed);
  }

  /**
   * 턴 종료. 출제자 점수 계산, deltas 전송, 5초 후 다음 턴(또는 게임 종료).
   * @param {'time'|'allGuessed'|'drawerLeft'|'notEnoughPlayers'} reason
   */
  endTurn(reason) {
    if (this.phase !== 'choosing' && this.phase !== 'drawing') return;
    this.clearTimers();

    // 출제자 점수: round(300 * guessedCount / (playerCount - 1)), 최대 300
    const drawer = this.getPlayer(this.drawerId);
    if (drawer && this.phase === 'drawing') {
      const guessers = this.players.length - 1;
      const guessed = this.players.filter((p) => p.id !== this.drawerId && p.hasGuessed).length;
      const pts = guessers > 0 ? Math.min(300, Math.max(0, Math.round((300 * guessed) / guessers))) : 0;
      drawer.score += pts;
      this.turnPoints.set(drawer.id, pts);
    }
    if (this.word) this.usedWords.add(this.word);

    const deltas = this.players.map((p) => ({ id: p.id, delta: this.turnPoints.get(p.id) || 0 }));
    this.phase = 'turnEnd';

    const payload = { word: this.word || '', reason, deltas, timeLeft: TURN_END_TIME };
    this.lastTurnEnd = payload;
    this.emitAll('game:turnEnd', payload);
    this.broadcastState();

    this.setPhaseTimeout(TURN_END_TIME * 1000, () => {
      if (reason === 'notEnoughPlayers') this.gameOver();
      else this.nextTurn();
    });
  }

  /** 게임 종료: 순위 전송 후 10초 뒤 lobby 복귀 */
  gameOver() {
    this.clearTimers();
    this.phase = 'gameOver';
    this.drawerId = null;
    this.word = null;
    this.wordOptions = [];
    this.ops = [];
    this.currentStroke = null;
    for (const p of this.players) {
      p.isDrawing = false;
      p.hasGuessed = false;
    }
    const ranking = this.players
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ id: p.id, name: p.name, avatar: { ...p.avatar }, score: p.score }));
    this.lastGameOver = { ranking };
    this.emitAll('game:over', { ranking });
    this.broadcastState();
    this.setPhaseTimeout(GAME_OVER_TIME * 1000, () => this.backToLobby());
  }

  /** lobby 복귀 (점수는 다음 game:start 까지 유지) */
  backToLobby() {
    this.clearTimers();
    this.phase = 'lobby';
    this.round = 0;
    this.totalRounds = this.settings.rounds;
    this.turnOrder = [];
    this.turnIndex = -1;
    this.drawerId = null;
    this.word = null;
    this.wordOptions = [];
    this.revealed = new Set();
    this.ops = [];
    this.currentStroke = null;
    this.lastTurnEnd = null;
    this.lastGameOver = null;
    for (const p of this.players) {
      p.isDrawing = false;
      p.hasGuessed = false;
    }
    this.broadcastState();
    this.systemMessage('로비로 돌아왔습니다.');
  }

  // ── 채팅 / 정답 판정 ───────────────────────────────────────

  /**
   * chat:message 처리. text 는 호출 전 1..100자로 검증되어 있어야 한다.
   * @returns {string|null} 오류 메시지 또는 null
   */
  handleChat(id, text) {
    const p = this.getPlayer(id);
    if (!p) return '방에 참가하지 않았습니다.';
    const msg = { id: p.id, name: p.name, avatar: { ...p.avatar }, text };

    if (this.phase === 'drawing' && this.word) {
      // 출제자 / 이미 맞힌 사람 → 정답자 전용 채팅
      if (p.id === this.drawerId || p.hasGuessed) {
        const ids = this.players.filter((q) => q.id === this.drawerId || q.hasGuessed).map((q) => q.id);
        this.emitToIds(ids, 'chat:message', { ...msg, kind: 'guessed-chat' });
        return null;
      }
      const guess = normalizeAnswer(text);
      const answer = normalizeAnswer(this.word);
      if (guess === answer) {
        this.onCorrectGuess(p);
        return null;
      }
      if (Array.from(answer).length >= 3 && levenshtein(guess, answer) <= 1) {
        // 근접: 보낸 사람에게만 'close', 나머지에게는 일반 채팅
        this.emitTo(p.id, 'chat:message', { ...msg, kind: 'close' });
        this.emitExcept(p.id, 'chat:message', { ...msg, kind: 'chat' });
        return null;
      }
    }
    this.emitAll('chat:message', { ...msg, kind: 'chat' });
    return null;
  }

  /** 정답 처리: 점수 부여, correct/player:guessed 전송, 전원 정답 시 턴 종료 */
  onCorrectGuess(p) {
    p.hasGuessed = true;
    const pts = Math.max(100, Math.round(100 + (300 * this.timeLeft) / this.drawTime));
    p.score += pts;
    this.turnPoints.set(p.id, pts);

    // 정답 텍스트는 절대 브로드캐스트하지 않는다
    this.emitAll('chat:message', {
      id: p.id,
      name: p.name,
      avatar: { ...p.avatar },
      text: `${p.name}님이 정답을 맞혔습니다!`,
      kind: 'correct',
    });
    this.emitAll('player:guessed', { id: p.id });
    this.broadcastState();

    if (this.allGuessed()) this.endTurn('allGuessed');
  }

  // ── 드로잉 ─────────────────────────────────────────────────

  /**
   * draw:* 처리. 출제자 + drawing 단계가 아니면 조용히 무시.
   * ops[] 를 PROTOCOL 대로 유지하고 출제자를 제외한 방 전체에 중계한다.
   * @param {string} id
   * @param {'start'|'move'|'end'|'fill'|'clear'|'undo'} type
   * @param {unknown} payload
   */
  handleDraw(id, type, payload) {
    if (this.phase !== 'drawing' || id !== this.drawerId) return;

    switch (type) {
      case 'start': {
        const s = sanitizeStart(payload);
        if (!s) return;
        if (this.ops.length >= MAX_OPS) return;
        this.currentStroke = { type: 'stroke', tool: s.tool, color: s.color, size: s.size, points: [[s.x, s.y]] };
        this.ops.push(this.currentStroke);
        this.emitExcept(id, 'draw:start', s);
        return;
      }
      case 'move': {
        if (!this.currentStroke) return;
        const pts = sanitizePts(payload && payload.pts);
        if (!pts.length) return;
        const room = MAX_STROKE_POINTS - this.currentStroke.points.length;
        if (room <= 0) return;
        const use = pts.length > room ? pts.slice(0, room) : pts;
        for (const pt of use) this.currentStroke.points.push(pt);
        this.emitExcept(id, 'draw:move', { pts: use });
        return;
      }
      case 'end': {
        if (!this.currentStroke) return;
        this.currentStroke = null;
        this.emitExcept(id, 'draw:end');
        return;
      }
      case 'fill': {
        const f = sanitizeFill(payload);
        if (!f) return;
        if (this.ops.length >= MAX_OPS) return;
        this.ops.push({ type: 'fill', x: f.x, y: f.y, color: f.color });
        this.emitExcept(id, 'draw:fill', f);
        return;
      }
      case 'clear': {
        this.ops = [];
        this.currentStroke = null;
        this.emitExcept(id, 'draw:clear');
        return;
      }
      case 'undo': {
        if (!this.ops.length) return;
        const popped = this.ops.pop();
        if (popped === this.currentStroke) this.currentStroke = null;
        this.emitExcept(id, 'draw:undo');
        return;
      }
      default:
        return;
    }
  }
}

module.exports = {
  Room,
  DEFAULT_SETTINGS,
  CHOOSING_TIME,
  TURN_END_TIME,
  GAME_OVER_TIME,
  // 테스트/재사용을 위한 순수 헬퍼
  maskWord,
  hintChar,
  isHangulSyllable,
  normalizeAnswer,
  levenshtein,
  computeHintTimes,
  clampInt,
};
