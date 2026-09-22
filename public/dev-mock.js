/* dev-mock.js — 개발용 가짜 io(). index.html?mock=1 로 열면 client.js 앞에 로드된다.
   ?mock=1&scene=<label> 을 주면 해당 단계까지 즉시 진행한 뒤 정상 속도로 이어간다.
   labels: lobby, choosing, drawing, hint, guessed, turnEnd, drawer, mydraw, gameOver, backToLobby */
(function () {
  var handlers = {}, ME = 'me', chosen = null;
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
    settings: { rounds: 3, drawTime: 80, wordCount: 3, hints: 2, hintEndAt: 15, customWords: '', customWordsOnly: false } };
  var timeLeft = 0, word = '';
  function st() { players.forEach(function (p) { p.isDrawing = p.id === room.drawerId; }); return Object.assign({}, room, { players: players }); }
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
      fire('game:over', { ranking: ranking });
    } },
    { label: 'backToLobby', delay: 10000, run: function () { room.round = 0; setPhase('lobby', null); chat('system', '게임이 끝났어요. 다시 시작할 수 있어요!'); } }
  ];
  var scene = (new URLSearchParams(location.search).get('scene') || '').trim();
  var target = -1; steps.forEach(function (s, i) { if (s.label === scene) target = i; });
  var idx = 0, pending = null, started = false;
  function advance() {
    var s = steps[idx]; if (!s) return;
    var fast = idx <= target;
    if (s.manual && !fast) { pending = s; return; }
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
      } else if (ev === 'game:start') { if (idx === 1) { idx = 2; steps[1].run(); } }
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
