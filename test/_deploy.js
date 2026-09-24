const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 3161, URL = 'http://localhost:' + PORT, STATE = path.join(__dirname, '.tmp-deploy.json'), BUMP = path.join(__dirname, '..', 'public', '_bump.js');
function start(tag) {
  const env = { ...process.env, PORT: String(PORT), STORE_URL: 'file:' + STATE }; delete env.SUPABASE_URL; delete env.REDIS_URL;
  const c = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (d) => process.stdout.write('[' + tag + '] ' + d));
  c.stderr.on('data', (d) => process.stdout.write('[' + tag + ' err] ' + d));
  return new Promise((r) => c.stdout.on('data', (d) => String(d).includes('http://') && r(c)));
}
(async () => {
  try { fs.unlinkSync(STATE); } catch (e) {}
  try { fs.unlinkSync(BUMP); } catch (e) {}
  let A = await start('A');
  const b = await chromium.launch({ channel: 'chrome' });
  const pages = [];
  const join = async (nick, code) => {
    const p = await (await b.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    p.on('pageerror', (e) => console.log('pageerror', nick, e.message));
    p.on('console', (m) => { if (m.type() === 'error') console.log('console', nick, m.text()); });
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
  await host.click('#mode-panel .mode-card[data-mode="classic"]'); await sleep(800);
  const snap = async (label) => {
    for (const [n, p] of pages) {
      const s = await p.evaluate(() => ({ host: window.__dg.state.hostId, me: window.__dg.myId(), players: window.__dg.state.players.map((x) => x.id.slice(0, 5) + ':' + x.name + (x.connected === false ? '(off)' : '')), inRoom: !document.getElementById('view-room').hidden, crown: document.querySelectorAll('#player-list .crown, #player-list [class*="host"]').length })).catch((e) => ({ err: e.message }));
      console.log(label, n, JSON.stringify({ ...s, host: s.host && s.host.slice(0, 5), me: s.me && s.me.slice(0, 5) }));
    }
  };
  await snap('before');
  A.kill('SIGTERM'); await new Promise((r) => A.on('exit', r));
  fs.writeFileSync(BUMP, '// bump ' + Date.now());
  const B = await start('B');
  await sleep(12000);
  await snap('after');
  await b.close(); B.kill(); try { fs.unlinkSync(BUMP); } catch (e) {} try { fs.unlinkSync(STATE); } catch (e) {}
})();
