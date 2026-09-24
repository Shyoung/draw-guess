'use strict';
/**
 * game.js — 방(Room) 상태 머신. 프레임워크 비의존: `io` 인스턴스와 방 코드만 받는다.
 *
 * PROTOCOL.md 의 이벤트/페이로드/규칙을 그대로 구현한다.
 *  - phase: 'lobby' | 'choosing' | 'drawing' | 'turnEnd' | 'gameOver'
 *  - 모든 phase 전환 및 방 삭제 시 타이머를 전부 정리한다 (interval / timeout 누수 없음)
 *  - word / wordOptions 는 출제자에게만 보낸다
 */

const { pickWords, categoryOf } = require('./words');

// ── 상수 ────────────────────────────────────────────────────────
const CANVAS_W = 800;
const CANVAS_H = 600;
const CHOOSING_TIME = 15; // 초
const TURN_END_TIME = 5; // 초
const GAME_OVER_TIME = 10; // 초
// 연결이 끊긴 플레이어를 방에 남겨두는 시간(ms). 이 안에 room:rejoin 하면 점수·자리를 그대로 이어간다. 0이면 즉시 퇴장.
/**
 * 방장이 오프라인인데 접속자가 있을 때, 방장이 돌아오길 기다리는 시간(ms). 그 뒤에도 없으면 접속 중인 첫 사람에게 넘긴다.
 * (끊기자마자 넘기면 새로고침·배포 재접속 때마다 방장이 바뀌었다. 서버 재시작 복원처럼 처음부터 오프라인인 경우도 같은 규칙)
 */
const HOST_RETURN_MS = process.env.HOST_RETURN_MS != null ? Math.max(0, Number(process.env.HOST_RETURN_MS) || 0) : 10000;
const RECONNECT_GRACE_MS = process.env.RECONNECT_GRACE_MS != null
  ? Math.max(0, Number(process.env.RECONNECT_GRACE_MS) || 0)
  : 60000;
// 게임을 시작/진행하는 데 필요한 최소 접속 인원. ALLOW_SOLO=1 (스테이징·개발 서버) 이면 혼자서도 시작해 화면을 확인할 수 있다.
const ALLOW_SOLO = process.env.ALLOW_SOLO === '1';
const MIN_PLAYERS = ALLOW_SOLO ? 1 : 2;

const MAX_OPS = 3000; // 턴당 op 상한 (메모리 보호)
const MAX_STROKE_POINTS = 5000; // stroke 하나의 점 상한
const MAX_MOVE_BATCH = 500; // draw:move 한 번의 점 상한
const MAX_CUSTOM_WORDS_LEN = 2000; // customWords 원문 길이 상한

const DEFAULT_SETTINGS = Object.freeze({
  rounds: 3,
  drawTime: 80,
  wordCount: 3,
  hints: 2,
  hintEndAt: 15, // 마지막 힌트가 뜨는 시점(종료 N초 전), 5..60
  customWords: '',
  customWordsOnly: false,
  mode: 'classic',      // 'classic' 돌아가며 그리기 | 'fixed' 한 명이 계속 그리기(지정 출제자)
  fixedDrawerId: null,  // fixed 모드의 출제자. null 이면 호스트
});
const MODES = ['classic', 'fixed', 'blitz'];
// 속도전(blitz): 단어 후보 없이 자동 선택, 힌트 없음, 짧은 시간. 맞힌 순서로 점수(1등 400, 2등 300, 3등 200, 이후 100)
const BLITZ_RANK_POINTS = [400, 300, 200];
const LOBBY_STEPS = ['mode', 'settings'];
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

/**
 * 전체 공개(정답을 맞힌 사람 전용). 초성이 아니라 실제 글자를 그대로 보여준다.
 * maskWord와 같은 공백 규칙(글자 사이 1칸, 단어 사이 3칸)을 유지해 클라이언트 렌더링을 그대로 재사용한다.
 * @param {string} word
 */
function revealAll(word) {
  return Array.from(String(word)).join(' ');
}

/** 힌트 시점(잔여 초) 집합. hints=2, drawTime=80 → {53, 27} */
/**
 * 힌트 시점(잔여 초) 집합 — 종료 endAt초 전을 기준으로 역산한다.
 * 마지막 힌트는 항상 잔여 endAt초에 뜨고, 그 앞의 힌트들은 시작~마지막 힌트 사이에 균등 배치된다.
 * 그래서 공개할 글자 수(count)가 1이든 3이든 "모든 힌트가 다 공개되는 시점"은 같다.
 * 예) count=2, drawTime=80, endAt=15 → {37, 15} / count=1 → {15}
 * @param {number} count 실제로 공개할 힌트 개수 (설정값과 단어의 공개 가능 글자 수 중 작은 값)
 * @param {number} drawTime 초
 * @param {number} [endAt=15] 마지막 힌트가 뜨는 잔여 초
 */
function computeHintTimes(count, drawTime, endAt = 15) {
  const times = new Set();
  const n = Math.max(0, Math.floor(count));
  if (n === 0 || drawTime <= 0) return times;
  const last = Math.min(Math.max(1, Math.round(endAt)), drawTime - 1);
  const gap = (drawTime - last) / (n + 1);
  // 이른 힌트(잔여 초가 큰 쪽)부터 넣어 순회 순서가 시간 순이 되게 한다
  for (let i = n - 1; i >= 0; i--) {
    const t = Math.round(last + gap * i);
    if (t > 0 && t < drawTime) times.add(t);
  }
  return times;
}

/** 이 단어에서 힌트로 공개할 수 있는 최대 글자 수 (revealHint와 같은 규칙) */
function maxReveals(word) {
  const chars = Array.from(String(word || ''));
  const letters = chars.filter((ch) => ch !== ' ');
  if (!letters.length) return 0;
  const allHangul = letters.every((ch) => isHangulSyllable(ch));
  return allHangul ? letters.length : letters.length - 1;
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
    this.lobbyStep = 'mode'; // 대기실 단계: 'mode'(모드 선택) → 'settings'(게임 설정). 게임이 끝나고 돌아오면 'settings'
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

    this.usedWords = new Set(); // 이번 게임에서 이미 나온(선택된) 단어
    this.offeredWords = new Set(); // 이번 게임에서 후보로 한 번이라도 제시된 단어 — 반복 제시 방지
    this.gallery = []; // 이번 게임의 턴별 기록 [{ round, word, category, drawerId, drawerName, guessed, ops }] — 게임 종료 갤러리
    this.hintCount = 0; // 이번 턴에 예정된 초성 힌트 개수
    this.categoryRevealed = false; // 마지막 초성 힌트와 함께 카테고리를 공개했는지
    this.turnPoints = new Map(); // 이번 턴 획득 점수 (id → delta)

    this.lastTurnEnd = null; // 중간 참가자 재전송용
    this.lastGameOver = null;
    this.phaseEndsAt = 0;

    this._interval = null;
    this._timeout = null;
    this.destroyed = false;

    /** 상태 저장소 (index.js가 주입). 없으면 저장하지 않는다 */
    this.store = null;
    this._persistTimer = null;
  }

  // ── 저장/복원 (배포·재시작 후 방 유지) ────────────────────────
  /** 직렬화 가능한 스냅샷. 소켓/타이머 같은 런타임 값은 제외하고, 시간은 절대 시각(phaseEndsAt)으로 남긴다 */
  toSnapshot() {
    return {
      v: 1,
      code: this.code,
      hostId: this.hostId,
      settings: { ...this.settings },
      phase: this.phase,
      lobbyStep: this.lobbyStep,
      round: this.round,
      totalRounds: this.totalRounds,
      turnOrder: this.turnOrder.slice(),
      turnIndex: this.turnIndex,
      drawerId: this.drawerId,
      word: this.word,
      wordOptions: this.wordOptions.slice(),
      revealed: [...this.revealed],
      hintTimes: [...this.hintTimes],
      drawTime: this.drawTime,
      timeLeft: this.timeLeft,
      phaseEndsAt: this.phaseEndsAt,
      ops: this.ops,
      usedWords: [...this.usedWords],
      offeredWords: [...this.offeredWords],
      gallery: this.gallery,
      hintCount: this.hintCount,
      categoryRevealed: this.categoryRevealed,
      turnPoints: [...this.turnPoints.entries()],
      lastTurnEnd: this.lastTurnEnd,
      lastGameOver: this.lastGameOver,
      players: this.players.map((p) => ({
        id: p.id, name: p.name, avatar: { ...p.avatar }, score: p.score,
        isDrawing: p.isDrawing, hasGuessed: p.hasGuessed, token: p.token, atResults: !!p.atResults, userId: p.userId || null,
      })),
      savedAt: Date.now(),
    };
  }

  /**
   * 스냅샷으로 방을 복원한다. 모든 플레이어는 "연결 끊김(유예 중)" 상태로 시작하고,
   * 클라이언트가 토큰으로 room:rejoin 하면 같은 자리로 돌아온다. 타이머는 저장된 종료 시각부터 이어간다.
   */
  static fromSnapshot(io, s) {
    const room = new Room(io, s.code);
    room.hostId = s.hostId;
    room.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    room.phase = s.phase || 'lobby';
    room.lobbyStep = LOBBY_STEPS.includes(s.lobbyStep) ? s.lobbyStep : 'settings';
    room.round = s.round || 0;
    room.totalRounds = s.totalRounds || room.settings.rounds;
    room.turnOrder = Array.isArray(s.turnOrder) ? s.turnOrder.slice() : [];
    room.turnIndex = typeof s.turnIndex === 'number' ? s.turnIndex : -1;
    room.drawerId = s.drawerId || null;
    room.word = s.word || null;
    room.wordOptions = Array.isArray(s.wordOptions) ? s.wordOptions.slice() : [];
    room.revealed = new Set(s.revealed || []);
    room.hintTimes = new Set(s.hintTimes || []);
    room.drawTime = s.drawTime || room.settings.drawTime;
    room.timeLeft = s.timeLeft || 0;
    // 저장 시점 기준 잔여 시간을 복원 시점부터 다시 흐르게 한다 (배포 전환 사이의 빈 시간은 게임 시간에서 빼지 않음)
    const downtime = s.savedAt ? Math.max(0, Date.now() - s.savedAt) : 0;
    room.phaseEndsAt = s.phaseEndsAt ? s.phaseEndsAt + downtime : 0;
    room.ops = Array.isArray(s.ops) ? s.ops : [];
    room.currentStroke = null;
    room.usedWords = new Set(s.usedWords || []);
    room.offeredWords = new Set(s.offeredWords || []);
    room.gallery = Array.isArray(s.gallery) ? s.gallery : [];
    room.hintCount = s.hintCount || 0;
    room.categoryRevealed = !!s.categoryRevealed;
    room.turnPoints = new Map(s.turnPoints || []);
    room.lastTurnEnd = s.lastTurnEnd || null;
    room.lastGameOver = s.lastGameOver || null;
    room.players = (s.players || []).map((p) => ({
      id: p.id, name: p.name, avatar: { ...p.avatar }, score: p.score || 0,
      isDrawing: !!p.isDrawing, hasGuessed: !!p.hasGuessed, token: p.token || null,
      connected: false, socketId: null, _graceTimer: null, atResults: !!p.atResults, userId: p.userId || null,
    }));
    return room;
  }

  /** 복원 직후 호출: 유예 타이머와 phase 타이머를 다시 건다 */
  resumeAfterRestore() {
    for (const p of this.players) this.startGrace(p);
    if (this.phase === 'choosing' || this.phase === 'drawing') {
      this.timeLeft = this.remainingSeconds();
      if (this.timeLeft <= 0) {
        if (this.phase === 'choosing') this.beginDrawing(this.wordOptions[0]);
        else this.endTurn('time');
      } else {
        // startTicker()는 phaseEndsAt을 다시 계산하므로 여기서는 종료 시각을 유지한 채 interval만 건다
        this.clearTimers();
        this._interval = setInterval(() => this.tick(), 1000);
      }
    } else if (this.phase === 'turnEnd') {
      const reason = this.lastTurnEnd ? this.lastTurnEnd.reason : 'time';
      this.setPhaseTimeout(Math.max(500, this.phaseEndsAt - Date.now()), () => {
        if (reason === 'notEnoughPlayers') this.gameOver();
        else this.nextTurn();
      });
    } else if (this.phase === 'gameOver') {
      this.setPhaseTimeout(Math.max(500, this.phaseEndsAt - Date.now()), () => this.backToLobby());
    }
  }

  /** 끊긴 플레이어의 퇴장 유예 타이머 */
  startGrace(p) {
    this.clearGrace(p);
    if (RECONNECT_GRACE_MS <= 0) return;
    p._graceTimer = setTimeout(() => {
      p._graceTimer = null;
      if (this.destroyed || p.connected || !this.getPlayer(p.id)) return;
      this.removePlayer(p.id, 'left');
      if (typeof this.onEmpty === 'function') this.onEmpty(this);
    }, RECONNECT_GRACE_MS);
  }

  /** 상태 저장 예약(300ms 스로틀). 저장 실패는 게임에 영향 없음 */
  persist() {
    if (!this.store || this.destroyed || this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.flushPersist();
    }, 300);
  }

  /** 즉시 저장 (종료 직전 등) */
  flushPersist() {
    if (!this.store || this.destroyed) return Promise.resolve();
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    if (this.isEmpty()) return Promise.resolve();
    return this.store.save(this.code, this.toSnapshot()).catch((err) => console.warn('[store] save failed:', err.message));
  }

  // ── 전송 헬퍼 ──────────────────────────────────────────────
  emitAll(event, payload) {
    if (this.destroyed) return;
    if (payload === undefined) this.io.to(this.code).emit(event);
    else this.io.to(this.code).emit(event, payload);
  }

  /** playerId → 현재 socket id (재접속하면 socket id가 바뀌지만 playerId는 유지된다) */
  sid(id) {
    const p = this.getPlayer(id);
    return p && p.socketId ? p.socketId : id;
  }

  emitTo(id, event, payload) {
    if (this.destroyed || !id) return;
    const p = this.getPlayer(id);
    if (p && !p.connected) return; // 끊긴 사람에게는 보낼 곳이 없다
    this.io.to(this.sid(id)).emit(event, payload);
  }

  emitExcept(id, event, payload) {
    if (this.destroyed) return;
    const target = id ? this.io.to(this.code).except(this.sid(id)) : this.io.to(this.code);
    if (payload === undefined) target.emit(event);
    else target.emit(event, payload);
  }

  emitToIds(ids, event, payload) {
    if (this.destroyed) return;
    const sids = ids.filter((id) => { const p = this.getPlayer(id); return !p || p.connected; }).map((id) => this.sid(id));
    if (!sids.length) return;
    this.io.to(sids).emit(event, payload);
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
    this.clearHostTimer();
    for (const p of this.players) this.clearGrace(p);
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    this.destroyed = true;
  }

  clearGrace(p) {
    if (p && p._graceTimer) { clearTimeout(p._graceTimer); p._graceTimer = null; }
  }

  /** 현재 연결된 플레이어 */
  connectedPlayers() {
    return this.players.filter((p) => p.connected);
  }

  /** 같은 token을 가진 플레이어(연결 상태 무관). 새로고침 직후처럼 옛 소켓의 끊김이 아직 감지되지 않은 경우도 잡는다 */
  findByToken(token) {
    if (!token) return null;
    return this.players.find((p) => p.token === token) || null;
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
      nextDrawerId: this.computeNextDrawerId(),
      lobbyStep: this.lobbyStep,
      fixedDrawerId: this.settings.mode === 'fixed' ? this.fixedDrawerId() : null,
      allowSolo: ALLOW_SOLO,
      settings: { ...this.settings },
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: { ...p.avatar },
        score: p.score,
        isDrawing: p.isDrawing,
        hasGuessed: p.hasGuessed,
        connected: p.connected,
        atResults: !!p.atResults,
        loggedIn: !!p.userId,
      })),
    };
  }

  /**
   * 방장 확인: 방장 id 가 목록에 없으면 즉시 바로잡고, 방장이 오프라인인데 접속자가 있으면 HOST_RETURN_MS 뒤에 넘긴다.
   * (그 사이 방장이 돌아오면 그대로)
   */
  checkHost() {
    if (!this.players.length) { this.clearHostTimer(); return; }
    if (!this.getPlayer(this.hostId)) {
      const next = this.connectedPlayers()[0] || this.players[0];
      this.hostId = next.id;
    }
    const host = this.getPlayer(this.hostId);
    const next = this.connectedPlayers()[0];
    if (host.connected || !next) { this.clearHostTimer(); return; }
    if (this._hostTimer) return;
    this._hostTimer = setTimeout(() => {
      this._hostTimer = null;
      if (this.destroyed) return;
      const h = this.getPlayer(this.hostId);
      const n = this.connectedPlayers()[0];
      if ((h && h.connected) || !n) return;
      this.hostId = n.id;
      this.systemMessage(`방장이 돌아오지 않아 ${n.name}님이 방장이 됐어요.`);
      this.broadcastState();
    }, HOST_RETURN_MS);
  }
  clearHostTimer() { if (this._hostTimer) { clearTimeout(this._hostTimer); this._hostTimer = null; } }

  broadcastState() {
    this.checkHost();
    this.emitAll('room:state', this.toState());
    this.persist();
  }

  // ── 플레이어 입퇴장 ─────────────────────────────────────────

  /**
   * 플레이어 추가. 소켓은 호출 전에 이미 this.code 룸에 join 되어 있어야 한다.
   * 게임 중이면 현재 진행 상황(choosing/drawing/turnEnd/gameOver)을 개별 전송한다.
   */
  addPlayer({ id, name, avatar, token, socketId, user }) {
    if (this.getPlayer(id)) return this.getPlayer(id);
    const p = {
      id, name, avatar, score: 0, isDrawing: false, hasGuessed: false,
      token: token || null, connected: true, socketId: socketId || id, _graceTimer: null,
      userId: user && user.userId ? user.userId : null, // 로그인 사용자면 Supabase user id (게스트는 null)
      atResults: false, // 게임 종료 결과 화면을 아직 보고 있는지 (직접 "대기실로" 를 눌러야 false)
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = id;

    this.systemMessage(`${name}님이 입장했습니다.`);
    this.broadcastState();
    this.sendCatchUp(id);
    return p;
  }

  /**
   * 연결 끊김 처리. RECONNECT_GRACE_MS 동안 자리를 비워두고(점수 유지) 기다린다.
   * 출제자였다면 턴은 즉시 끝내고(drawerLeft), 호스트였다면 접속 중인 다음 사람에게 넘긴다.
   * @returns {boolean} 처리 여부
   */
  markDisconnected(id) {
    const p = this.getPlayer(id);
    if (!p || !p.connected) return false;
    if (RECONNECT_GRACE_MS <= 0) return this.removePlayer(id, 'left');

    p.connected = false;
    p.socketId = null;
    this.clearGrace(p);
    const secs = Math.round(RECONNECT_GRACE_MS / 1000);
    this.systemMessage(`${p.name}님의 연결이 끊어졌습니다. ${secs}초 안에 돌아오면 이어서 할 수 있어요.`);

    // 방장이 끊겨도 바로 넘기지 않는다: 새로고침·배포 뒤 재접속처럼 곧 돌아오는 경우가 대부분이라,
    // broadcastState → checkHost() 가 HOST_RETURN_MS 동안 기다렸다가 그래도 없으면 접속 중인 사람에게 넘긴다.
    this.startGrace(p);

    // 인원 부족은 여기서 바로 끝내지 않는다: 유예 시간 안에 돌아올 수 있으므로 턴은 계속 진행하고,
    // 다음 턴으로 넘어갈 때(nextTurn) 접속 인원이 2명 미만이면 그때 게임을 끝낸다.
    if (this.phase === 'choosing' || this.phase === 'drawing') {
      if (id === this.drawerId) this.endTurn('drawerLeft');
      else if (this.phase === 'drawing' && this.allGuessed()) this.endTurn('allGuessed');
      else this.broadcastState();
    } else {
      this.broadcastState();
    }
    return true;
  }

  /**
   * 재접속: 끊긴 플레이어를 새 소켓에 다시 붙인다. playerId·점수·순서는 그대로.
   * @returns {boolean} 성공 여부
   */
  reconnect(id, socketId, { name, avatar } = {}) {
    const p = this.getPlayer(id);
    if (!p) return false;
    const wasConnected = p.connected;
    this.clearGrace(p);
    p.connected = true;
    p.socketId = socketId;
    if (name) p.name = name;
    if (avatar) p.avatar = avatar;
    if (arguments[2] && arguments[2].user !== undefined) p.userId = arguments[2].user && arguments[2].user.userId ? arguments[2].user.userId : p.userId;
    // 이미 연결돼 있던 자리를 새 소켓이 넘겨받는 경우(새로고침 경합, 다른 탭)에는 "다시 연결" 안내를 내지 않는다
    if (!wasConnected) this.systemMessage(`${p.name}님이 다시 연결되었습니다.`);
    this.broadcastState();
    this.sendCatchUp(id);
    if (this.phase === 'drawing' && p.hasGuessed && this.word) {
      this.emitTo(id, 'game:hint', { wordMask: revealAll(this.word) });
    }
    return true;
  }

  /** 방 안에서 닉네임·아바타 바꾸기. 대기실에서만(게임 중에는 채점·목록이 헷갈리지 않게). 오류 문자열 | null */
  updatePlayer(id, { name, avatar }) {
    const p = this.getPlayer(id);
    if (!p) return '방에 참가하지 않았습니다.';
    if (this.phase !== 'lobby') return '대기실에서만 바꿀 수 있어요';
    const renamed = p.name !== name;
    const old = p.name;
    p.name = name;
    p.avatar = avatar;
    if (renamed) this.systemMessage(`${old}님이 닉네임을 ${name}(으)로 바꿨습니다.`);
    this.broadcastState();
    return null;
  }

  /** 접속 중 로그인/로그아웃 반영 */
  setUser(id, user) {
    const p = this.getPlayer(id);
    if (!p) return;
    p.userId = user && user.userId ? user.userId : null;
    this.broadcastState();
  }

  /** 반응(👍/👎): drawing 중, 출제자 제외. 기록하지 않고 방 전체에 중계만 한다. */
  react(id, kind) {
    const p = this.getPlayer(id);
    if (!p) return '방에 참가하지 않았습니다.';
    if (kind !== 'up' && kind !== 'down') return null;
    if (this.phase !== 'drawing' || id === this.drawerId) return null;
    this.emitAll('react:show', { id, kind });
    return null;
  }

  /** 중간 참가자/재접속자에게 현재 진행 상황 전달 (단어/후보는 절대 포함하지 않음) */
  sendCatchUp(id) {
    const drawer = this.getPlayer(this.drawerId);
    const isDrawer = id === this.drawerId;
    if (this.phase === 'choosing') {
      // 출제자 본인이 복귀하는 경우(재시작 복원 등)에는 후보 단어도 다시 준다
      this.emitTo(id, 'game:choosing', {
        drawerId: this.drawerId,
        drawerName: drawer ? drawer.name : '',
        timeLeft: this.timeLeft,
        ...(isDrawer ? { wordOptions: this.wordOptions.slice() } : {}),
      });
    } else if (this.phase === 'drawing') {
      this.emitTo(id, 'game:drawing', {
        drawerId: this.drawerId,
        round: this.round,
        totalRounds: this.totalRounds,
        timeLeft: this.timeLeft,
        wordMask: maskWord(this.word, this.revealed),
        wordLength: Array.from(this.word).length,
        ...(isDrawer ? { word: this.word, category: this.category() } : {}), // 출제자 본인에게만 단어
        ...(!isDrawer && this.categoryRevealed ? { category: this.category() } : {}), // 이미 공개된 카테고리 힌트
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
    } else if (this.phase === 'lobby' && this.lastGameOver) {
      const me = this.getPlayer(id);
      if (me && me.atResults) this.emitTo(id, 'game:over', this.lastGameOver); // 결과 화면 보던 중 재접속
    }
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
    this.clearGrace(p);

    if (this.players.length === 0) {
      // 마지막 사람이 나감 → 호출자가 방을 삭제한다
      this.clearTimers();
      this.hostId = null;
      return true;
    }

    // 호스트 승계: 참가 순서상 다음 사람
    if (this.hostId === id) {
      const next = this.connectedPlayers()[0] || this.players[0];
      this.hostId = next.id;
    }
    if (this.settings.fixedDrawerId === id) this.settings = { ...this.settings, fixedDrawerId: null };

    this.systemMessage(
      reason === 'kicked' ? `${p.name}님이 강퇴되었습니다.` : `${p.name}님이 나갔습니다.`,
    );

    if (this.phase === 'choosing' || this.phase === 'drawing') {
      if (this.connectedPlayers().length < MIN_PLAYERS) {
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
  /** 대기실 단계 전환 (호스트, lobby). 'mode' ↔ 'settings' */
  setLobbyStep(id, step) {
    if (!this.isHost(id)) return '호스트만 단계를 바꿀 수 있습니다.';
    if (this.phase !== 'lobby') return '게임 중에는 바꿀 수 없습니다.';
    if (!LOBBY_STEPS.includes(step)) return '잘못된 단계입니다.';
    this.lobbyStep = step;
    this.broadcastState();
    return null;
  }

  /** fixed 모드의 실제 출제자 id: 지정된 사람이 방에 있으면 그 사람, 아니면 호스트 */
  fixedDrawerId() {
    const id = this.settings.fixedDrawerId;
    return id && this.getPlayer(id) ? id : this.hostId;
  }

  /** 모드별 라운드 출제 순서 */
  buildTurnOrder() {
    if (this.settings.mode === 'fixed') return [this.fixedDrawerId()];
    return this.players.map((p) => p.id);
  }

  /** 재접속을 기다리는 짧은 대기(2초) 뒤 nextTurn 재시도 */
  waitForReconnect(message) {
    if (!this._waitingNotice) {
      this._waitingNotice = true;
      this.systemMessage(message);
    }
    this.phase = 'turnEnd';
    this.setPhaseTimeout(2000, () => this.nextTurn());
    this.broadcastState();
  }

  updateSettings(id, patch) {
    if (!this.isHost(id)) return '호스트만 설정을 변경할 수 있습니다.';
    if (this.phase !== 'lobby') return '게임 중에는 설정을 변경할 수 없습니다.';
    if (!patch || typeof patch !== 'object') return '잘못된 설정 값입니다.';

    const s = { ...this.settings };
    if ('rounds' in patch) s.rounds = clampInt(patch.rounds, 1, 10, s.rounds);
    if ('drawTime' in patch) s.drawTime = clampInt(patch.drawTime, 15, 180, s.drawTime);
    if ('wordCount' in patch) s.wordCount = clampInt(patch.wordCount, 2, 5, s.wordCount);
    if ('hints' in patch) s.hints = clampInt(patch.hints, 0, 5, s.hints);
    if ('hintEndAt' in patch) s.hintEndAt = clampInt(patch.hintEndAt, 5, 60, s.hintEndAt);
    if ('customWords' in patch) {
      // 원문은 그대로 보존(입력 중 커서 튐 방지), 파싱/검증은 pickWords 시점에 수행
      const raw = typeof patch.customWords === 'string' ? patch.customWords : '';
      s.customWords = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, MAX_CUSTOM_WORDS_LEN);
    }
    if ('customWordsOnly' in patch) s.customWordsOnly = Boolean(patch.customWordsOnly);
    if ('mode' in patch && MODES.includes(patch.mode)) s.mode = patch.mode;
    if ('fixedDrawerId' in patch) {
      // 방에 있는 사람만 출제자로 지정 가능. 아니면 null(=호스트)
      s.fixedDrawerId = typeof patch.fixedDrawerId === 'string' && this.getPlayer(patch.fixedDrawerId) ? patch.fixedDrawerId : null;
    }

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
    const viewing = this.playersAtResults();
    if (viewing.length) return `아직 결과 화면을 보고 있는 사람이 있어요: ${viewing.map((p) => p.name).join(', ')}`;
    if (this.connectedPlayers().length < MIN_PLAYERS) return `게임을 시작하려면 ${MIN_PLAYERS}명 이상이 필요합니다.`;
    if (this.settings.mode === 'fixed') {
      const fd = this.getPlayer(this.fixedDrawerId());
      if (!fd || !fd.connected) return '출제자가 접속 중이어야 시작할 수 있습니다.';
    }

    this.clearTimers();
    for (const p of this.players) {
      p.score = 0;
      p.hasGuessed = false;
      p.isDrawing = false;
      p.atResults = false;
    }
    this.lastGameOver = null;
    this.usedWords = new Set();
    this.offeredWords = new Set();
    this.gallery = [];
    this.round = 1;
    this.totalRounds = this.settings.rounds;
    this.turnOrder = this.buildTurnOrder();
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
    if (this.connectedPlayers().length < MIN_PLAYERS) {
      // 유예 중인(곧 돌아올 수 있는) 사람이 있어 전체 인원은 2명 이상이면 잠시 기다린다.
      // 유예가 끝나 실제로 퇴장하면 players 가 줄어 아래 gameOver 로 내려온다.
      if (this.players.length >= MIN_PLAYERS) { this.waitForReconnect('다른 참가자의 재접속을 기다리고 있어요…'); return; }
      this.gameOver();
      return;
    }
    if (this.settings.mode === 'fixed') {
      // 지정 출제자가 끊겨 있으면 기다린다. 유예가 끝나 나가면 fixedDrawerId()가 호스트로 바뀌어 이어진다.
      const fd = this.getPlayer(this.fixedDrawerId());
      if (fd && !fd.connected) { this.waitForReconnect(`출제자 ${fd.name}님의 재접속을 기다리고 있어요…`); return; }
    }
    this._waitingNotice = false;
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
        // 새 라운드 출제 순서: 모드별 (classic: 현재 참가 순서, 중간 참가자는 여기서부터 포함 / fixed: 지정 출제자)
        this.turnOrder = this.buildTurnOrder();
        this.turnIndex = 0;
      }
      const drawerId = this.turnOrder[this.turnIndex];
      const cand = this.getPlayer(drawerId);
      if (cand && cand.connected) {
        this.beginChoosing(drawerId);
        return;
      }
      // 이미 나갔거나 연결이 끊긴 플레이어는 건너뜀
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

    // 이미 정답으로 쓰였거나 후보로 제시됐던 단어는 가능하면 다시 내지 않는다
    const exclude = new Set([...this.usedWords, ...this.offeredWords]);
    const blitz = this.settings.mode === 'blitz';
    let options = pickWords(this.settings, exclude, blitz ? 1 : this.settings.wordCount);
    for (const o of options) this.offeredWords.add(o);
    if (!options.length) options = ['사과']; // 방어: 절대 비어있지 않게
    this.wordOptions = options;
    if (blitz) {
      // 속도전: 고르는 단계 없이 곧바로 그리기 (힌트는 설정과 무관하게 없음 — beginDrawing 에서 처리)
      this.beginDrawing(options[0]);
      return;
    }
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
    // 힌트 개수는 설정값과 이 단어의 공개 가능 글자 수 중 작은 쪽. 마지막 힌트는 항상 종료 hintEndAt초 전
    const hintCount = this.settings.mode === 'blitz' ? 0 : Math.min(this.settings.hints, maxReveals(word));
    this.hintTimes = computeHintTimes(hintCount, this.drawTime, this.settings.hintEndAt);
    this.hintCount = this.hintTimes.size;
    this.categoryRevealed = false;

    const base = {
      drawerId: this.drawerId,
      round: this.round,
      totalRounds: this.totalRounds,
      timeLeft: this.timeLeft,
      wordMask: maskWord(word, this.revealed),
      wordLength: Array.from(word).length,
    };
    this.emitExcept(this.drawerId, 'game:drawing', base);
    this.emitTo(this.drawerId, 'game:drawing', { ...base, word, category: this.category() });
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
    // 마지막 초성 힌트에는 카테고리도 함께 공개한다 (사용자 단어는 카테고리가 없으므로 '방장이 낸 단어')
    const payload = { wordMask: maskWord(this.word, this.revealed) };
    if (this.revealed.size >= this.hintCount) {
      this.categoryRevealed = true;
      payload.category = this.category();
    }
    // 출제자와 이미 정답을 맞힌 사람(이미 전체 공개를 받음)은 제외하고 아직 못 맞힌 사람에게만 보낸다.
    const targets = this.players.filter((pl) => pl.id !== this.drawerId && !pl.hasGuessed).map((pl) => pl.id);
    this.emitToIds(targets, 'game:hint', payload);
  }

  /**
   * 다음 턴의 출제자 id. 현재 라운드에 남은 사람이 없으면 다음 라운드 첫 사람(참가 순서),
   * 이번이 마지막 라운드의 마지막 턴이면 null(게임 종료 예정), 대기실/게임종료 단계에서도 null.
   */
  computeNextDrawerId() {
    if (this.phase === 'lobby' || this.phase === 'gameOver' || !this.turnOrder.length) return null;
    if (this.settings.mode === 'fixed') return this.round < this.totalRounds ? this.fixedDrawerId() : null;
    for (let i = this.turnIndex + 1; i < this.turnOrder.length; i++) {
      const cand = this.getPlayer(this.turnOrder[i]);
      if (cand && cand.connected) return this.turnOrder[i];
    }
    if (this.round >= this.totalRounds) return null;
    const nextOrder = this.connectedPlayers().map((pl) => pl.id);
    return nextOrder.length ? nextOrder[0] : null;
  }

  /** 갤러리가 너무 커지면(저장소·전송 부담) 오래된 턴의 그림 데이터부터 비운다. 제시어·출제자 정보는 남긴다 */
  trimGallery() {
    const LIMIT = 1.5 * 1024 * 1024; // JSON 문자 수 기준 약 1.5MB
    let size = JSON.stringify(this.gallery).length;
    for (let i = 0; i < this.gallery.length && size > LIMIT; i++) {
      if (!this.gallery[i].ops.length) continue;
      size -= JSON.stringify(this.gallery[i].ops).length;
      this.gallery[i].ops = [];
      this.gallery[i].trimmed = true;
    }
  }

  /** 현재 단어의 카테고리 힌트 문구 */
  category() {
    return categoryOf(this.word) || '방장이 낸 단어';
  }

  /** 출제자를 제외한 모든 플레이어가 맞혔는지 */
  allGuessed() {
    const guessers = this.players.filter((p) => p.id !== this.drawerId && p.connected);
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
    if (drawer && this.phase === 'drawing' && this.settings.mode !== 'fixed') {
      // (fixed 모드의 지정 출제자는 경쟁하지 않으므로 점수를 받지 않는다)
      // 연결이 끊긴 사람은 맞힐 수 없으므로 분모에서 뺀다(단, 이미 맞힌 뒤 끊긴 사람은 분자·분모 모두 포함)
      const guessers = this.players.filter((p) => p.id !== this.drawerId && (p.connected || p.hasGuessed)).length;
      const guessed = this.players.filter((p) => p.id !== this.drawerId && p.hasGuessed).length;
      const pts = guessers > 0 ? Math.min(300, Math.max(0, Math.round((300 * guessed) / guessers))) : 0;
      drawer.score += pts;
      this.turnPoints.set(drawer.id, pts);
    }
    if (this.word) this.usedWords.add(this.word);

    // 갤러리 기록: 실제로 그림을 그린 턴만 (choosing 중 이탈 등은 제외)
    if (this.phase === 'drawing' && this.word) {
      const guessed = this.players.filter((p) => p.id !== this.drawerId && p.hasGuessed).length;
      this.gallery.push({
        round: this.round,
        word: this.word,
        category: this.category(),
        drawerId: this.drawerId,
        drawerName: drawer ? drawer.name : '',
        guessed,
        ops: this.ops.slice(),
      });
      this.trimGallery();
    }

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
    const fixed = this.settings.mode === 'fixed' ? this.getPlayer(this.fixedDrawerId()) : null;
    const ranking = this.players
      .filter((p) => !fixed || p.id !== fixed.id)
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((p) => ({ id: p.id, name: p.name, avatar: { ...p.avatar }, score: p.score }));
    this.lastGameOver = {
      ranking,
      gallery: this.gallery,
      mode: this.settings.mode,
      drawer: fixed ? { id: fixed.id, name: fixed.name, avatar: { ...fixed.avatar } } : null,
    };
    for (const p of this.players) p.atResults = true; // 각자 결과를 확인하고 직접 대기실로 돌아온다
    this.emitAll('game:over', this.lastGameOver);
    this.broadcastState();
    // 방은 바로 대기실로 돌아가되, 결과 화면을 보고 있는 사람이 있으면 새 게임은 시작할 수 없다(start 참고).
    this.backToLobby();
  }

  /** 결과 화면 닫기 (results:done). 대기실 시작 조건에 반영된다 */
  leaveResults(id) {
    const p = this.getPlayer(id);
    if (!p) return '방에 참가하지 않았습니다.';
    if (!p.atResults) return null;
    p.atResults = false;
    this.broadcastState();
    return null;
  }

  /** 아직 결과 화면을 보고 있는 접속자 이름들 */
  playersAtResults() {
    return this.players.filter((p) => p.connected && p.atResults);
  }

  /**
   * 방장이 게임을 즉시 끝내고 모두 대기실로 (결과 화면 · 갤러리 없이). choosing / drawing / turnEnd 에서만.
   * @returns {string|null} 오류 메시지 또는 null
   */
  abort(id) {
    if (!this.isHost(id)) return '방장만 게임을 끝낼 수 있어요.';
    if (this.phase === 'lobby' || this.phase === 'gameOver') return '진행 중인 게임이 없어요.';
    const host = this.getPlayer(id);
    this.lastGameOver = null;
    this.gallery = [];
    for (const p of this.players) p.atResults = false;
    this.emitAll('game:aborted', { by: host ? host.name : '' });
    this.backToLobby(`${host ? host.name : '방장'}님이 게임을 끝냈어요. 대기실로 돌아왔어요.`);
    return null;
  }

  /** lobby 복귀 (점수는 다음 game:start 까지 유지). message: 대기실로 돌아올 때 알릴 시스템 메시지 */
  backToLobby(message = '게임이 끝났어요. 결과를 확인한 뒤 대기실로 돌아와 주세요.') {
    this.clearTimers();
    this.phase = 'lobby';
    this.lobbyStep = 'settings'; // 게임이 끝나고 돌아오면 모드는 그대로, 설정 화면으로
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
    // lastGameOver 는 유지: 결과 화면을 보는 중 재접속한 사람에게 다시 보내야 한다. 다음 start() 에서 정리.
    for (const p of this.players) {
      p.isDrawing = false;
      p.hasGuessed = false;
    }
    this.broadcastState();
    this.systemMessage(message);
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
    let pts;
    if (this.settings.mode === 'blitz') {
      // 맞힌 순서로 차등 (p 는 아직 hasGuessed 로 세지 않았으므로 이전에 맞힌 사람 수 = 순위)
      const before = this.players.filter((q) => q.id !== this.drawerId && q.id !== p.id && q.hasGuessed).length;
      pts = BLITZ_RANK_POINTS[before] != null ? BLITZ_RANK_POINTS[before] : 100;
    } else {
      pts = Math.max(100, Math.round(100 + (300 * this.timeLeft) / this.drawTime));
    }
    p.score += pts;
    this.turnPoints.set(p.id, pts);

    // 정답을 맞힌 사람에게는 상단 단어 표시를 전체 공개로 바꿔 준다(본인만, 초성이 아닌 실제 글자).
    // 이후 revealHint()가 아직 못 맞힌 사람만 대상으로 하므로 이 표시가 다시 부분 힌트로 덮이지 않는다.
    this.emitTo(p.id, 'game:hint', { wordMask: revealAll(this.word) });

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
    this.persist(); // 그림 변화도 저장(300ms 스로틀). 검증 전에 예약해도 실제 저장 시점의 상태가 담긴다
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
  HOST_RETURN_MS,
  GAME_OVER_TIME,
  RECONNECT_GRACE_MS,
  MIN_PLAYERS,
  ALLOW_SOLO,
  // 테스트/재사용을 위한 순수 헬퍼
  maskWord,
  revealAll,
  hintChar,
  isHangulSyllable,
  normalizeAnswer,
  levenshtein,
  computeHintTimes,
  maxReveals,
  clampInt,
};
