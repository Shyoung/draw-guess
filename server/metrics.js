'use strict';
/**
 * metrics.js — 최소 이용 지표
 *
 * 원칙: 닉네임·IP·채팅 내용·계정 id 는 남기지 않는다. 방 코드와 숫자만.
 *  - 이벤트 한 줄: stdout 에 `[metric] {"ev":..., "ts":..., ...}` (호스팅 로그에서 grep)
 *  - 일별 누적: store.bumpStats(day, { field: n }) — Redis 면 해시 `draw-guess:stats:YYYY-MM-DD`(STATS_TTL_DAYS 보관),
 *    메모리/파일 저장소면 프로세스 안에서만. `/admin/stats?key=` 로 조회(index.js)
 *  - 날짜 경계는 한국 시간(UTC+9)
 *
 * 이벤트와 누적 필드:
 *   room_created       { room, ref, loggedIn, fromWordSetLink }                 rooms, ref:<ref>, rooms_from_wsl(단어 세트 링크로 만든 방)
 *   player_joined      { room, via, ref, midGame, size }                        joins, joins_link|joins_code, joins_mid
 *   game_started       { room, mode, players, rounds, drawTime, customWords }   starts, starts_<mode>, players_start
 *   game_completed     { room, mode, players, turns, durationSec, galleryTrimmed, bytesOut }
 *                                                                              completes, players_complete, turns, duration_sec, bytes_out
 *   game_aborted       { room, players, turnsPlayed, reason, durationSec, bytesOut }   aborts, aborts_<reason>, bytes_out
 *   room_closed        { room, gamesPlayed, peakPlayers, lifetimeSec, bytesOut }        closed, lifetime_sec, bytes_out_lobby
 *   room_full_rejected { room }                                                 full
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 한국 시간 기준 YYYY-MM-DD */
function dayOf(now = Date.now()) {
  return new Date(now + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 이벤트 → 일별 누적 필드 */
function bumpsFor(ev, f) {
  switch (ev) {
    case 'room_created': return { rooms: 1, ...(f.ref ? { ['ref:' + f.ref]: 1 } : {}), ...(f.fromWordSetLink === true ? { rooms_from_wsl: 1 } : {}) };
    case 'player_joined': return { joins: 1, [f.via === 'link' ? 'joins_link' : 'joins_code']: 1, ...(f.midGame ? { joins_mid: 1 } : {}) };
    case 'game_started': return { starts: 1, ['starts_' + f.mode]: 1, players_start: f.players };
    case 'game_completed': return { completes: 1, players_complete: f.players, turns: f.turns, duration_sec: f.durationSec, bytes_out: f.bytesOut };
    case 'game_aborted': return { aborts: 1, ['aborts_' + f.reason]: 1, bytes_out: f.bytesOut };
    case 'room_closed': return { closed: 1, lifetime_sec: f.lifetimeSec, bytes_out_lobby: f.bytesOut };
    case 'room_full_rejected': return { full: 1 };
    default: return null;
  }
}

/**
 * @param {{ bumpStats(day:string, incr:Record<string,number>):Promise<void>, loadStats(days:number):Promise<object[]> }} store
 */
function createMetrics(store, log = console.log) {
  return {
    dayOf,
    /** 이벤트 기록. 실패해도 게임을 멈추지 않는다 */
    event(ev, fields = {}) {
      const rec = { ev, ts: new Date().toISOString(), ...fields };
      log('[metric] ' + JSON.stringify(rec));
      const bumps = bumpsFor(ev, fields);
      if (!bumps) return;
      const clean = {};
      for (const [k, v] of Object.entries(bumps)) if (Number.isFinite(v) && v !== 0) clean[k] = Math.round(v);
      if (!Object.keys(clean).length) return;
      Promise.resolve().then(() => store.bumpStats(dayOf(), clean)).catch((err) => log('[metric] stats save failed: ' + (err && err.message)));
    },
    /** 최근 days 일 (오늘 포함, 최신순) */
    stats(days) { return store.loadStats(days); },
  };
}

module.exports = { createMetrics, dayOf, bumpsFor };
