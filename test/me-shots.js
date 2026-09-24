'use strict';
/**
 * test/me-shots.js — 내 정보(/me) · 방 안 프로필 수정 · 나가기/탈퇴 확인 스크린샷 (가짜 Supabase). 검사는 하지 않는다.
 * 실행: node test/me-shots.js  →  test/shots/me/*.png
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium, devices } = require('playwright');

const PORT = 3140;
const URL = `http://localhost:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'shots', 'me');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const env = { ...process.env, PORT: String(PORT), ALLOW_SOLO: '1' };
  delete env.SUPABASE_URL; delete env.SUPABASE_ANON_KEY; delete env.SUPABASE_SERVICE_ROLE_KEY;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('http://')) { clearTimeout(t); resolve(child); } });
    child.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
}

async function shots(browser, tag, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log(`[${tag}] pageerror: ${e.message}`));
  // 로그인 · 확정한 적 있는 사용자
  await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
  await p.evaluate(() => localStorage.setItem('drawguess.profileConfirmed', JSON.stringify({ 'mock-user-1': Date.now() })));
  await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
  await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 8000 });
  await p.waitForSelector('#me-account:not([hidden])', { timeout: 8000 });
  await p.click('#btn-account-open');
  await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
  await p.evaluate(() => window.Account.saveWordSet({ name: '동물', words: '사자, 호랑이, 기린, 코끼리, 판다, 코알라, 캥거루, 펭귄, 부엉이' }));
  await p.evaluate(() => window.Account.saveWordSet({ name: '회사 워크숍', words: '엑셀, 회의, 야근, 커피' }));
  await p.click('#btn-mp-profile'); await p.waitForSelector('#landing-step-profile:not([hidden])'); await p.click('#btn-profile-next');
  await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
  await sleep(500);
  await p.screenshot({ path: path.join(OUT, `${tag}-me-sets.png`), fullPage: true });
  await p.click('#tab-gallery'); await sleep(200);
  await p.screenshot({ path: path.join(OUT, `${tag}-me-gallery.png`), fullPage: true });
  await p.click('#btn-mp-delete'); await sleep(250);
  await p.screenshot({ path: path.join(OUT, `${tag}-delete-dialog.png`) });
  await p.click('#btn-delete-cancel');
  await p.click('#btn-me-back');
  await p.waitForSelector('#landing-step-room:not([hidden])');
  await p.click('#btn-create');
  await p.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
  await sleep(400);
  if (ctxOpts.isMobile) { await p.click('#btn-menu'); await sleep(400); await p.screenshot({ path: path.join(OUT, `${tag}-room-menu.png`) }); }
  await p.click('#btn-room-profile');
  await sleep(500);
  await p.screenshot({ path: path.join(OUT, `${tag}-room-profile.png`) });
  if (ctxOpts.isMobile) { await p.click('#sheet-profile .sheet-close'); await sleep(400); await p.click('#btn-menu'); await sleep(300); await p.click('#sheet-menu #btn-account-top'); }
  else { await p.click('#btn-room-profile-close'); await p.click('#btn-account-top'); }
  await sleep(300);
  await p.screenshot({ path: path.join(OUT, `${tag}-leave-to-me.png`) });
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await shots(browser, 'desktop', { viewport: { width: 1280, height: 860 } });
    await shots(browser, 'mobile', { ...devices['iPhone 13'] });
    console.log('DONE ->', OUT);
  } catch (e) { console.error(e); process.exitCode = 1; }
  await browser.close();
  server.kill();
})();
