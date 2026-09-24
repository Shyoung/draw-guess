'use strict';
/**
 * test/tablet.js — 아이패드 크기에서 어떤 UI 가 나오는지 검증 (가짜 소켓 ?mock=1, 터치 에뮬레이션).
 *   세로(≤1099px, 터치) = 모바일 UI(게임 셸 · 시트) / 가로 = 데스크톱 3단 / 좁고 긴 데스크톱 창(마우스) = 기존 중간 화면.
 *   게임 중(관전자·출제자): 페이지 스크롤 없음 · 캔버스 전부 보임 · 정답 입력칸(관전자) 화면 안 · 가로 스크롤 없음.
 *   가로 터치에서는 채팅 입력창에 자동 포커스하지 않는다(가상 키보드 방지).
 *   키보드(화면 높이 축소) 흉내: 세로 = 컴팩트(캔버스 통째로 축소 + 말풍선), 가로 = 태블릿 셸에서 캔버스가 남는 높이에 맞춰 축소.
 *   한글 IME: 조합 중 Enter 는 조합이 끝난 뒤 한 번만 보내고, 보낸 직후 되살아난 마지막 글자는 지운다.
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
      shell: document.body.classList.contains('game-shell'), tshell: document.body.classList.contains('tablet-shell'),
      compact: document.getElementById('view-room').getAttribute('data-compact') === '1',
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
      if (d.touch && !d.mobile) check(m.tshell, `${d.tag} 관전자: 가로 태블릿 게임 셸`, m.tshell);
      await p.screenshot({ path: path.join(OUT, `${d.tag}-drawing.png`) });
      // 키보드 흉내: 아이패드 사파리처럼 레이아웃(방향·innerHeight)은 그대로 두고 visualViewport 높이만 줄인다(키보드 ≈ 세로 400px · 가로 390px)
      if (d.touch) {
        const kb = d.h > d.w ? 400 : 390, before = m.canvas;
        const setVV = (H) => p.evaluate((H) => { const vv = window.visualViewport; Object.defineProperty(vv, 'height', { configurable: true, get: () => (H == null ? window.innerHeight : H) }); vv.dispatchEvent(new Event('resize')); }, H);
        await p.click('#chat-input');
        await setVV(d.h - kb);
        await sleep(600);
        const k = await measure(p); const layoutVh = k.vh; k.vh = d.h - kb;
        check(k.sh <= layoutVh + 1, `${d.tag} 키보드: 페이지 스크롤 없음`, `${k.sh} > ${layoutVh}`);
        check(inside(k.canvas, k), `${d.tag} 키보드: 캔버스 전부 보임`, k.canvas);
        check(inside(k.input, k), `${d.tag} 키보드: 정답 입력칸 화면 안`, k.input);
        check(k.canvas && Math.abs(k.canvas.w / k.canvas.h - 4 / 3) < 0.03, `${d.tag} 키보드: 캔버스 4:3 유지`, k.canvas && (k.canvas.w / k.canvas.h).toFixed(3));
        if (d.mobile) check(k.compact, `${d.tag} 키보드: 컴팩트 모드(캔버스 축소 · 말풍선)`, k.compact);
        else check(k.tshell && k.canvas && before && k.canvas.w < before.w, `${d.tag} 키보드: 캔버스가 남는 높이에 맞춰 줄어듦`, k.canvas && before && [Math.round(before.w), Math.round(k.canvas.w)]);
        await p.screenshot({ path: path.join(OUT, `${d.tag}-keyboard.png`) });
        await setVV(null);
        await sleep(600);
        const r = await measure(p);
        check(!r.compact && inside(r.canvas, r) && r.canvas.w >= (before ? before.w - 2 : 0), `${d.tag} 키보드 닫힘: 원래 크기로`, r.canvas && [Math.round(r.canvas.w), r.compact]);
      }
      // 한글 IME(아이패드 세로에서 한 번): 조합 중 Enter · 보낸 뒤 되살아난 글자
      if (d.tag === 'ipad-air-portrait') {
        const sentCount = () => p.evaluate(() => [...document.querySelectorAll('#chat-list > *')].filter((n) => /사과나무/.test(n.textContent)).length);
        const c0 = await sentCount();
        await p.evaluate(() => {
          const i = document.getElementById('chat-input');
          i.focus(); i.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
          i.value = '사과나무';
          document.getElementById('chat-form').requestSubmit();
        });
        await sleep(150);
        check((await sentCount()) === c0 && (await p.inputValue('#chat-input')) === '사과나무', 'IME: 조합 중 Enter 는 바로 보내지 않음');
        await p.evaluate(() => document.getElementById('chat-input').dispatchEvent(new CompositionEvent('compositionend', { data: '무' })));
        await sleep(500);
        check((await sentCount()) === c0 + 1 && (await p.inputValue('#chat-input')) === '', 'IME: 조합이 끝나면 한 번만 보내고 입력칸 비움', await sentCount());
        // 보낸 직후 IME 가 마지막 글자를 다시 넣는 경우(iPadOS)
        await p.evaluate(() => { const i = document.getElementById('chat-input'); i.value = '무'; i.dispatchEvent(new Event('input', { bubbles: true })); });
        check((await p.inputValue('#chat-input')) === '', 'IME: 보낸 직후 되살아난 마지막 글자 지움', await p.inputValue('#chat-input'));
        await sleep(700);
        await p.fill('#chat-input', '무지개');
        check((await p.inputValue('#chat-input')) === '무지개', 'IME: 조금 뒤 새로 치는 글자는 그대로');
        await p.fill('#chat-input', '');
      }

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
      // 태블릿 세로 출제자: 관전자와 같은 배치(캔버스 폭 가득 → 도구 모음 → 채팅 목록 + 입력줄)
      if (d.mobile && d.w >= 700) {
        const lay = await p.evaluate(() => {
          const b = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, w: r.width, h: r.height, vis: r.width > 0 && getComputedStyle(e).display !== 'none' }; };
          return { tab: document.getElementById('view-room').getAttribute('data-tablet'), dc: b('#drawer-chat'), list: b('#chat-panel #chat-list') || b('.chat-panel .chat-list'), input: b('#chat-input'), canvas: b('#canvas'), tools: b('#toolbar') };
        });
        check(lay.tab === '1' && lay.dc && !lay.dc.vis, `${d.tag} 출제자(태블릿): 채팅 버블 카드 대신`, lay.tab);
        check(lay.canvas && lay.canvas.w >= d.w - 60, `${d.tag} 출제자(태블릿): 캔버스 폭 가득`, lay.canvas && Math.round(lay.canvas.w));
        check(lay.canvas && lay.tools && lay.list && lay.canvas.b <= lay.tools.t + 1 && lay.tools.b <= lay.list.t + 1 && lay.list.vis && lay.list.h >= 50, `${d.tag} 출제자(태블릿): 캔버스 → 도구 모음 → 채팅 목록`, lay.list && Math.round(lay.list.h));
        check(lay.input && lay.input.vis && lay.input.b <= m.vh + 0.5, `${d.tag} 출제자(태블릿): 채팅 입력칸 화면 안`, lay.input);
        // 출제자가 채팅하려고 키보드를 열면: 캔버스 · 도구 · 입력칸이 한 화면에
        const setVV = (H) => p.evaluate((H) => { const vv = window.visualViewport; Object.defineProperty(vv, 'height', { configurable: true, get: () => (H == null ? window.innerHeight : H) }); vv.dispatchEvent(new Event('resize')); }, H);
        const KH = d.h - 400;
        await p.click('#chat-input');
        await setVV(KH);
        await sleep(600);
        const k = await measure(p); k.vh = KH;
        const kt = await p.evaluate(() => { const r = document.getElementById('toolbar').getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, vis: r.width > 0 }; });
        check(k.compact && inside(k.canvas, k) && kt.b <= KH + 0.5 && inside(k.input, k), `${d.tag} 출제자(태블릿) 키보드: 캔버스 · 도구 모음 · 입력칸 모두 화면 안`, { c: k.canvas && Math.round(k.canvas.b), t: Math.round(kt.b), i: k.input && Math.round(k.input.b), KH });
        check(k.canvas && Math.abs(k.canvas.w / k.canvas.h - 4 / 3) < 0.03, `${d.tag} 출제자(태블릿) 키보드: 캔버스 4:3`, k.canvas && (k.canvas.w / k.canvas.h).toFixed(3));
        await p.screenshot({ path: path.join(OUT, `${d.tag}-mydraw-keyboard.png`) });
        await setVV(null);
        await sleep(500);
      }
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
