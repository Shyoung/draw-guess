/**
 * 실제 브라우저(시스템 Chrome, headless) 3~4개로 전체 게임을 돌려보는 통합 테스트.
 *   node test/browser.js            # headless
 *   HEADFUL=1 node test/browser.js  # 창 띄워서 보기
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const PORT = 3456;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  -> ' + extra : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLAYER_SEL = '#player-list li, #player-list .player';

async function startServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL + '/'); if (r.ok) return child; } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function nonWhitePixels(page) {
  return page.evaluate(() => {
    const c = document.getElementById('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++;
    return n;
  });
}

async function joinAs(context, nick, code) {
  const page = await context.newPage();
  page.on('pageerror', (e) => { console.log(`[${nick}] pageerror: ${e.message}`); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${nick}] console.error: ${m.text()}`); });
  await page.goto(code ? `${URL}/?room=${code}` : URL + '/');
  await page.fill('#nick', nick);
  if (code) {
    check((await page.inputValue('#room-code-input')).toUpperCase() === code, `${nick}: ?room= 코드 자동 입력`);
    await page.click('#btn-join');
  } else {
    await page.click('#btn-create');
  }
  await page.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
  return page;
}

async function drawScribble(page) {
  const box = await page.locator('#canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 120, cy - 60);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(cx - 120 + i * 12, cy - 60 + Math.sin(i / 3) * 50, { steps: 2 });
  }
  await page.mouse.up();
  // 두 번째 굵은 획
  await page.click('#sizes button:nth-child(4)').catch(() => {});
  await page.mouse.move(cx - 100, cy + 80);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy + 80, { steps: 8 });
  await page.mouse.up();
}

async function say(page, text) {
  await page.fill('#chat-input', text);
  await page.press('#chat-input', 'Enter');
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADFUL });
  const timeout = setTimeout(() => { console.log('FAIL  전체 타임아웃'); process.exit(2); }, 240000);
  try {
    const ctxs = await Promise.all([1, 2, 3, 4].map(() => browser.newContext({ viewport: { width: 1280, height: 860 } })));
    const host = await joinAs(ctxs[0], '호스트');
    const code = (await host.textContent('#room-code')).trim().replace(/[^A-Z]/g, '');
    check(/^[A-Z]{4}$/.test(code), '방 코드 4글자 생성', code);
    check(host.url().includes('room=' + code), 'URL에 ?room= 반영');

    const p2 = await joinAs(ctxs[1], '민수', code);
    const p3 = await joinAs(ctxs[2], '지은', code);
    await sleep(300);
    const names = [host, p2, p3];
    const nick = ['호스트', '민수', '지은'];

    check((await host.locator(PLAYER_SEL).count()) === 3, '호스트 화면 플레이어 3명');
    check((await p3.locator(PLAYER_SEL).count()) === 3, '3번째 참가자 화면 플레이어 3명');
    check((await p2.locator('#chat-list').textContent()).includes('지은'), '입장 시스템 메시지 수신');
    check(await p2.locator('#set-rounds').isDisabled(), '비호스트 설정 비활성');

    // 설정 변경 → 다른 클라이언트에 반영
    await host.selectOption('#set-rounds', '1');
    await host.selectOption('#set-drawTime', '30');
    await host.selectOption('#set-hints', '1');
    await sleep(500);
    check((await p2.inputValue('#set-rounds')) === '1', '설정 변경 동기화(rounds=1)', await p2.inputValue('#set-rounds'));
    check((await p2.inputValue('#set-drawTime')) === '30', '설정 변경 동기화(drawTime=30)', await p2.inputValue('#set-drawTime'));
    await host.screenshot({ path: path.join(SHOTS, 'e2e-lobby.png') });

    // 로비 채팅
    await say(p2, '안녕하세요!');
    await sleep(300);
    check((await host.locator('#chat-list').textContent()).includes('안녕하세요!'), '로비 채팅 브로드캐스트');

    await host.click('#btn-start');

    let joinedLate = false;
    for (let turn = 1; turn <= 3; turn++) {
      // 누가 출제자인가: word-option 버튼이 보이는 페이지
      let drawerIdx = -1, word = null;
      for (let t = 0; t < 40 && drawerIdx < 0; t++) {
        for (let i = 0; i < names.length; i++) {
          const btn = names[i].locator('#word-options .word-option:not([disabled])');
          if (await btn.count() > 0 && await btn.first().isVisible()) {
            drawerIdx = i;
            const count = await btn.count();
            if (turn === 1) check(count === 3, `턴${turn}: 단어 후보 3개`, count);
            word = (await btn.first().textContent()).trim();
            break;
          }
        }
        if (drawerIdx < 0) await sleep(250);
      }
      check(drawerIdx >= 0, `턴${turn}: 출제자 화면에 단어 선택 오버레이`, nick[drawerIdx]);
      const drawer = names[drawerIdx];
      const guessers = names.filter((_, i) => i !== drawerIdx);
      const gNick = nick.filter((_, i) => i !== drawerIdx);

      // 비출제자는 후보를 못 봐야 함
      for (let i = 0; i < guessers.length; i++) {
        const txt = await guessers[i].locator('#overlay-choosing').textContent();
        check(!txt.includes(word), `턴${turn}: ${gNick[i]} 화면에 단어 후보 노출 없음`);
      }
      if (turn === 1) await drawer.screenshot({ path: path.join(SHOTS, 'e2e-choosing.png') });
      await drawer.locator('#word-options .word-option').first().click();
      await drawer.waitForSelector('#overlay-choosing', { state: 'hidden', timeout: 5000 });
      await sleep(400);

      // 마스크 확인
      const maskTxt = (await guessers[0].locator('#word-area').textContent()).replace(/\s+/g, '');
      const boxes = await guessers[0].locator('#word-area .mask-box').count();
      const revealed = await guessers[0].locator('#word-area .mask-box.revealed').count();
      check(boxes > 0 && revealed === 0 && !maskTxt.includes(word), `턴${turn}: 정답 대신 마스크 표시`, `boxes=${boxes} ${maskTxt.slice(0, 30)}`);
      check((await drawer.locator('#word-area').textContent()).includes(word), `턴${turn}: 출제자에게 단어 표시`);
      check(await drawer.locator('#toolbar').isVisible(), `턴${turn}: 출제자에게 툴바 표시`);
      check(!(await guessers[0].locator('#toolbar').isVisible()), `턴${turn}: 비출제자 툴바 숨김`);

      // 그리기 → 중계 확인
      await drawScribble(drawer);
      await sleep(700);
      const own = await nonWhitePixels(drawer);
      const remote = await nonWhitePixels(guessers[0]);
      check(own > 500, `턴${turn}: 출제자 캔버스에 그림`, own);
      check(remote > 500 && Math.abs(remote - own) / own < 0.15, `턴${turn}: 비출제자 캔버스에 중계(픽셀 오차<15%)`, `${remote} vs ${own}`);

      if (turn === 1) {
        // 언두 → 양쪽 동일하게 줄어드는지
        await drawer.click('#btn-undo');
        await sleep(500);
        const own2 = await nonWhitePixels(drawer), remote2 = await nonWhitePixels(guessers[0]);
        check(own2 < own && Math.abs(remote2 - own2) <= Math.max(50, own2 * 0.15), `턴${turn}: 언두 동기화`, `${own2} / ${remote2}`);
        // 채우기
        await drawer.click('[data-tool="fill"]');
        const box = await drawer.locator('#canvas').boundingBox();
        await drawer.mouse.click(box.x + 20, box.y + 20);
        await sleep(600);
        const own3 = await nonWhitePixels(drawer), remote3 = await nonWhitePixels(guessers[1]);
        check(own3 > own2 + 10000, `턴${turn}: 채우기 적용`, own3);
        check(Math.abs(remote3 - own3) / own3 < 0.05, `턴${turn}: 채우기 중계(오차<5%)`, `${remote3} vs ${own3}`);
        await drawer.click('[data-tool="pen"]');
        await guessers[0].screenshot({ path: path.join(SHOTS, 'e2e-drawing-guesser.png') });
        await drawer.screenshot({ path: path.join(SHOTS, 'e2e-drawing-drawer.png') });
      }

      // 틀린 추측 → 일반 채팅으로 모두에게
      await say(guessers[0], '완전틀린답');
      await sleep(300);
      check((await drawer.locator('#chat-list').textContent()).includes('완전틀린답'), `턴${turn}: 오답은 일반 채팅으로 전달`);

      // 근접 추측 (마지막 글자 변경) → 보낸 사람에게만 close
      if (word.length >= 3) {
        const close = word.slice(0, -1) + (word.endsWith('a') ? 'b' : 'a');
        await say(guessers[0], close);
        await sleep(300);
        const lastMsg = await guessers[0].locator('#chat-list > *:last-child').textContent().catch(() => '');
        check((await guessers[0].locator('#chat-list').textContent()).includes('거의'), `턴${turn}: 근접 정답 안내(보낸 사람)`, `word=${word} guess=${close} last=${lastMsg.trim().slice(0, 40)}`);
        check(!(await guessers[1].locator('#chat-list').textContent()).includes('거의'), `턴${turn}: 근접 안내는 다른 사람에게 미노출`);
      }

      // 정답
      await say(guessers[0], word);
      await sleep(400);
      const chatAll = await guessers[1].locator('#chat-list').textContent();
      check(chatAll.includes('정답을 맞혔습니다'), `턴${turn}: 정답 시스템 메시지 브로드캐스트`);
      check(!chatAll.split('정답을 맞혔습니다')[0].includes(word) || turn > 1, `턴${turn}: 정답 단어 자체는 미노출`);

      // 정답자 채팅은 출제자+정답자에게만 (턴별 고유 문구로 이전 턴 기록과 구분)
      const secret = '비밀채팅' + turn;
      await say(guessers[0], secret);
      await sleep(300);
      check((await drawer.locator('#chat-list').textContent()).includes(secret), `턴${turn}: 정답자 채팅 -> 출제자 수신`);
      check(!(await guessers[1].locator('#chat-list').textContent()).includes(secret), `턴${turn}: 정답자 채팅 -> 미정답자 미노출`);

      // 중간 참가 (턴 2 drawing 중)
      if (turn === 2 && !joinedLate) {
        const late = await joinAs(ctxs[3], '늦둥이', code);
        await sleep(800);
        const latePx = await nonWhitePixels(late);
        check(latePx > 500, '중간 참가자 draw:sync로 캔버스 복원', latePx);
        const lateBoxes = await late.locator('#word-area .mask-box').count();
        check(lateBoxes > 0, '중간 참가자에게 마스크 표시', 'boxes=' + lateBoxes);
        check((await late.locator(PLAYER_SEL).count()) === 4, '중간 참가자 플레이어 목록 4명');
        await late.screenshot({ path: path.join(SHOTS, 'e2e-late-join.png') });
        joinedLate = true;
        names.push(late); nick.push('늦둥이');
        guessers.push(late); // 중간 참가자도 정답을 맞혀야 allGuessed로 턴이 끝난다
      }

      // 나머지 정답 → allGuessed로 턴 종료
      for (const g of guessers.slice(1)) await say(g, word);
      await guessers[1].waitForSelector('#overlay-turnend:not([hidden])', { timeout: 8000 }).catch(() => {});
      await sleep(300);
      const tw = await guessers[1].locator('#turnend-word').textContent();
      check(tw.includes(word), `턴${turn}: 턴 종료 오버레이에 정답 표시`, tw.trim());
      const deltas = await guessers[1].locator('#turnend-deltas').textContent();
      check(/\+\d+/.test(deltas), `턴${turn}: 점수 델타 표시`);
      if (turn === 1) await guessers[1].screenshot({ path: path.join(SHOTS, 'e2e-turnend.png') });
      // 다음 턴 시작 대기
      await guessers[1].waitForSelector('#overlay-turnend', { state: 'hidden', timeout: 10000 }).catch(() => {});
      await sleep(300);
    }

    await host.waitForSelector('#overlay-gameover:not([hidden])', { timeout: 15000 });
    await sleep(500);
    const rank = await host.locator('#ranking-list').textContent();
    check(rank.length > 0 && /\d+/.test(rank), '게임 종료 랭킹 표시');
    await host.screenshot({ path: path.join(SHOTS, 'e2e-gameover.png') });

    // 랭킹 내림차순
    const scores = await host.$$eval('#ranking-list li', (els) =>
      els.map((e) => parseInt((e.textContent.match(/(\d+)\s*점/) || [0, 0])[1], 10)));
    check(scores.length >= 3 && scores.every((s, i) => i === 0 || s <= scores[i - 1]), '랭킹 점수 내림차순', scores.join(','));

    // 10초 후 로비 복귀
    await host.waitForSelector('#settings-panel:not([hidden])', { timeout: 15000 });
    check(await host.locator('#btn-start').isVisible(), '게임 종료 후 로비 복귀');

    // 나가기 → 호스트 이전
    await host.click('#btn-leave');
    await sleep(500);
    check(await host.locator('#view-landing').isVisible(), '나가기 후 랜딩 복귀');
    check(!(await p2.locator('#set-rounds').isDisabled()), '호스트 이전(다음 사람이 설정 가능)');
    check((await p2.locator(PLAYER_SEL).count()) === 3, '퇴장 후 플레이어 3명');
  } catch (e) {
    console.log('FAIL  예외:', e.message);
    failures++;
  } finally {
    clearTimeout(timeout);
    await browser.close();
    server.kill();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  }
})();
