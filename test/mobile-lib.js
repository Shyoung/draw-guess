/**
 * 모바일 검증 공용 헬퍼 — mobile-shots.js(스크린샷) / mobile.js(어설션) 가 함께 쓴다.
 *   - 서버(server/index.js) 를 3988 포트로 띄우고
 *   - iPhone 13 에뮬레이션(모바일, 호스트) + 데스크톱 1280x860 두 브라우저 컨텍스트로 1라운드 게임을 끝까지 돌린다.
 *   - 각 단계마다 hook(stage, ctx) 를 호출한다. stage:
 *       landing, lobby-mode, lobby-settings, choosing-drawer, drawing-drawer, turnend,
 *       drawing-guesser, drawing-guesser-chat, gameover, gallery
 */
const { spawn } = require('child_process');
const path = require('path');
const { chromium, devices } = require('playwright');

const PORT = 3988;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  const env = { ...process.env, PORT: String(PORT) };
  delete env.ALLOW_SOLO; // 최소 인원 2명(프로덕션 기본)으로 검증
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL + '/'); if (r.ok) return child; } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function scribble(page) {
  const box = await page.locator('#canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - box.width * 0.3, cy - 20);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(cx - box.width * 0.3 + i * (box.width * 0.6 / 16), cy - 20 + Math.sin(i / 2.5) * 40, { steps: 2 });
  await page.mouse.up();
  await page.mouse.move(cx - box.width * 0.25, cy + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(cx + box.width * 0.25, cy + box.height * 0.3, { steps: 6 });
  await page.mouse.up();
}

async function say(page, text) {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
}

/**
 * @param {(stage:string, ctx:{mobile:import('playwright').Page, desktop:import('playwright').Page, word?:string}) => Promise<void>} hook
 * @param {{ onPageError?: (nick:string, msg:string)=>void, customWords?: string, wordCount?: number }} [opts]
 *   customWords 를 주면 "사용자 단어만 사용" 을 켜고 wordCount(기본 2)개 후보로 진행한다 → 긴 단어 헤더 검증용.
 */
async function runMobileFlow(hook, opts) {
  opts = opts || {};
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADFUL });
  const timeout = setTimeout(() => { console.log('FAIL  전체 타임아웃'); process.exit(2); }, 180000);
  try {
    const mctx = await browser.newContext({ ...devices['iPhone 13'] });
    const dctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const mobile = await mctx.newPage();
    const desktop = await dctx.newPage();
    for (const [nick, pg] of [['모바일', mobile], ['데스크톱', desktop]]) {
      pg.on('pageerror', (e) => { console.log(`[${nick}] pageerror: ${e.message}`); if (opts.onPageError) opts.onPageError(nick, e.message); });
      pg.on('console', (m) => { if (m.type() === 'error') console.log(`[${nick}] console.error: ${m.text()}`); });
    }
    const ctx = { mobile, desktop, browser, word: null };

    // 1. 랜딩
    await mobile.goto(URL + '/');
    await mobile.waitForSelector('#btn-create');
    await hook('landing', ctx);

    // 2. 모바일이 방을 만들고(호스트) 데스크톱이 참가 → 모드 선택 화면
    await mobile.fill('#nick', '모바일');
    await mobile.click('#btn-create');
    await mobile.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    const code = (await mobile.textContent('#room-code')).trim().replace(/[^A-Z]/g, '');
    await desktop.goto(`${URL}/?room=${code}`);
    await desktop.fill('#nick', '데스크톱');
    await desktop.click('#btn-join');
    await desktop.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await mobile.waitForFunction(() => document.querySelectorAll('#player-list li').length >= 2, null, { timeout: 5000 });
    await sleep(300);
    await hook('lobby-mode', ctx);

    // 3. 설정 화면 (1라운드, 40초, 힌트 1회)
    await mobile.click('#mode-panel .mode-card[data-mode="classic"]');
    await mobile.waitForSelector('#settings-panel:not([hidden])', { timeout: 3000 });
    await mobile.selectOption('#set-rounds', '1');
    await mobile.selectOption('#set-drawTime', '40');
    await mobile.selectOption('#set-hints', '1');
    if (opts.customWords) {
      await mobile.selectOption('#set-wordCount', String(opts.wordCount || 2));
      await mobile.fill('#set-customWords', opts.customWords);
      await mobile.check('#set-customWordsOnly'); // change → 설정 전송(텍스트 영역 값 포함)
      await mobile.waitForFunction((w) => (window.__dg.state.settings.customWords || '') === w && window.__dg.state.settings.customWordsOnly, opts.customWords, { timeout: 3000 });
    }
    await sleep(500);
    await hook('lobby-settings', ctx);

    // 4. 게임 시작 → 모바일(호스트, 첫 출제자) 단어 선택
    await mobile.click('#btn-start');
    await mobile.waitForSelector('#word-options .word-option:not([disabled])', { timeout: 8000 });
    await sleep(300);
    await hook('choosing-drawer', ctx);

    // 5. 모바일이 그린다
    ctx.word = (await mobile.locator('#word-options .word-option').first().textContent()).trim();
    await mobile.locator('#word-options .word-option').first().click();
    await mobile.waitForSelector('#overlay-choosing', { state: 'hidden', timeout: 5000 });
    await mobile.waitForSelector('#view-room[data-phase="drawing"][data-role="drawer"]', { timeout: 5000 });
    await sleep(300);
    await scribble(mobile);
    await say(desktop, '아무말');
    await sleep(500);
    await hook('drawing-drawer', ctx);

    // 6. 데스크톱이 정답 → allGuessed → 턴 종료 오버레이
    await say(desktop, ctx.word);
    await mobile.waitForSelector('#overlay-turnend:not([hidden])', { timeout: 8000 });
    await sleep(400);
    await hook('turnend', ctx);

    // 7. 턴 2: 데스크톱이 출제자, 모바일은 관전(맞히기)
    await desktop.waitForSelector('#word-options .word-option:not([disabled])', { timeout: 15000 });
    ctx.word = (await desktop.locator('#word-options .word-option').first().textContent()).trim();
    await desktop.locator('#word-options .word-option').first().click();
    await mobile.waitForSelector('#view-room[data-phase="drawing"][data-role="guesser"]', { timeout: 8000 });
    await sleep(300);
    await scribble(desktop);
    await sleep(600);
    await hook('drawing-guesser', ctx);

    // 8. 모바일이 오답 채팅
    await say(mobile, '틀린답');
    await sleep(400);
    await hook('drawing-guesser-chat', ctx);

    // 9. 모바일이 정답 → 턴 종료(5초) → 게임 종료
    await say(mobile, ctx.word);
    await mobile.waitForSelector('#overlay-gameover:not([hidden])', { timeout: 20000 });
    await mobile.waitForSelector('#btn-gallery-open:not([hidden])', { timeout: 3000 }).catch(() => {});
    await sleep(500);
    await hook('gameover', ctx);

    // 10. 갤러리
    await mobile.click('#btn-gallery-open');
    await mobile.waitForSelector('#overlay-gallery:not([hidden])', { timeout: 3000 });
    await sleep(400);
    await hook('gallery', ctx);
    await mobile.click('#btn-gallery-close');
  } finally {
    clearTimeout(timeout);
    await browser.close();
    server.kill();
  }
}

module.exports = { runMobileFlow, say, sleep, URL, PORT };
