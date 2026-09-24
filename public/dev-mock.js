/* dev-mock.js — 개발용 가짜 io(). index.html?mock=1 로 열면 client.js 앞에 로드된다.
   ?mock=1&scene=<label> 을 주면 해당 단계까지 즉시 진행한 뒤 정상 속도로 이어간다.
   labels: lobby, choosing, drawing, hint, guessed, turnEnd, drawer, mydraw, gameOver, backToLobby
   &stay=1        : 대기실(lobby)에서 자동 진행을 멈춘다(게임 시작을 누를 때까지). 설정/내 정보 UI 확인용
   &auth=1        : 가짜 window.supabase + window.APP_CONFIG 를 설치해 로그인 UI 를 켠다(네트워크 없음, 메모리 DB).
                    기본은 로그인된 상태로 시작. &auth_state=out 이면 로그아웃 상태로 시작. window.__mockAuth 로 상태 확인
                    모크 사용자는 소셜 사진(인라인 SVG data URL)을 가진다. &auth_photo=0 이면 사진 없음.
                    storage.from('avatars').upload/getPublicUrl/remove 는 메모리에 blob 을 두고 blob: URL 을 공개 URL 로 준다
                    (window.__mockAuth.storage.avatars[path]). 실제 서버라면 허용 호스트가 아니라 img 를 버리겠지만 모크 소켓은 서버를 거치지 않는다
                    그림 보관: tables.drawings(100장 제한) + storage.drawings(createSignedUrls → blob: URL, download → Blob).
                    &drawings=0 이면 drawings 테이블이 없는 것처럼(0004 실행 전) PGRST205 오류를 돌려준다
   window.__mockFire(ev, payload) : 서버 → 클라이언트 이벤트를 흉내 낸다(테스트용, 예: game:over) */
(function () {
  var handlers = {}, ME = 'me', chosen = null;
  var qs = new URLSearchParams(location.search);
  var stayLobby = qs.get('stay') === '1';
  var authMock = qs.get('auth') === '1';
  var mockSession = null;

  // ---- 가짜 Supabase: auth(getSession/onAuthStateChange/signInWithOAuth/signOut) + 최소 쿼리 빌더(from().select/insert/update/delete/eq/order/single/maybeSingle) ----
  if (authMock) {
    window.APP_CONFIG = { supabaseUrl: 'https://mock.supabase.local', supabaseAnonKey: 'mock-anon-key' };
    var authListeners = [];
    // 소셜 프로필 사진 대용: 하늘색 배경의 사람 실루엣 SVG
    var SOCIAL_PHOTO = qs.get('auth_photo') === '0' ? null : 'data:image/svg+xml,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#6fb7ff"/>' +
      '<circle cx="32" cy="25" r="12" fill="#fff"/><path d="M10 64c2-14 11-21 22-21s20 7 22 21z" fill="#fff"/></svg>');
    var mockUser = { id: 'mock-user-1', email: 'mock@example.com', app_metadata: { provider: 'google' }, user_metadata: { name: '모크유저', avatar_url: SOCIAL_PHOTO || '' } };
    var makeSession = function () { return { access_token: 'mock-access-token-' + Date.now(), user: mockUser }; };
    // 실제 supabase-js 처럼 세션이 있으면 localStorage 에 sb-…-auth-token 을 둔다(client.js 가 "세션 복원 중" 여부를 짐작하는 데 쓴다)
    var SESSION_KEY = 'sb-mock-auth-token';
    var markSession = function () { try { if (mockSession) localStorage.setItem(SESSION_KEY, '1'); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } };
    if (qs.get('auth_state') !== 'out') mockSession = makeSession();
    markSession();
    var nowIso = new Date().toISOString();
    var tables = {
      drawings: [],
      profiles: [{ user_id: 'mock-user-1', nickname: '모크유저', avatar_url: SOCIAL_PHOTO, social_avatar_url: SOCIAL_PHOTO, avatar_mode: SOCIAL_PHOTO ? 'photo' : 'emoji', avatar_emoji: null, avatar_color: null, created_at: nowIso, updated_at: nowIso }],
      word_sets: []
    };
    // 가짜 Storage: bucket → { path: { blob, type, size, url } }. RLS 흉내: 로그인 · 본인 폴더(<uid>/…) · 1MB · jpeg/png/webp
    var storage = { avatars: {}, drawings: {} };
    var noDrawings = qs.get('drawings') === '0';
    var later10 = function (v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 10); }); };
    var storageBucket = function (name) {
      var files = storage[name] || (storage[name] = {});
      var denied = function (msg) { return later10({ data: null, error: { message: msg, statusCode: '403' } }); };
      var ownPath = function (p) { return !!mockSession && String(p || '').split('/')[0] === mockSession.user.id; };
      return {
        upload: function (path, blob, opts) {
          if (!ownPath(path)) return denied('new row violates row-level security policy');
          var type = (opts && opts.contentType) || (blob && blob.type) || '';
          if (!blob || typeof blob.size !== 'number') return denied('invalid file');
          if (blob.size > 1048576) return denied('The object exceeded the maximum allowed size');
          if (['image/jpeg', 'image/png', 'image/webp'].indexOf(type) === -1) return denied('mime type ' + type + ' is not supported');
          if (files[path] && !(opts && opts.upsert)) return denied('The resource already exists');
          files[path] = { blob: blob, type: type, size: blob.size, url: URL.createObjectURL(blob) };
          return later10({ data: { path: path, fullPath: name + '/' + path }, error: null });
        },
        createSignedUrls: function (paths) {
          if (!mockSession) return denied('not authenticated');
          return later10({ data: (paths || []).map(function (p) {
            var f = ownPath(p) ? files[p] : null;
            return f ? { path: p, signedUrl: f.url, error: null } : { path: p, signedUrl: null, error: 'Object not found' };
          }), error: null });
        },
        download: function (path) {
          var f = ownPath(path) ? files[path] : null;
          return f ? later10({ data: f.blob, error: null }) : denied('Object not found');
        },
        getPublicUrl: function (path) {
          var f = files[path];
          return { data: { publicUrl: f ? f.url : 'https://mock.supabase.local/storage/v1/object/public/' + name + '/' + path } };
        },
        remove: function (paths) {
          var out = [];
          (paths || []).forEach(function (p) { if (ownPath(p) && files[p]) { delete files[p]; out.push({ name: p }); } });
          return later10({ data: out, error: null });
        }
      };
    };
    var seq = 1;
    var clone = function (r) { return JSON.parse(JSON.stringify(r)); };
    var emitAuth = function (ev) { var s = mockSession; authListeners.slice().forEach(function (fn) { setTimeout(function () { fn(ev, s); }, 0); }); };
    var ok = function (data) { return Promise.resolve({ data: data, error: null }); };
    var builder = function (table) {
      var rows = tables[table] || (tables[table] = []);
      var op = 'select', payload = null, filters = [], order = null, single = false, maybe = false, returning = false;
      function match(r) { return filters.every(function (f) { return f[2] === 'in' ? f[1].indexOf(r[f[0]]) !== -1 : r[f[0]] === f[1]; }); }
      function run() {
        var now = new Date().toISOString(), out;
        try {
          if (table === 'drawings' && noDrawings) return { data: null, error: { message: "Could not find the table 'public.drawings' in the schema cache", code: 'PGRST205' } };
          if (op === 'select') {
            out = rows.filter(match).map(clone);
            if (order) out.sort(function (a, b) { var x = a[order.key], y = b[order.key]; return (x < y ? -1 : x > y ? 1 : 0) * (order.asc ? 1 : -1); });
          } else if (op === 'insert') {
            out = [];
            (Array.isArray(payload) ? payload : [payload]).forEach(function (v) {
              if (table === 'drawings') {
                if (!mockSession || v.owner_id !== mockSession.user.id || String(v.path || '').split('/')[0] !== v.owner_id) throw new Error('new row violates row-level security policy for table "drawings"');
                if (rows.filter(function (r) { return r.owner_id === v.owner_id; }).length >= 100) throw new Error('그림은 100장까지 보관할 수 있어요');
              }
              if (table === 'word_sets') {
                if (rows.filter(function (r) { return r.owner_id === v.owner_id; }).length >= 20) throw new Error('단어 세트는 20개까지 만들 수 있어요');
                if ((v.words || []).length > 500) throw new Error('new row for relation "word_sets" violates check constraint "word_sets_words_check"');
              }
              var row = Object.assign(table === 'word_sets' ? { id: 'ws-' + (seq++), is_public: false } : table === 'drawings' ? { id: 'dr-' + (seq++) } : {}, { created_at: now, updated_at: now }, v);
              if (table === 'drawings') { now = new Date(Date.parse(now) + 1).toISOString(); } // 같은 ms 에 여러 장이어도 순서가 갈리도록
              rows.push(row); out.push(clone(row));
            });
          } else if (op === 'update') {
            out = [];
            rows.forEach(function (r) { if (match(r)) { Object.assign(r, payload, { updated_at: now }); out.push(clone(r)); } });
          } else if (op === 'delete') {
            out = [];
            for (var i = rows.length - 1; i >= 0; i--) if (match(rows[i])) out.push(rows.splice(i, 1)[0]);
            if (!returning) out = null;
          }
          if (single) { if (!out || out.length !== 1) throw new Error('JSON object requested, multiple (or no) rows returned'); out = out[0]; }
          else if (maybe) { out = out && out.length ? out[0] : null; }
          return { data: out, error: null };
        } catch (e) { return { data: null, error: { message: e.message, code: 'MOCK' } }; }
      }
      var b = {
        select: function () { if (op !== 'select') returning = true; return b; },
        insert: function (v) { op = 'insert'; payload = v; return b; },
        update: function (v) { op = 'update'; payload = v; return b; },
        upsert: function (v) { op = 'insert'; payload = v; return b; },
        delete: function () { op = 'delete'; return b; },
        eq: function (k, v) { filters.push([k, v]); return b; },
        in: function (k, v) { filters.push([k, Array.isArray(v) ? v : [], 'in']); return b; },
        order: function (k, o) { order = { key: k, asc: !o || o.ascending !== false }; return b; },
        limit: function () { return b; },
        single: function () { single = true; return b; },
        maybeSingle: function () { maybe = true; return b; },
        then: function (res, rej) { return new Promise(function (r) { setTimeout(function () { r(run()); }, 10); }).then(res, rej); }
      };
      return b;
    };
    window.supabase = {
      createClient: function () {
        return {
          auth: {
            getSession: function () { return ok({ session: mockSession }); },
            onAuthStateChange: function (fn) {
              authListeners.push(fn);
              return { data: { subscription: { unsubscribe: function () { authListeners = authListeners.filter(function (f) { return f !== fn; }); } } } };
            },
            signInWithOAuth: function (opts) {
              mockUser.app_metadata.provider = (opts && opts.provider) || 'google';
              mockSession = makeSession(); markSession(); emitAuth('SIGNED_IN');
              return ok({ provider: opts && opts.provider, url: null });
            },
            signOut: function () { mockSession = null; markSession(); emitAuth('SIGNED_OUT'); return ok(null); }
          },
          from: builder,
          storage: { from: storageBucket }
        };
      }
    };
    window.__mockAuth = { tables: tables, storage: storage, socialPhoto: SOCIAL_PHOTO, session: function () { return mockSession; }, deleted: false };
    // 회원 탈퇴(게임 서버 POST /api/account/delete) 흉내: 토큰 확인 → 본인 행·파일 삭제
    var realFetch = window.fetch ? window.fetch.bind(window) : null;
    var jsonRes = function (status, body) { return Promise.resolve(new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json' } })); };
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/api\/account\/delete$/.test(String(url).split('?')[0])) {
        var h = (init && init.headers) || {};
        var bearer = h.Authorization || h.authorization || '';
        if (!mockSession || bearer !== 'Bearer ' + mockSession.access_token) return jsonRes(401, { ok: false, error: '다시 로그인한 뒤 시도해주세요' });
        if (qs.get('delete_fail') === '1') return jsonRes(500, { ok: false, error: '탈퇴 처리에 실패했어요. 잠시 후 다시 시도해주세요' });
        var uid = mockSession.user.id;
        ['profiles', 'word_sets', 'drawings'].forEach(function (t) {
          var key = t === 'profiles' ? 'user_id' : 'owner_id';
          for (var i = tables[t].length - 1; i >= 0; i--) if (tables[t][i][key] === uid) tables[t].splice(i, 1);
        });
        ['avatars', 'drawings'].forEach(function (bk) { Object.keys(storage[bk]).forEach(function (p) { if (p.split('/')[0] === uid) delete storage[bk][p]; }); });
        window.__mockAuth.deleted = true;
        return jsonRes(200, { ok: true });
      }
      return realFetch ? realFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
    };
    console.log('[mock] fake supabase installed (auth=1)');
  }
  window.__mockFire = function (ev, payload) { fire(ev, payload); };
  function fire(ev, payload) {
    (handlers[ev] || []).forEach(function (fn) { try { fn(payload); } catch (e) { console.error('[mock]', ev, e); } });
  }
  var av = function (e, c) { return { emoji: e, color: c }; };
  var players = [
    { id: ME, name: '나', avatar: av('😀', '#bae1ff'), score: 0, isDrawing: false, hasGuessed: false },
    { id: 'p2', name: '토끼', avatar: av('🐰', '#ffb3ba'), score: 0, isDrawing: false, hasGuessed: false },
    { id: 'p3', name: '여우', avatar: av('🦊', '#ffdfba'), score: 0, isDrawing: false, hasGuessed: false },
    { id: 'p4', name: '판다판다판다판다', avatar: av('🐼', '#baffc9'), score: 0, isDrawing: false, hasGuessed: false }
  ];
  var room = { roomCode: 'MOCK', hostId: ME, phase: 'lobby', round: 0, totalRounds: 3, drawerId: null,
    settings: { rounds: 3, drawTime: 80, wordCount: 3, hints: 2, hintEndAt: 15, customWords: '', customWordsOnly: false, mode: 'classic', fixedDrawerId: null }, lobbyStep: 'settings' };
  var timeLeft = 0, word = '';
  function st() {
    players.forEach(function (p) { p.isDrawing = p.id === room.drawerId; });
    players[0].loggedIn = authMock ? !!mockSession : false;
    // 다음 출제자(모바일 턴 띠 "다음 ○○" 확인용): 참가 순서상 현재 출제자의 다음 사람
    var di = players.findIndex(function (p) { return p.id === room.drawerId; });
    var next = (room.phase === 'choosing' || room.phase === 'drawing' || room.phase === 'turnEnd') && di >= 0 ? players[(di + 1) % players.length].id : null;
    return Object.assign({}, room, { players: players, nextDrawerId: next, fixedDrawerId: null });
  }
  function chat(kind, text, p) { fire('chat:message', p ? { id: p.id, name: p.name, avatar: p.avatar, text: text, kind: kind } : { text: text, kind: kind }); }
  function setPhase(ph, drawer) { room.phase = ph; room.drawerId = drawer || null; fire('room:state', st()); }
  function circle(cx, cy, r) { var pts = []; for (var a = 0; a <= 64; a++) pts.push([Math.round(cx + r * Math.cos(a / 32 * Math.PI)), Math.round(cy + r * Math.sin(a / 32 * Math.PI))]); return pts; }
  function fast() { return idx <= target; } // scene 빨리감기 중이면 지연 없이 실행
  function later(fn, ms) { if (fast()) fn(); else setTimeout(fn, ms); }
  function stroke(color, size, pts, i) {
    i = i || 0;
    if (i === 0) fire('draw:start', { tool: 'pen', color: color, size: size, x: pts[0][0], y: pts[0][1] });
    var chunk = pts.slice(i + 1, i + 6);
    if (chunk.length) { fire('draw:move', { pts: chunk }); later(function () { stroke(color, size, pts, i + 5); }, 25); }
    else fire('draw:end');
  }
  setInterval(function () {
    if ((room.phase === 'choosing' || room.phase === 'drawing') && timeLeft > 0) fire('game:timer', { timeLeft: --timeLeft });
  }, 1000);

  var steps = [
    { label: 'lobby', delay: 0, run: function () { setPhase('lobby'); chat('system', '나님이 방을 만들었어요'); chat('system', '토끼님이 입장했어요'); } },
    { label: 'choosing', delay: 1500, run: function () { room.round = 1; timeLeft = 15; setPhase('choosing', 'p2'); fire('game:choosing', { drawerId: 'p2', drawerName: '토끼', timeLeft: 15 }); } },
    { label: 'drawing', delay: 2000, run: function () {
      word = 'ice cream'; timeLeft = 80; setPhase('drawing', 'p2');
      fire('game:drawing', { drawerId: 'p2', round: 1, totalRounds: 3, timeLeft: 80, wordMask: '_ _ _   _ _ _ _ _', wordLength: 8 });
      fire('draw:sync', { ops: [] }); chat('system', '토끼님이 그리기 시작했어요');
      stroke('#8d5524', 8, [[330, 300], [400, 480], [470, 300], [330, 300]]);
      later(function () { stroke('#f06292', 8, circle(400, 240, 85)); }, 300);
      later(function () { fire('draw:fill', { x: 400, y: 240, color: '#f8c9a0' }); fire('draw:fill', { x: 400, y: 380, color: '#ffb74d' }); }, 1200);
      later(function () { stroke('#e53935', 6, circle(400, 150, 12)); }, 1400);
    } },
    { label: 'chat', delay: 1800, run: function () { chat('chat', '아이스크림?', players[2]); chat('chat', '콘 아닌가', players[3]); chat('close', '거의 맞았어요!'); fire('error:msg', { message: '테스트용 오류 토스트' }); } },
    { label: 'hint', delay: 1200, run: function () { fire('game:hint', { wordMask: 'i _ _   _ _ _ _ _' }); timeLeft = 40; } },
    { label: 'guessed', delay: 1200, run: function () {
      players[2].hasGuessed = true; players[2].score += 250; chat('correct', '여우님이 정답을 맞혔습니다!'); fire('player:guessed', { id: 'p3' }); fire('room:state', st());
      chat('guessed-chat', '쉽네요 ㅎㅎ', players[2]);
    } },
    { label: 'turnEnd', delay: 2000, run: function () {
      players[1].score += 100; setPhase('turnEnd', 'p2');
      fire('game:turnEnd', { word: 'ice cream', reason: 'time', deltas: [{ id: 'p3', delta: 250 }, { id: 'p2', delta: 100 }, { id: ME, delta: 0 }, { id: 'p4', delta: 0 }], timeLeft: 5 });
    } },
    { label: 'drawer', delay: 3000, run: function () {
      players.forEach(function (p) { p.hasGuessed = false; }); timeLeft = 15; setPhase('choosing', ME);
      fire('game:choosing', { drawerId: ME, drawerName: '나', timeLeft: 15, wordOptions: ['사과', '자전거', '무지개'] });
    } },
    { label: 'mydraw', manual: true, run: function () {
      word = chosen || '사과'; timeLeft = 80; setPhase('drawing', ME);
      fire('game:drawing', { drawerId: ME, round: 1, totalRounds: 3, timeLeft: 80, wordMask: '_ _', wordLength: 2, word: word });
      fire('draw:sync', { ops: [] }); chat('system', '내 차례! 그림을 그려보세요 (도구 모음 활성화)');
    } },
    { label: 'myTurnEnd', delay: 20000, run: function () {
      players[0].score += 300; players[1].score += 200; players[2].score += 150; players[3].score += 180; setPhase('turnEnd', ME);
      fire('game:turnEnd', { word: word, reason: 'allGuessed', deltas: [{ id: ME, delta: 300 }, { id: 'p2', delta: 200 }, { id: 'p4', delta: 180 }, { id: 'p3', delta: 150 }], timeLeft: 5 });
    } },
    { label: 'gameOver', delay: 3000, run: function () {
      setPhase('gameOver', null);
      var ranking = players.slice().sort(function (a, b) { return b.score - a.score; }).map(function (p) { return { id: p.id, name: p.name, avatar: p.avatar, score: p.score }; });
      var cone = [{ type: 'stroke', tool: 'pen', color: '#8d5524', size: 8, points: [[330, 300], [400, 480], [470, 300], [330, 300]] },
        { type: 'stroke', tool: 'pen', color: '#f06292', size: 8, points: circle(400, 240, 85) }, { type: 'fill', x: 400, y: 240, color: '#f8c9a0' }];
      var apple = [{ type: 'stroke', tool: 'pen', color: '#e53935', size: 10, points: circle(400, 320, 140) }, { type: 'fill', x: 400, y: 320, color: '#ef5350' },
        { type: 'stroke', tool: 'pen', color: '#6d4c41', size: 12, points: [[400, 180], [420, 110]] }];
      fire('game:over', { ranking: ranking, gallery: [
        { round: 1, word: 'ice cream', category: '음식', drawerId: 'p2', drawerName: '토끼', guessed: 3, ops: cone },
        { round: 1, word: chosen || '사과', category: '과일', drawerId: ME, drawerName: players[0].name, guessed: 3, ops: apple }
      ] });
    } },
    { label: 'backToLobby', delay: 10000, run: function () { room.round = 0; setPhase('lobby', null); chat('system', '게임이 끝났어요. 다시 시작할 수 있어요!'); } }
  ];
  var scene = (new URLSearchParams(location.search).get('scene') || '').trim();
  var target = -1; steps.forEach(function (s, i) { if (s.label === scene) target = i; });
  var idx = 0, pending = null, started = false;
  function advance() {
    var s = steps[idx]; if (!s) return;
    var fast = idx <= target;
    if ((s.manual || (stayLobby && s.label === 'choosing')) && !fast) { pending = s; return; }
    idx++;
    setTimeout(function () { s.run(); advance(); }, fast ? 0 : (s.delay || 0));
  }
  function resume(label) { if (pending && pending.label === label) { var s = pending; pending = null; idx++; s.run(); advance(); } }
  function norm(t) { return String(t || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  var sock = {
    id: ME, connected: true,
    on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return sock; },
    off: function () { return sock; },
    emit: function (ev, payload, ack) {
      if (typeof payload === 'function') { ack = payload; payload = undefined; }
      console.log('[mock] C→S', ev, payload === undefined ? '' : payload);
      if (ev === 'room:create' || ev === 'room:join') {
        if (payload && payload.name) players[0].name = payload.name; if (payload && payload.avatar) players[0].avatar = payload.avatar;
        if (ack) ack({ ok: true, roomCode: 'MOCK', playerId: ME });
        if (!started) { started = true; advance(); }
        else setTimeout(function () { fire('room:state', st()); }, 0); // 나갔다가 다시 만들기/참가: 지금 상태를 다시 보낸다
      } else if (ev === 'room:settings' && payload && payload.settings) { Object.assign(room.settings, payload.settings); fire('room:state', st()); }
      else if (ev === 'word:choose') { chosen = payload && payload.word; resume('mydraw'); }
      else if (ev === 'chat:message' && payload) {
        var me = players[0];
        if (room.phase === 'drawing' && room.drawerId !== ME && !me.hasGuessed && norm(payload.text) === norm(word)) {
          me.hasGuessed = true; me.score += 300; chat('correct', me.name + '님이 정답을 맞혔습니다!'); fire('player:guessed', { id: ME }); fire('room:state', st());
        } else if (room.phase === 'drawing' && (room.drawerId === ME || me.hasGuessed)) chat('guessed-chat', payload.text, me);
        else if (room.phase === 'drawing' && norm(payload.text).length >= 3 && norm(word).indexOf(norm(payload.text).slice(0, 2)) === 0) { chat('chat', payload.text, me); chat('close', '거의 맞았어요!'); }
        else chat('chat', payload.text, me);
      } else if (ev === 'player:kick' && payload) {
        var i = players.findIndex(function (p) { return p.id === payload.playerId; });
        if (i > 0) { chat('system', players[i].name + '님이 강퇴되었어요'); players.splice(i, 1); fire('room:state', st()); }
      } else if (ev === 'game:start') { if (pending && pending.label === 'choosing') resume('choosing'); else if (idx === 1) { idx = 2; steps[1].run(); } }
      else if (ev === 'auth:token') { if (started) fire('room:state', st()); }
      else if (ev === 'player:update' && payload) {
        if (room.phase !== 'lobby') { if (ack) ack({ ok: false, error: '대기실에서만 바꿀 수 있어요' }); }
        else {
          var nm = String(payload.name || '').trim();
          if (!nm || Array.from(nm).length > 12) { if (ack) ack({ ok: false, error: '닉네임은 1~12자예요' }); }
          else {
            if (players[0].name !== nm) chat('system', players[0].name + '님이 닉네임을 ' + nm + '(으)로 바꿨습니다.');
            players[0].name = nm; if (payload.avatar) players[0].avatar = payload.avatar;
            if (ack) ack({ ok: true });
            fire('room:state', st());
          }
        }
      }
      return sock;
    }
  };
  window.io = function () {
    setTimeout(function () {
      fire('connect');
      if (scene) { // scene 지정 시 자동으로 방 만들기 (헤드리스 스크린샷용)
        var n = document.getElementById('nick'), b = document.getElementById('btn-create');
        if (n && !n.value) n.value = '나';
        if (b) b.click();
      }
    }, 0);
    return sock;
  };
  console.log('[mock] dev-mock loaded. scene=' + (scene || '(none)'));
})();
