'use strict';
/**
 * test/deploy-sim.js — Render 배포 전환을 흉내 내 방장·자리가 유지되는지 본다(브라우저 3개, 검사 출력만).
 *   프록시(:3170) → 옛 서버 A(:3171). 방을 만들고 3명 참가 → 새 버전 서버 B(:3172)를 띄우고 프록시의 새 연결을 B 로 →
 *   (옛 연결은 A 에 남음) → A 종료 → 모두 B 로 재접속 · 새 버전이라 새로고침 → 방장·자리 확인
 *   node test/deploy-sim.js [scene]   scene: lobby(기본) | drawing
 */
const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');
const STATE = path.join(__dirname, '.tmp-deploy.json');
const BUMP = path.join(ROOT, 'public', '_bump.js');
const SCENE = process.argv[2] || 'lobby';
let target = 3171;
const conns = new Set();
const proxy = net.createServer((c) => {
  const up = net.connect(target, '127.0.0.1');
  conns.add(c);
  c.pipe(up).pipe(c);
  const end = () => { conns.delete(c); c.destroy(); up.destroy(); };
  c.on('error', end); up.on('error', end); c.on('close', end); up.on('close', end);
});
function start(tag, port) {
  const env = { ...process.env, PORT: String(port), STORE_URL: 'file:' + STATE, ALLOW_SOLO: '0' };
  delete env.SUPABASE_URL; delete env.REDIS_URL;
  const c = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => { if (!/keep-alive/.test(l)) console.log('[' + tag + '] ' + l); }));
  return new Promise((r) => c.stdout.on('data', (d) => String(d).includes('http://') && r(c)));
}
(async () => {
  try { fs.unlinkSync(STATE); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(BUMP); } catch (e) { /* ignore */ }
  await new Promise((r) => proxy.listen(3170, r));
  const A = await start('A', 3171);
  const b = await chromium.launch({ channel: 'chrome' });
  const URL = 'http://localhost:3170';
  const pages = [];
  const join = async (nick, code) => {
    const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    p.on('pageerror', (e) => console.log('pageerror', nick, e.message));
    await p.goto(URL + '/' + (code ? '?room=' + code : ''));
    await p.waitForSelector('#landing-step-profile:not([hidden])');
    await p.fill('#nick', nick); await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])');
    if (code) await p.click('#btn-join'); else await p.click('#btn-create');
    await p.waitForFunction(() => !document.getElementById('view-room').hidden);
    await sleep(300); pages.push([nick, p]); return p;
  };
  const host = await join('방장');
  const code = (await host.textContent('#room-code')).trim().replace(/[^A-Z]/g, '');
  await join('둘', code); await join('셋', code);
  await host.click('#mode-panel .mode-card[data-mode="classic"]'); await sleep(500);
  if (SCENE === 'drawing') { await host.click('#btn-start'); await sleep(2500); }
  const snap = async (label) => {
    const out = [];
    for (const [n, p] of pages) {
      const s = await p.evaluate(() => ({ host: window.__dg.state.hostId, me: window.__dg.myId(), phase: window.__dg.state.phase, players: window.__dg.state.players.map((x) => x.name + (x.connected === false ? '(off)' : '')), crown: document.querySelectorAll('#player-list .host-tag').length, drawer: (window.__dg.state.players.find((x) => x.id === window.__dg.state.drawerId) || {}).name, sys: [...document.querySelectorAll('#chat-list .msg-system')].slice(-4).map((n) => n.textContent), inRoom: !document.getElementById('view-room').hidden })).catch((e) => ({ err: e.message }));
      out.push(n + ' ' + JSON.stringify({ ...s, isHost: s.host === s.me, host: undefined, me: undefined }));
    }
    console.log('--- ' + label + '\n' + out.join('\n'));
  };
  await snap('before');
  fs.writeFileSync(BUMP, '// bump ' + Date.now());
  const B = await start('B', 3172);
  target = 3172; // 새 연결은 B 로(옛 웹소켓 연결은 A 에 그대로)
  await sleep(3000);
  await snap('overlap');
  A.kill('SIGTERM'); // Windows 에서는 즉시 종료(flush 없음) — 마지막 저장 스로틀(300ms) 이후 상태가 남아 있다
  await sleep(15000);
  await snap('after');
  await b.close(); B.kill(); proxy.close();
  try { fs.unlinkSync(BUMP); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(STATE); } catch (e) { /* ignore */ }
  process.exit(0);
})();
