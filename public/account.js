/* =====================================================================
   account.js — Supabase 로그인 · 프로필 · 사용자 단어 세트 (선택 기능)

   /config.js 가 내려준 window.APP_CONFIG 에 supabaseUrl / supabaseAnonKey 가 있을 때만 켜진다.
   없으면 isEnabled() 는 false 이고, 모든 데이터 호출은 안전하게 reject 되어 게임(게스트)은 지금과 똑같이 동작한다.
   supabase-js(UMD) 는 켜져 있을 때만 CDN 에서 동적으로 로드한다 → 꺼진 배포에서는 네트워크 요청이 없다.

   이 모듈은 상태(session / user / profile)와 DB 호출만 담당하고, UI 는 client.js 가 그린다.

   window.Account = {
     init(): Promise<boolean>            설정이 있으면 라이브러리 로드 → 클라이언트 생성 → 세션 복원. 성공 시 true
     isEnabled(): boolean                로그인 기능이 켜져 있고 준비됐는가
     getSession(), getUser(), getProfile(), getToken()
     signIn('google'|'kakao'): Promise   OAuth 리다이렉트 시작 (redirectTo = origin + pathname)
     signOut(): Promise
     updateProfile({ nickname?, avatar_emoji?, avatar_color? }): Promise<profile>
     listWordSets(): Promise<[{ id, name, words[], updated_at, created_at }]>
     saveWordSet({ id?, name, words: string[]|string }): Promise<set>   id 있으면 수정, 없으면 생성
     deleteWordSet(id): Promise<true>
     parseWords(text): { words: string[], invalid: string[] }         게임 서버와 같은 규칙(쉼표 구분·1~20자·중복 제거)
     onChange(cb): unsubscribe           cb({ enabled, session, user, profile, token }) — 로그인/로그아웃/토큰 갱신/프로필 변경 시
     MAX_SETS: 20, MAX_WORDS: 500
   }
   ===================================================================== */
(function () {
  'use strict';

  var LIB_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  var MAX_SETS = 20, MAX_WORDS = 500, MAX_NAME = 30, MAX_NICK = 12;

  var enabled = false;      // 클라이언트가 만들어져 실제로 쓸 수 있는 상태
  var client = null, session = null, user = null, profile = null;
  var listeners = [], initPromise = null, profileLoading = null;

  function config() {
    var c = window.APP_CONFIG;
    if (!c || typeof c !== 'object') return null;
    if (typeof c.supabaseUrl !== 'string' || !c.supabaseUrl || typeof c.supabaseAnonKey !== 'string' || !c.supabaseAnonKey) return null;
    return c;
  }
  function hasLib() { return !!(window.supabase && typeof window.supabase.createClient === 'function'); }
  function loadLib() {
    if (hasLib()) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LIB_URL; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = function () { if (hasLib()) resolve(); else reject(new Error('supabase 라이브러리를 찾을 수 없어요')); };
      s.onerror = function () { reject(new Error('supabase 라이브러리를 불러오지 못했어요')); };
      document.head.appendChild(s);
    });
  }

  function errMsg(e, fallback) {
    var m = e && (e.message || e.error_description || e.msg || e.details);
    return m ? String(m) : fallback;
  }
  function fail(msg) { return Promise.reject(new Error(msg)); }
  /** supabase 응답 { data, error } → error 면 throw(메시지 그대로 — RLS/트리거 메시지가 UI 토스트로 올라간다) */
  function unwrap(res) {
    if (res && res.error) throw new Error(errMsg(res.error, '요청에 실패했어요'));
    return res ? res.data : null;
  }
  function snapshot() {
    return { enabled: enabled, session: session, user: user, profile: profile, token: session && session.access_token ? session.access_token : null };
  }
  function notify() {
    var snap = snapshot();
    listeners.slice().forEach(function (fn) { try { fn(snap); } catch (e) { console.error('[account] listener', e); } });
  }
  function toUser(u) {
    if (!u || !u.id) return null;
    var meta = u.user_metadata || {}, app = u.app_metadata || {};
    return {
      id: u.id,
      email: u.email || null,
      provider: app.provider || null,
      name: meta.nickname || meta.name || meta.full_name || meta.preferred_username || null,
      avatarUrl: meta.avatar_url || meta.picture || null
    };
  }

  function setSession(s) {
    var prevUid = user ? user.id : null;
    session = s && s.access_token ? s : null;
    user = toUser(session ? session.user : null);
    var uid = user ? user.id : null;
    if (uid !== prevUid) {
      profile = null; profileLoading = null;
      if (uid) loadProfile();
    }
    notify();
  }

  /** 프로필 행 조회. 가입 트리거가 만들지 못한 경우 소셜 프로필로 직접 만든다(RLS: 본인 insert 허용) */
  function loadProfile() {
    if (!client || !user) return Promise.resolve(null);
    var uid = user.id, u = user;
    var p = client.from('profiles').select('*').eq('user_id', uid).maybeSingle().then(unwrap)
      .then(function (row) {
        if (row) return row;
        var nick = String(u.name || '플레이어').trim().slice(0, MAX_NICK) || '플레이어';
        return client.from('profiles').insert({ user_id: uid, nickname: nick, avatar_url: u.avatarUrl || null }).select().single().then(unwrap);
      })
      .then(function (row) {
        if (user && user.id === uid) { profile = row || null; notify(); }
        return profile;
      })
      .catch(function (e) {
        console.warn('[account] profile load failed:', errMsg(e, e));
        if (user && user.id === uid) { profile = null; notify(); }
        return null;
      });
    profileLoading = p;
    return p;
  }

  /** OAuth 리다이렉트로 돌아온 뒤 남는 #access_token=… / ?code=… 를 주소창에서 지운다(?room= 등 다른 쿼리는 유지) */
  function cleanUrl() {
    try {
      var changed = false;
      var h = location.hash || '';
      if (/(^#|[&#])(access_token|refresh_token|provider_token|error|error_description)=/.test(h)) changed = true;
      var q = new URLSearchParams(location.search);
      if (session && q.has('code')) { q.delete('code'); changed = true; }
      if (!changed) return;
      var qs = q.toString();
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : ''));
    } catch (e) { /* ignore */ }
  }

  function init() {
    if (initPromise) return initPromise;
    var c = config();
    if (!c) { initPromise = Promise.resolve(false); return initPromise; }
    initPromise = loadLib().then(function () {
      client = window.supabase.createClient(c.supabaseUrl, c.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      enabled = true;
      try {
        client.auth.onAuthStateChange(function (event, s) {
          setSession(s);
          if (s) cleanUrl();
        });
      } catch (e) { console.warn('[account] onAuthStateChange failed:', errMsg(e, e)); }
      return client.auth.getSession();
    }).then(function (res) {
      var s = res && res.data ? res.data.session : null;
      setSession(s);
      cleanUrl();
      return true;
    }).catch(function (e) {
      console.warn('[account] init failed:', errMsg(e, e));
      enabled = false; client = null; session = null; user = null; profile = null;
      notify();
      return false;
    });
    return initPromise;
  }

  function requireLogin() {
    if (!enabled || !client) return fail('로그인 기능이 꺼져 있어요');
    if (!user) return fail('로그인이 필요해요');
    return null;
  }

  function signIn(provider) {
    if (!enabled || !client) return fail('로그인 기능이 꺼져 있어요');
    if (provider !== 'google' && provider !== 'kakao') return fail('지원하지 않는 로그인 방식이에요');
    var redirectTo = location.origin + location.pathname;
    return Promise.resolve().then(function () {
      return client.auth.signInWithOAuth({ provider: provider, options: { redirectTo: redirectTo } });
    }).then(unwrap);
  }
  function signOut() {
    if (!enabled || !client) return fail('로그인 기능이 꺼져 있어요');
    return Promise.resolve().then(function () { return client.auth.signOut(); })
      .then(function (res) {
        // 서버 세션 만료 등으로 실패해도 로컬은 게스트로 돌린다
        if (res && res.error) console.warn('[account] signOut:', errMsg(res.error, res.error));
        setSession(null);
        return true;
      });
  }

  function updateProfile(patch) {
    var err = requireLogin(); if (err) return err;
    var p = {};
    if (patch && typeof patch.nickname === 'string') {
      var n = patch.nickname.trim().replace(/\s+/g, ' ').slice(0, MAX_NICK);
      if (!n) return fail('닉네임은 1~12자예요');
      p.nickname = n;
    }
    if (patch && 'avatar_emoji' in patch) p.avatar_emoji = patch.avatar_emoji ? String(patch.avatar_emoji).slice(0, 8) : null;
    if (patch && 'avatar_color' in patch) p.avatar_color = /^#[0-9a-fA-F]{6}$/.test(String(patch.avatar_color || '')) ? patch.avatar_color : null;
    if (!Object.keys(p).length) return Promise.resolve(profile);
    var uid = user.id;
    return Promise.resolve(profileLoading).then(function () {
      return client.from('profiles').update(p).eq('user_id', uid).select().single();
    }).then(unwrap).then(function (row) {
      if (user && user.id === uid) { profile = row || Object.assign({}, profile || {}, p, { user_id: uid }); notify(); }
      return profile;
    });
  }

  /** 게임 서버(server/words.js parseCustomWords)와 같은 규칙: 쉼표 구분 · NFC · trim · 연속 공백 1개 · 1~20자(코드포인트) · 대소문자 무시 중복 제거 */
  function parseWords(text) {
    var out = [], invalid = [], seen = {};
    String(text == null ? '' : text).split(',').forEach(function (raw) {
      var w = raw;
      try { w = w.normalize('NFC'); } catch (e) { /* ignore */ }
      w = w.trim().replace(/\s+/g, ' ');
      if (!w) return;
      var len = Array.from(w).length;
      if (len < 1 || len > 20) { invalid.push(w); return; }
      var key = w.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1; out.push(w);
    });
    return { words: out, invalid: invalid };
  }
  function normSet(r) {
    if (!r || typeof r !== 'object') return null;
    return {
      id: r.id, name: String(r.name || ''),
      words: Array.isArray(r.words) ? r.words.map(String) : [],
      is_public: !!r.is_public, created_at: r.created_at || null, updated_at: r.updated_at || r.created_at || null
    };
  }

  function listWordSets() {
    var err = requireLogin(); if (err) return err;
    return client.from('word_sets').select('id,name,words,is_public,created_at,updated_at')
      .eq('owner_id', user.id).order('updated_at', { ascending: false })
      .then(unwrap).then(function (rows) { return (Array.isArray(rows) ? rows : []).map(normSet).filter(Boolean); });
  }
  function saveWordSet(set) {
    var err = requireLogin(); if (err) return err;
    set = set || {};
    var name = String(set.name || '').trim().replace(/\s+/g, ' ');
    if (!name) return fail('세트 이름을 입력해주세요');
    if (Array.from(name).length > MAX_NAME) return fail('세트 이름은 30자까지예요');
    var words = Array.isArray(set.words) ? parseWords(set.words.join(',')).words : parseWords(set.words).words;
    if (!words.length) return fail('단어를 1개 이상 입력해주세요 (각 1~20자)');
    if (words.length > MAX_WORDS) return fail('단어는 세트당 500개까지 저장할 수 있어요');
    var q = set.id
      ? client.from('word_sets').update({ name: name, words: words }).eq('id', set.id).eq('owner_id', user.id)
      : client.from('word_sets').insert({ owner_id: user.id, name: name, words: words });
    return q.select().single().then(unwrap).then(normSet);
  }
  function deleteWordSet(id) {
    var err = requireLogin(); if (err) return err;
    if (!id) return fail('삭제할 세트를 찾을 수 없어요');
    return client.from('word_sets').delete().eq('id', id).eq('owner_id', user.id).then(unwrap).then(function () { return true; });
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function () { listeners = listeners.filter(function (f) { return f !== cb; }); };
  }

  window.Account = {
    init: init,
    isEnabled: function () { return enabled && !!client; },
    getSession: function () { return session; },
    getUser: function () { return user; },
    getProfile: function () { return profile; },
    getToken: function () { return session && session.access_token ? session.access_token : null; },
    signIn: signIn,
    signOut: signOut,
    updateProfile: updateProfile,
    listWordSets: listWordSets,
    saveWordSet: saveWordSet,
    deleteWordSet: deleteWordSet,
    parseWords: parseWords,
    onChange: onChange,
    MAX_SETS: MAX_SETS,
    MAX_WORDS: MAX_WORDS
  };
})();
