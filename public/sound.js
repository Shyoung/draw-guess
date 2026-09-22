/* =====================================================================
   서버가 터져서 도망친 곳에 낙원은 있나? — sound.js
   외부 오디오 파일 없이 Web Audio API로 합성한 짧은 효과음.
   window.SFX = { play(name), isMuted(), setMuted(bool), toggle() }
   ===================================================================== */
(function () {
  'use strict';
  var STORAGE_KEY = 'dg-sound-muted';
  var ctx = null;
  var master = null;
  var muted = loadMuted();

  function loadMuted() {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { return false; }
  }
  function saveMuted(v) {
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  /** 오디오 컨텍스트는 브라우저 자동재생 정책 때문에 사용자 입력 이후에만 만들 수 있다. */
  function ensureCtx() {
    if (!ctx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { ctx.resume().catch(function () { /* ignore */ }); }
    return ctx;
  }
  // 첫 클릭/키 입력 시 컨텍스트를 깨워 둔다 (이후 play() 호출이 지연 없이 소리남).
  ['pointerdown', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, ensureCtx, { once: true, passive: true });
  });

  /**
   * 한 음을 예약 재생.
   * @param {number} freq 주파수(Hz)
   * @param {number} t0 ctx.currentTime 기준 시작 오프셋(초)
   * @param {number} dur 지속 시간(초)
   * @param {object} [opts] { type, gain, glideTo, glideDur }
   */
  function tone(freq, t0, dur, opts) {
    if (!ctx) return;
    var o = opts || {};
    var type = o.type || 'sine';
    var peak = o.gain != null ? o.gain : 0.2;
    var start = ctx.currentTime + t0;
    var osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, start + (o.glideDur || dur));
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }

  // 이름 → 음 시퀀스. 각 항목: [주파수, 시작오프셋, 길이, opts?]
  var SOUNDS = {
    // 입장: 부드럽게 올라가는 2음
    join: [[523.25, 0, 0.09, { type: 'sine', gain: 0.14 }], [659.25, 0.07, 0.12, { type: 'sine', gain: 0.14 }]],
    // 퇴장/강퇴: 부드럽게 내려가는 2음
    leave: [[587.33, 0, 0.09, { type: 'sine', gain: 0.12 }], [440.0, 0.07, 0.13, { type: 'sine', gain: 0.12 }]],
    // 내가 정답을 맞혔을 때: 밝은 3음 아르페지오
    correctSelf: [
      [523.25, 0, 0.1, { type: 'triangle', gain: 0.22 }],
      [659.25, 0.09, 0.1, { type: 'triangle', gain: 0.22 }],
      [783.99, 0.18, 0.22, { type: 'triangle', gain: 0.24 }],
    ],
    // 다른 사람이 정답을 맞혔을 때: 짧고 은은한 2음
    correctOther: [[659.25, 0, 0.08, { type: 'sine', gain: 0.1 }], [783.99, 0.06, 0.14, { type: 'sine', gain: 0.11 }]],
    // 근접 정답: 아주 짧은 틱
    close: [[880, 0, 0.05, { type: 'square', gain: 0.08 }]],
    // 내 출제 차례(단어 선택 화면): 벨 느낌의 노크
    myTurn: [[659.25, 0, 0.12, { type: 'triangle', gain: 0.2 }], [523.25, 0.13, 0.22, { type: 'triangle', gain: 0.2 }]],
    // 턴 종료: 짧은 하강 종지
    turnEnd: [[587.33, 0, 0.09, { type: 'sine', gain: 0.13 }], [392.0, 0.08, 0.16, { type: 'sine', gain: 0.13 }]],
    // 게임 종료: 4음 팡파르
    gameOver: [
      [523.25, 0, 0.14, { type: 'triangle', gain: 0.2 }],
      [659.25, 0.13, 0.14, { type: 'triangle', gain: 0.2 }],
      [783.99, 0.26, 0.14, { type: 'triangle', gain: 0.2 }],
      [1046.5, 0.39, 0.32, { type: 'triangle', gain: 0.24 }],
    ],
    // 오류 토스트: 낮은 버저
    error: [[196, 0, 0.14, { type: 'sawtooth', gain: 0.12 }], [164.81, 0.1, 0.16, { type: 'sawtooth', gain: 0.12 }]],
    // 소리 켜짐 확인용 클릭
    toggleOn: [[880, 0, 0.08, { type: 'sine', gain: 0.14 }]],
    // 남은 시간 5초 이하: 매초 짧은 째깍 소리
    tick: [[1200, 0, 0.05, { type: 'square', gain: 0.13 }]],
  };

  function play(name) {
    if (muted) return;
    var seq = SOUNDS[name];
    if (!seq) return;
    var c = ensureCtx();
    if (!c) return;
    seq.forEach(function (n) { tone(n[0], n[1], n[2], n[3]); });
  }

  function isMuted() { return muted; }
  function setMuted(v) { muted = !!v; saveMuted(muted); }
  function toggle() {
    setMuted(!muted);
    if (!muted) { ensureCtx(); play('toggleOn'); }
    return muted;
  }

  window.SFX = { play: play, isMuted: isMuted, setMuted: setMuted, toggle: toggle };
})();
