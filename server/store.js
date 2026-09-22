'use strict';
/**
 * store.js — 방 상태 저장소 (배포/재시작 후 방 복원용)
 *
 * 선택 순서: STORE_URL > REDIS_URL > (없음: 메모리만, 저장 안 함)
 *  - redis:// | rediss://  → Redis 호환 서버 (Render Key Value, Upstash, Railway, 자체 호스팅 등 무엇이든)
 *  - file:<경로>           → JSON 파일 하나 (로컬 개발/테스트, 디스크가 있는 호스팅)
 *
 * 모든 구현은 같은 인터페이스: { kind, save(code, snapshot), delete(code), loadAll() → snapshot[], close() }
 * 저장 실패는 게임을 멈추지 않는다(로그만 남김).
 */
const fs = require('fs');
const path = require('path');

const KEY_PREFIX = 'draw-guess:room:';
const TTL_SEC = 3 * 60 * 60; // 방 스냅샷 보관 상한(3시간). 정상 종료된 방은 즉시 삭제된다.

/** 저장 안 함 */
function memoryStore() {
  return {
    kind: 'memory',
    async save() {},
    async delete() {},
    async loadAll() { return []; },
    async close() {},
  };
}

/** JSON 파일 저장소 (동기 쓰기 — 소규모 전용) */
function fileStore(filePath) {
  const abs = path.resolve(filePath);
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(abs, 'utf8')) || {}; } catch (e) { return {}; }
  };
  const writeAll = (obj) => {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, abs);
  };
  return {
    kind: 'file',
    async save(code, snapshot) { const all = readAll(); all[code] = snapshot; writeAll(all); },
    async delete(code) { const all = readAll(); if (code in all) { delete all[code]; writeAll(all); } },
    async loadAll() { return Object.values(readAll()); },
    async close() {},
  };
}

/** Redis 저장소 (ioredis). 연결 실패 시에도 서버는 계속 뜬다. */
function redisStore(url) {
  const Redis = require('ioredis');
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(1000 * times, 10000),
  });
  let warned = false;
  client.on('error', (err) => {
    if (!warned) { warned = true; console.warn('[store] redis error:', err.message); }
  });
  client.on('ready', () => { warned = false; console.log('[store] redis connected'); });

  return {
    kind: 'redis',
    async save(code, snapshot) {
      await client.set(KEY_PREFIX + code, JSON.stringify(snapshot), 'EX', TTL_SEC);
    },
    async delete(code) { await client.del(KEY_PREFIX + code); },
    async loadAll() {
      const out = [];
      let cursor = '0';
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', KEY_PREFIX + '*', 'COUNT', 100);
        cursor = next;
        if (keys.length) {
          const vals = await client.mget(keys);
          for (const v of vals) {
            if (!v) continue;
            try { out.push(JSON.parse(v)); } catch (e) { /* skip corrupt */ }
          }
        }
      } while (cursor !== '0');
      return out;
    },
    async close() { try { await client.quit(); } catch (e) { /* ignore */ } },
  };
}

/**
 * 환경 변수로 저장소 선택.
 * @param {NodeJS.ProcessEnv} env
 */
function createStore(env = process.env) {
  const url = env.STORE_URL || env.REDIS_URL || '';
  if (!url) return memoryStore();
  if (url.startsWith('file:')) return fileStore(url.slice('file:'.length));
  if (/^rediss?:\/\//.test(url)) return redisStore(url);
  console.warn(`[store] unknown STORE_URL scheme, falling back to memory: ${url.split(':')[0]}`);
  return memoryStore();
}

module.exports = { createStore, KEY_PREFIX, TTL_SEC };
