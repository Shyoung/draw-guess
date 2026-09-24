'use strict';
/**
 * test/tablet.js — 아이패드 크기에서 어떤 UI 가 나오는지 검증 (가짜 소켓 ?mock=1, 터치 에뮬레이션).
 *   세로(≤1099px, 터치) = 모바일 UI(게임 셸 · 시트) / 가로 = 데스크톱 3단 / 좁고 긴 데스크톱 창(마우스) = 기존 중간 화면.
 *   게임 중(관전자·출제자): 페이지 스크롤 없음 · 캔버스 전부 보임 · 정답 입력칸(관전자) 화면 안 · 가로 스크롤 없음.
 *   가로 터치에서는 채팅 입력창에 자동 포커스하지 않는다(가상 키보드 방지).
 * 실행: node test/tablet.js   (스크린샷: test/shots/tablet/*.png)
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PORT = 3145;
const URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots', 'tablet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let failures = 0;
function check(cond, name, detail) {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail !== undefined ? '  -> ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); }
}

function startServer() {
  const env = { ...process.env, PORT: String(PORT) };
  delete env.SUPABASE_URL; delete env.SUPABASE_ANON_KEY; delete env.SUPABASE_SERVICE_ROLE_KEY;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); resolve(child); } });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}

const DEVICES = [
  { tag: 'ipad-mini-portrait', w: 744, h: 1133, touch: true, mobile: true },
  { tag: 'ipad-air-portrait', w: 820, h: 1180, touch: true, mobile: true },
  { tag: 'ipad-pro11-portrait', w: 834, h: 1194, touch: true, mobile: true },
  { tag: 'ipad-pro13-portrait', w: 1024, h: 1366, touch: true, mobile: true },
  { tag: 'ipad-air-landscape', w: 1180, h: 820, touch: true, mobile: false },
  { tag: 'ipad-pro13-landscape', w: 1366, h: 1024, touch: true, mobile: false },
  { tag: 'desktop-narrow-portrait', w: 900, h: 1100, touch: false, mobile: false }, // 마우스: 기존 중간 화면 유지
];

async function measure(p) {
  return p.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width, h: r.height, vis: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 }; };
    return {
      vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
      shell: document.body.classList.contains('game-shell'),
      canvas: box('#canvas'), input: box('#chat-input'), players: box('#players-panel') || box('.players-panel'), menu: box('#btn-menu'),
      focusChat: document.activeElement && document.activeElement.id === 'chat-input',
    };
  });
}
/** 방에 들어간 상태로: 게스트 첫 화면(프로필)이면 저장 → 방 만들기 */
async function enterRoom(p, url) {
  await p.goto(url);
  const shown = (id) => `!document.getElementById('${id}').hidden`;
  await p.waitForFunction(`${shown('view-room')} || (${shown('view-landing')} && (${shown('landing-step-profile')} || ${shown('landing-step-room')}))`, null, { timeout: 8000 });
  await sleep(600); // 같은 탭이면 마지막 방으로 자동 재접속될 수 있다
  const inRoom = () => p.evaluate(() => !document.getElementById('view-room').hidden);
  if (await inRoom()) return;
  if (await p.locator('#landing-step-profile').isVisible()) {
    if (!(await p.inputValue('#nick'))) await p.fill('#nick', '태블릿');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
  }
  if (await p.locator('#landing-step-room').isVisible()) await p.click('#btn-create');
  await p.waitForFunction(() => !document.getElementById('view-room').hidden, null, { timeout: 5000 });
}
const inside = (b, m) => !!b && b.vis && b.t >= -0.5 && b.l >= -0.5 && b.b <= m.vh + 0.5 && b.r <= m.vw + 0.5;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADFUL });
  try {
    for (const d of DEVICES) {
      console.log(`\n== ${d.tag} ${d.w}x${d.h}${d.touch ? ' (터치)' : ''} ==`);
      // 장면마다 새 컨텍스트(같은 탭이면 마지막 방으로 자동 재접속돼 장면이 섞인다)
      let ctx = null, p = null;
      const fresh = async () => {
        if (ctx) await ctx.close();
        ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: 1, ...(d.touch ? { isMobile: true, hasTouch: true, userAgent: IPAD_UA } : {}) });
        p = await ctx.newPage();
        p.on('pageerror', (e) => { failures++; console.log(`[${d.tag}] pageerror: ${e.message}`); });
      };
      await fresh();

      // 대기실
      await enterRoom(p, `${URL}/?mock=1&stay=1`);
      await sleep(600);
      const isMobile = await p.evaluate(() => window.matchMedia('(max-width: 767px), (max-width: 1099px) and (orientation: portrait) and (pointer: coarse)').matches);
      check(isMobile === d.mobile, `${d.tag}: ${d.mobile ? '모바일 UI' : '데스크톱/중간 UI'}`, isMobile);
      let m = await measure(p);
      check(m.sw <= m.vw, `${d.tag} 대기실: 가로 스크롤 없음`, `${m.sw} > ${m.vw}`);
      check(d.mobile ? m.menu && m.menu.vis : !(m.menu && m.menu.vis), `${d.tag} 대기실: 메뉴(⋯) 버튼 ${d.mobile ? '있음' : '없음'}`);
      await p.screenshot({ path: path.join(OUT, `${d.tag}-lobby.png`) });

      // 게임 중(관전자)
      await fresh();
      await enterRoom(p, `${URL}/?mock=1&scene=drawing`);
      await p.waitForFunction(() => window.__dg && window.__dg.state.phase === 'drawing', null, { timeout: 8000 }).catch(() => {});
      await sleep(900);
      m = await measure(p);
      check(m.sw <= m.vw, `${d.tag} 관전자: 가로 스크롤 없음`, `${m.sw} > ${m.vw}`);
      if (d.touch) {
        check(m.sh <= m.vh + 1, `${d.tag} 관전자: 페이지 스크롤 없음`, `${m.sh} > ${m.vh}`);
        check(inside(m.canvas, m), `${d.tag} 관전자: 캔버스 전부 보임`, m.canvas);
        check(inside(m.input, m), `${d.tag} 관전자: 정답 입력칸 화면 안`, m.input);
      }
      check(m.shell === d.mobile, `${d.tag} 관전자: 게임 셸 ${d.mobile ? '켜짐' : '꺼짐'}`, m.shell);
      if (d.mobile) check(m.canvas && m.canvas.w >= d.w - 60, `${d.tag} 관전자: 캔버스를 화면 폭 가득(≥ ${d.w - 60}px)`, m.canvas && Math.round(m.canvas.w));
      if (!d.mobile && d.w >= 1100) check(m.players && m.canvas && m.players.r <= m.canvas.l, `${d.tag} 관전자: 3단(참가자 | 캔버스 | 채팅)`, m.players && [Math.round(m.players.r), Math.round(m.canvas.l)]);
      if (d.touch) check(!m.focusChat, `${d.tag} 관전자: 채팅 입력창 자동 포커스 안 함(가상 키보드 방지)`);
      await p.screenshot({ path: path.join(OUT, `${d.tag}-drawing.png`) });

      // 게임 중(출제자): 캔버스 · 도구가 화면 안
      await fresh();
      await enterRoom(p, `${URL}/?mock=1&scene=mydraw`);
      await p.waitForFunction(() => window.__dg && window.__dg.state.drawerId === window.__dg.myId() && ['choosing', 'drawing'].includes(window.__dg.state.phase), null, { timeout: 8000 }).catch(() => {});
      const opt = p.locator('#word-options .word-option').first();
      if (await p.evaluate(() => window.__dg.state.phase === 'choosing') && await opt.isVisible().catch(() => false)) await opt.click({ timeout: 3000 }).catch(() => opt.click({ force: true }));
      await p.waitForFunction(() => window.__dg.state.phase === 'drawing', null, { timeout: 5000 }).catch(() => {});
      await sleep(900);
      m = await measure(p);
      const tools = await p.evaluate(() => { const e = document.querySelector('#toolbar') || document.querySelector('.toolbar'); if (!e) return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, vis: r.width > 0 }; });
      check(m.sh <= m.vh + 1 || !d.mobile, `${d.tag} 출제자: 페이지 스크롤 없음`, `${m.sh} > ${m.vh}`);
      if (d.touch) check(inside(m.canvas, m), `${d.tag} 출제자: 캔버스 전부 보임`, m.canvas);
      if (d.touch) check(!!tools && tools.vis && tools.b <= m.vh + 0.5 && tools.r <= m.vw + 0.5, `${d.tag} 출제자: 도구 모음 화면 안`, tools);
      await p.screenshot({ path: path.join(OUT, `${d.tag}-mydraw.png`) });

      // 랜딩(게스트): 가로 스크롤 없음
      await fresh();
      await p.goto(`${URL}/`);
      await p.waitForSelector('#landing-step-profile:not([hidden]), #landing-step-start:not([hidden])', { timeout: 5000 }).catch(() => {});
      m = await measure(p);
      check(m.sw <= m.vw, `${d.tag} 랜딩: 가로 스크롤 없음`, `${m.sw} > ${m.vw}`);
      await ctx.close();
    }
  } catch (e) {
    failures++;
    console.log('FAIL  예외:', e.stack || e.message);
  } finally {
    await browser.close();
    server.kill();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  }
})();
