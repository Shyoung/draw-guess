'use strict';
/**
 * auth.js — Supabase 로그인 토큰 검증 (선택 기능)
 *
 * 환경 변수
 *   SUPABASE_URL              예) https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY         공개 키. 클라이언트에 /config.js 로 내려준다
 *   SUPABASE_SERVICE_ROLE_KEY 서버 전용 비밀 키. 토큰 검증(auth.getUser)에 쓴다. 절대 클라이언트로 내보내지 않는다
 *
 * 셋 다 있어야 켜진다. 없으면 enabled=false 이고 모든 사용자는 게스트로 동작한다(기존과 동일).
 * 토큰 검증은 Supabase Auth 서버에 물어보는 방식(getUser)이라 키 회전/알고리즘(HS256·ES256)과 무관하게 동작한다.
 * 같은 토큰은 60초 동안 결과를 캐시해 재접속 폭주 때 호출을 줄인다.
 */
const CACHE_TTL_MS = 60 * 1000;

function createAuth(env = process.env) {
  const url = env.SUPABASE_URL || '';
  const anonKey = env.SUPABASE_ANON_KEY || '';
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const enabled = Boolean(url && anonKey && serviceKey);

  let admin = null;
  if (enabled) {
    try {
      const { createClient } = require('@supabase/supabase-js');
      admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch (err) {
      console.warn('[auth] supabase client init failed:', err.message);
    }
  }

  /** token → { userId, email, name, avatarUrl } | null. 캐시 포함 */
  const cache = new Map();
  async function verifyToken(token) {
    if (!enabled || !admin || typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
    const hit = cache.get(token);
    if (hit && hit.expires > Date.now()) return hit.user;
    let user = null;
    try {
      const { data, error } = await admin.auth.getUser(token);
      if (!error && data && data.user) {
        const u = data.user;
        const meta = u.user_metadata || {};
        user = {
          userId: u.id,
          email: u.email || null,
          name: meta.nickname || meta.name || meta.full_name || meta.preferred_username || null,
          avatarUrl: meta.avatar_url || meta.picture || null,
          provider: (u.app_metadata && u.app_metadata.provider) || null,
        };
      }
    } catch (err) {
      console.warn('[auth] getUser failed:', err.message);
    }
    cache.set(token, { user, expires: Date.now() + CACHE_TTL_MS });
    if (cache.size > 2000) { // 단순 상한: 오래된 것부터 정리
      const now = Date.now();
      for (const [k, v] of cache) { if (v.expires <= now) cache.delete(k); if (cache.size <= 1500) break; }
    }
    return user;
  }

  /**
   * 회원 탈퇴: 업로드한 프로필 사진(avatars/<userId>/*)을 지우고 Auth 사용자를 삭제한다.
   * profiles · word_sets 는 auth.users 에 on delete cascade 로 묶여 함께 지워진다.
   */
  async function deleteUser(userId) {
    if (!enabled || !admin) throw new Error('로그인 기능이 꺼져 있어요');
    if (typeof userId !== 'string' || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('잘못된 사용자');
    const bucket = admin.storage.from('avatars');
    for (let i = 0; i < 5; i++) { // 한 번에 최대 1000개 — 보통 1~2개
      const { data: files, error } = await bucket.list(userId, { limit: 1000 });
      if (error) throw error;
      if (!files || !files.length) break;
      const { error: rmErr } = await bucket.remove(files.map((f) => `${userId}/${f.name}`));
      if (rmErr) throw rmErr;
      if (files.length < 1000) break;
    }
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
    for (const [k, v] of cache) if (v.user && v.user.userId === userId) cache.delete(k);
  }

  /** Supabase 무료 프로젝트 일시 정지(7일 무활동) 방지용 가벼운 조회 */
  async function ping() {
    if (!enabled || !admin) return false;
    const { error } = await admin.from('profiles').select('user_id', { head: true, count: 'exact' }).limit(1);
    if (error) throw error;
    return true;
  }

  /** 클라이언트에 내려줄 공개 설정 (비밀 키 없음) */
  function publicConfig() {
    return enabled ? { supabaseUrl: url, supabaseAnonKey: anonKey } : {};
  }

  return { enabled, verifyToken, publicConfig, deleteUser, ping };
}

module.exports = { createAuth };
