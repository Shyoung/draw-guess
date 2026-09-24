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
  // 랜딩 1단계(프로필) → "다음" → 2단계(방)
  await page.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 });
  await page.fill('#nick', nick);
  await page.click('#btn-profile-next');
  await page.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
  if (code) {
    check((await page.inputValue('#room-code-input')).toUpperCase() === code, `${nick}: ?room= 코드 자동 입력`);
    check(await page.locator('#invite-card').isVisible() && (await page.textContent('#invite-code')).trim() === code, `${nick}: 초대받은 방 카드 표시`);
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

    // 모드 선택 단계: 호스트만 카드 활성, 비호스트는 대기 문구. 기본 모드 카드 선택 → 설정 화면
    check(await host.locator('#mode-panel').isVisible() && await host.locator('#settings-panel').isHidden(), '새 방은 모드 선택 화면부터');
    check(await p2.locator('#mode-panel .mode-card[data-mode="classic"]').isDisabled(), '비호스트는 모드 카드 비활성');
    check((await p2.locator('#mode-hint').textContent()).includes('고르고 있어요'), '비호스트 모드 대기 문구');
    await host.click('#mode-panel .mode-card[data-mode="classic"]');
    await host.waitForSelector('#settings-panel:not([hidden])', { timeout: 3000 });
    await p2.waitForSelector('#settings-panel:not([hidden])', { timeout: 3000 });
    check(await p2.locator('#settings-panel').isVisible(), '모드 선택 후 모든 참가자가 설정 화면으로');
    check((await host.locator('#mode-badge').textContent()).includes('돌아가며'), '설정 화면 모드 배지');
    check(await host.locator('#btn-mode-back').isVisible() && await p2.locator('#btn-mode-back').isHidden(), '모드 선택으로 돌아가기 버튼은 호스트만');
    check(await host.locator('#set-fixedDrawer-wrap').isHidden(), '기본 모드에서는 출제자 선택 숨김');

    // 설정 변경 → 다른 클라이언트에 반영
    await host.selectOption('#set-rounds', '1');
    await host.selectOption('#set-drawTime', '30');
    await host.selectOption('#set-hints', '1');
    // 단어를 3음절 이상 사용자 단어로 고정: 1글자 단어가 뽑히면 마스크·근접 정답 검사가 흔들리던 플레이크 제거
    await host.fill('#set-customWords', '자전거,냉장고,해바라기,고슴도치,선풍기,소방차,다람쥐,무지개,피라미드,헬리콥터,미끄럼틀,아이스크림');
    await host.locator('#set-customWords').blur();
    await host.check('#set-customWordsOnly');
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

      // 다음 출제자 표시: rounds=1(참가자 수만큼의 턴)이므로 마지막 턴(turn3)에는 다음 사람이 없어야 한다.
      const nextBadges = await guessers[0].locator('.player.next').count();
      if (turn < 3) {
        check(nextBadges === 1, `턴${turn}: 다음 출제자 배지 정확히 1명`, nextBadges);
        const nextText = await guessers[0].locator('.player.next .next-tag').first().textContent().catch(() => '');
        check(nextText.includes('다음'), `턴${turn}: 다음 출제자 태그 문구`, nextText);
      } else {
        check(nextBadges === 0, `턴${turn}: 마지막 턴에는 다음 출제자 배지 없음`, nextBadges);
      }

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

        // 커스텀 색상 피커: 고정 팔레트에 없는 임의의 색을 골라 실제로 그 색으로 그려지는지
        await drawer.locator('#custom-color-input').evaluate((el) => {
          el.value = '#123456'; el.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await drawer.waitForTimeout(150);
        const curBg = await drawer.locator('#current-color').evaluate((el) => getComputedStyle(el).backgroundColor);
        check(curBg === 'rgb(18, 52, 86)', `턴${turn}: 커스텀 색상 선택 시 현재 색상 표시 갱신`, curBg);
        check(
          await drawer.locator('#swatch-custom').evaluate((el) => el.classList.contains('active')),
          `턴${turn}: 커스텀 스와치 active 표시`,
        );
        const cbox2 = await drawer.locator('#canvas').boundingBox();
        const relX = 0.55, relY = 0.65;
        const ccx = cbox2.x + cbox2.width * relX, ccy = cbox2.y + cbox2.height * relY;
        await drawer.mouse.move(ccx, ccy);
        await drawer.mouse.down();
        await drawer.mouse.move(ccx + 30, ccy, { steps: 3 });
        await drawer.mouse.up();
        await sleep(400);
        const logicalX = Math.round(800 * relX), logicalY = Math.round(600 * relY);
        const customPx = await drawer.evaluate(({ x, y }) => {
          const cv = document.getElementById('canvas');
          const d = cv.getContext('2d').getImageData(x, y, 1, 1).data;
          return [d[0], d[1], d[2]];
        }, { x: logicalX, y: logicalY });
        check(
          customPx[0] === 18 && customPx[1] === 52 && customPx[2] === 86,
          `턴${turn}: 커스텀 색상으로 실제로 그려짐`, JSON.stringify(customPx),
        );
        const remoteCustomPx = await guessers[0].evaluate(({ x, y }) => {
          const cv = document.getElementById('canvas');
          const d = cv.getContext('2d').getImageData(x, y, 1, 1).data;
          return [d[0], d[1], d[2]];
        }, { x: logicalX, y: logicalY });
        check(
          remoteCustomPx[0] === 18 && remoteCustomPx[1] === 52 && remoteCustomPx[2] === 86,
          `턴${turn}: 커스텀 색상이 다른 사람에게도 중계`, JSON.stringify(remoteCustomPx),
        );
        await drawer.locator('.swatch[data-color="#000000"]').click();

        // 반응(👍/👎): 비출제자가 연타하면 모든 화면의 그 사람 아바타 위에 팝업이 뜨고 1초 뒤 사라진다
        const reactorId = await guessers[0].locator('#player-list li.me').getAttribute('data-id');
        check(!!reactorId, `턴${turn}: 플레이어 항목에 data-id`, reactorId);
        check(await guessers[0].locator('.react-btn.react-up').isVisible(), `턴${turn}: 비출제자에게 👍/👎 버튼 표시`);
        check((await drawer.locator('.react-btn').count()) === 0, `턴${turn}: 출제자에게는 반응 버튼 없음`);
        await guessers[0].locator('.react-btn.react-up').click({ clickCount: 1 });
        await guessers[0].locator('.react-btn.react-up').click({ clickCount: 1 });
        await guessers[0].locator('.react-btn.react-down').click({ clickCount: 1 });
        await sleep(250);
        const popsOnDrawer = await drawer.locator(`#player-list li[data-id="${reactorId}"] .react-pop`).count();
        const popsOnOther = await guessers[1].locator(`#player-list li[data-id="${reactorId}"] .react-pop`).count();
        const popsOnSelf = await guessers[0].locator(`#player-list li[data-id="${reactorId}"] .react-pop`).count();
        check(popsOnDrawer === 3 && popsOnOther === 3 && popsOnSelf === 3, `턴${turn}: 연타 3회 → 모든 화면에 팝업 3개(보낸 사람 아바타)`, `${popsOnDrawer}/${popsOnOther}/${popsOnSelf}`);
        check((await drawer.locator(`#player-list li[data-id="${reactorId}"] .react-pop.down`).count()) === 1, `턴${turn}: 👎 팝업 구분`);
        await drawer.screenshot({ path: path.join(SHOTS, 'e2e-reaction.png') });
        await sleep(1100);
        check((await drawer.locator('.react-pop').count()) === 0, `턴${turn}: 팝업은 1초 뒤 사라짐(기록 없음)`);

        await guessers[0].screenshot({ path: path.join(SHOTS, 'e2e-drawing-guesser.png') });
        await drawer.screenshot({ path: path.join(SHOTS, 'e2e-drawing-drawer.png') });
      }

      // 틀린 추측 → 일반 채팅으로 모두에게
      await say(guessers[0], '완전틀린답');
      await sleep(300);
      check((await drawer.locator('#chat-list').textContent()).includes('완전틀린답'), `턴${turn}: 오답은 일반 채팅으로 전달`);

      // 근접 추측 (마지막 글자 변경) → 보낸 사람에게만 close
      // 채팅 기록은 턴이 지나도 누적되므로(다른 턴에 이 플레이어가 근접 정답을 보낸 적 있을 수 있음),
      // 항상 "이 조작 직후 새로 추가된 마지막 메시지"만 비교한다.
      if (word.length >= 3) {
        const close = word.slice(0, -1) + (word.endsWith('a') ? 'b' : 'a');
        const beforeSelf = await guessers[0].locator('#chat-list > *').count();
        const beforeOther = await guessers[1].locator('#chat-list > *').count();
        await say(guessers[0], close);
        await guessers[0].waitForFunction(
          (n) => document.getElementById('chat-list').children.length > n, beforeSelf, { timeout: 3000 },
        ).catch(() => {});
        await sleep(200);
        const lastSelf = (await guessers[0].locator('#chat-list > *:last-child').textContent().catch(() => '')).trim();
        check(lastSelf.includes('거의'), `턴${turn}: 근접 정답 안내(보낸 사람)`, `word=${word} guess=${close} last=${lastSelf.slice(0, 40)}`);
        const afterOtherCount = await guessers[1].locator('#chat-list > *').count();
        const newOtherMsgs = afterOtherCount > beforeOther
          ? await guessers[1].locator('#chat-list > *').allTextContents().then((all) => all.slice(beforeOther))
          : [];
        check(!newOtherMsgs.some((t) => t.includes('거의')), `턴${turn}: 근접 안내는 다른 사람에게 미노출`, JSON.stringify(newOtherMsgs));
      }

      // 정답
      await say(guessers[0], word);
      await sleep(400);
      const chatAll = await guessers[1].locator('#chat-list').textContent();
      check(chatAll.includes('정답을 맞혔습니다'), `턴${turn}: 정답 시스템 메시지 브로드캐스트`);
      check(!chatAll.split('정답을 맞혔습니다')[0].includes(word) || turn > 1, `턴${turn}: 정답 단어 자체는 미노출`);

      // 정답을 맞힌 guessers[0]에게는 상단 단어가 실제 글자로 전체 공개되고 초록색으로 강조되어야 한다.
      // 아직 못 맞힌 guessers[1]에게는 여전히 마스크(초성/밑줄)만 보여야 한다.
      await guessers[0].waitForSelector('#word-area .mask-wrap.solved', { timeout: 3000 }).catch(() => {});
      const solvedText = (await guessers[0].locator('#word-area .mask-wrap.solved').textContent().catch(() => '')).replace(/\s+/g, '').replace(/\(.*\)$/, '');
      check(solvedText === word, `턴${turn}: 정답자 상단에 전체 공개(초록 강조)`, `solvedText=${solvedText} word=${word}`);
      const stillMasked = await guessers[1].locator('#word-area .mask-wrap.solved').count();
      check(stillMasked === 0, `턴${turn}: 아직 못 맞힌 사람은 전체 공개 아님`);

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

        // 새로고침 재접속: guessers[1]이 F5 → 같은 자리(점수 유지)로 자동 복귀, 그림도 복원
        const refresher = guessers[1];
        const beforeScore = (await refresher.locator('#player-list li.me .pscore').textContent()).trim();
        const beforeId = await refresher.locator('#player-list li.me').getAttribute('data-id');
        const beforeCount = await refresher.locator(PLAYER_SEL).count();
        await refresher.reload();
        await refresher.waitForSelector('#view-room:not([hidden])', { timeout: 8000 }).catch(() => {});
        await refresher.waitForSelector('#player-list li.me', { timeout: 8000 }).catch(() => {});
        await sleep(600);
        check(await refresher.locator('#view-room').isVisible(), '새로고침 후 자동으로 방에 복귀');
        const afterId = await refresher.locator('#player-list li.me').getAttribute('data-id');
        const afterScore = (await refresher.locator('#player-list li.me .pscore').textContent().catch(() => '')).trim();
        check(afterId === beforeId, '새로고침 후 같은 플레이어 id 유지', `${beforeId} → ${afterId}`);
        check(afterScore === beforeScore, '새로고침 후 점수 유지', `${beforeScore} → ${afterScore}`);
        check((await refresher.locator(PLAYER_SEL).count()) === beforeCount, '새로고침 후 플레이어 수 동일(중복 없음)', await refresher.locator(PLAYER_SEL).count());
        check((await nonWhitePixels(refresher)) > 500, '새로고침 후 그림 복원(draw:sync)');
        check((await refresher.locator('#word-area .mask-box').count()) > 0, '새로고침 후 마스크 표시');
        check((await drawer.locator('#chat-list').textContent()).includes('다시 연결되었습니다'), '다른 사람 채팅에 재연결 안내');
        check((await drawer.locator('#player-list li.offline').count()) === 0, '복귀 후 끊김 표시 없음');
        await refresher.screenshot({ path: path.join(SHOTS, 'e2e-after-reload.png') });
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

    // 갤러리: 3턴 모두 그림이 있었으므로 3장, 썸네일은 실제 PNG dataURL, 다운로드 버튼 존재
    check(await host.locator('#btn-gallery-open').isVisible(), '게임 종료 화면에 갤러리 버튼');
    await host.click('#btn-gallery-open');
    await host.waitForSelector('#overlay-gallery:not([hidden])', { timeout: 3000 });
    const gItems = await host.locator('#gallery-grid .gallery-item').count();
    check(gItems === 3, '갤러리에 턴 수만큼(3장) 그림', gItems);
    const srcs = await host.$$eval('#gallery-grid .gallery-item img', (imgs) => imgs.map((i) => i.src.slice(0, 22)));
    check(srcs.length === 3 && srcs.every((s) => s.startsWith('data:image/png;base64')), '썸네일이 PNG dataURL로 렌더링', srcs);
    const nonWhiteThumb = await host.$$eval('#gallery-grid .gallery-item img', (imgs) => {
      const img = imgs[0]; const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const c2 = cv.getContext('2d'); c2.drawImage(img, 0, 0); const d = c2.getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++; return n;
    });
    check(nonWhiteThumb > 500, '첫 장 썸네일에 실제 그림 픽셀', nonWhiteThumb);
    const words = await host.$$eval('#gallery-grid .gallery-word', (els) => els.map((e) => e.firstChild.textContent.trim()));
    check(words.every((w) => w.length > 0), '갤러리 카드마다 제시어 표시', words);
    check((await host.locator('#gallery-grid .gallery-item .btn').count()) === 3 && await host.locator('#btn-gallery-sheet').isVisible(), '개별 PNG 저장 버튼 3개 + 전체 저장 버튼');
    // 다운로드가 실제로 일어나는지 (Playwright download 이벤트)
    const dlPromise = host.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await host.locator('#gallery-grid .gallery-item .btn').first().click();
    const dl = await dlPromise;
    check(!!dl && /\.png$/.test(dl.suggestedFilename()), '개별 PNG 다운로드 파일명 .png', dl && dl.suggestedFilename());
    const dlSheet = host.waitForEvent('download', { timeout: 5000 }).catch(() => null);
    await host.click('#btn-gallery-sheet');
    const ds = await dlSheet;
    check(!!ds && /전체\.png$/.test(ds.suggestedFilename()), '전체 시트 PNG 다운로드', ds && ds.suggestedFilename());
    await host.screenshot({ path: path.join(SHOTS, 'e2e-gallery.png') });
    await host.click('#btn-gallery-close');
    check(await host.locator('#overlay-gallery').isHidden(), '갤러리 닫기');

    // 결과 화면은 각자 닫는다. 호스트가 먼저 닫으면 다른 사람이 아직 보고 있어 시작 불가
    await host.click('#btn-results-done');
    await host.waitForSelector('#overlay-gameover', { state: 'hidden', timeout: 3000 });
    await sleep(400);
    check(await host.locator('#btn-start').isDisabled(), '다른 사람이 결과를 보는 동안 시작 버튼 비활성');
    check((await host.locator('#start-hint').textContent()).includes('결과 화면'), '시작 힌트에 결과 보는 사람 안내', (await host.locator('#start-hint').textContent()).trim());
    for (const pg of names.slice(1)) { await pg.click('#btn-results-done'); }
    await host.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 5000 }).catch(() => {});
    check(!(await host.locator('#btn-start').isDisabled()), '모두 결과를 닫으면 시작 버튼 활성');

    // 랭킹 내림차순
    const scores = await host.$$eval('#ranking-list li', (els) =>
      els.map((e) => parseInt((e.textContent.match(/(\d+)\s*점/) || [0, 0])[1], 10)));
    check(scores.length >= 3 && scores.every((s, i) => i === 0 || s <= scores[i - 1]), '랭킹 점수 내림차순', scores.join(','));

    // 10초 후 로비 복귀
    await host.waitForSelector('#settings-panel:not([hidden])', { timeout: 5000 });
    check(await host.locator('#btn-start').isVisible(), '게임 종료 후 로비 복귀');
    check(await host.locator('#btn-gallery-lobby').isVisible(), '로비에 "지난 게임 그림 갤러리" 버튼 유지');
    check(await host.locator('#mode-panel').isHidden() && (await host.locator('#mode-badge').textContent()).includes('돌아가며'), '게임 종료 후 대기실은 설정 화면 + 모드 유지');

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
