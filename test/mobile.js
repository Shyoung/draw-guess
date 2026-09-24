/**
 * 모바일(iPhone 13, 390x664) 레이아웃 어설션 — 2차 모바일 UX 패스.
 *   node test/mobile.js        → PASS/FAIL 줄 출력, 실패가 있으면 exit 1
 *
 * 1회차(기본 단어) 확인 항목
 *  - 헤더(게임 중): #btn-leave/#room-code/#btn-copy/#btn-room-profile(설정) 가 헤더에 없고, #btn-menu → #sheet-menu 안에 들어 있다. 헤더 2행 이하
 *  - 턴 띠: #turn-strip 텍스트에 출제자 이름, 누르면 #sheet-players 에 플레이어 전원
 *  - 출제자: #chat-panel 이 흐름에 없음(display:none), #chat-ticker 가 최신 메시지 표시, 누르면 #sheet-chat(목록+입력)
 *  - 관전자: #canvas 와 #chat-input 이 스크롤 없이 뷰포트 안, 상태 띠에 #btn-chat-expand
 *  - 키보드 시뮬레이션: 뷰포트 390x360 → data-compact="1", 캔버스 ≥120px 4:3 유지·전부 보임, 입력창 보임, 말풍선(.chat-bubble) ≥1, 겹침 없음 → 664 복원 시 해제
 *  - 대기실: 페이지 스크롤 허용, 채팅은 접힌 바(#chat-bar) + #btn-chat-expand → #sheet-chat
 *  - choosing/turnEnd 오버레이 카드, gameOver(#btn-results-done 포함), 갤러리
 * 2회차(사용자 단어 12자+): 헤더 ≤ 2행(높이 ≤ 120px), 행 겹침 없음, 가로 스크롤 없음
 */
const { runMobileFlow, say, sleep } = require('./mobile-lib');

const VW = 390, VH = 664, KB_VH = 360;
let failures = 0;
function check(cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  -> ' + extra : ''}`);
  if (!cond) failures++;
}
const fmt = (b) => b ? `x${Math.round(b.x)} y${Math.round(b.y)} w${Math.round(b.width)} h${Math.round(b.height)}` : 'null';
function inside(b, vh) { vh = vh || VH; return !!b && b.width > 0 && b.height > 0 && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= VW + 0.5 && b.y + b.height <= vh + 0.5; }
function overlaps(a, b) { return !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height; }

async function box(page, sel) { return page.locator(sel).first().boundingBox().catch(() => null); }
async function metrics(page) {
  return page.evaluate(() => ({
    sh: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth,
    ih: window.innerHeight, iw: window.innerWidth, sy: window.scrollY,
    chatFont: parseFloat(getComputedStyle(document.getElementById('chat-input')).fontSize),
    phase: document.getElementById('view-room').getAttribute('data-phase'),
    role: document.getElementById('view-room').getAttribute('data-role'),
    compact: document.getElementById('view-room').getAttribute('data-compact'),
  }));
}
async function noPageScroll(page, label, vh) {
  vh = vh || VH;
  const m = await metrics(page);
  check(m.iw === VW && m.ih === vh, `${label}: 뷰포트 ${VW}x${vh}`, `${m.iw}x${m.ih}`);
  check(m.sh <= m.ih + 1, `${label}: 세로 페이지 스크롤 없음`, `scrollHeight=${m.sh} innerHeight=${m.ih}`);
  check(m.sw <= VW, `${label}: 가로 스크롤 없음`, `scrollWidth=${m.sw}`);
  return m;
}
async function display(page, sel) { return page.locator(sel).first().evaluate((e) => getComputedStyle(e).display).catch(() => 'missing'); }
async function openSheet(page, btnSel, sheetId) {
  await page.click(btnSel);
  await page.waitForSelector(`#${sheetId}:not([hidden])`, { timeout: 3000 });
  await page.waitForSelector(`#${sheetId}.open`, { timeout: 3000 }).catch(() => {});
  await sleep(300);
}
async function closeSheet(page, sheetId, how) {
  if (how === 'button') await page.click(`#${sheetId} .sheet-close`);
  else if (how === 'backdrop') await page.locator(`#${sheetId} .sheet-backdrop`).click({ position: { x: 10, y: 10 } });
  else if (how === 'drag') {
    // 손잡이를 아래로 200px 끌어 닫기
    const h = await page.locator(`#${sheetId} .sheet-handle`).boundingBox();
    const x = h.x + h.width / 2, y = h.y + h.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + i * 25, { steps: 2 });
    await page.mouse.up();
  } else if (how === 'back') {
    await page.goBack(); // 기기 뒤로가기 = history.back()
  } else await page.keyboard.press('Escape');
  await page.waitForSelector(`#${sheetId}`, { state: 'hidden', timeout: 3000 });
  await sleep(100);
}
/** 헤더가 2행(1행 라운드·타이머·⋯, 2행 단어)을 넘지 않고 행이 겹치지 않는다 */
async function headerChecks(page, label) {
  const tb = await box(page, '.topbar');
  check(tb && tb.height <= 120, `${label}: 헤더 높이 ≤ 120px(2행)`, tb && Math.round(tb.height));
  const ri = await box(page, '#round-indicator'), wa = await box(page, '#word-area'), tm = await box(page, '#timer'), mn = await box(page, '#btn-menu');
  check(ri && wa && ri.y + ri.height <= wa.y + 0.5, `${label}: 헤더 1행(라운드)과 2행(단어)이 겹치지 않음`, `${fmt(ri)} / ${fmt(wa)}`);
  check(tm && mn && !overlaps(tm, mn) && !overlaps(ri, tm), `${label}: 타이머·⋯·라운드 서로 겹치지 않음`, `${fmt(tm)} / ${fmt(mn)}`);
  check(inside(wa), `${label}: 단어 영역 뷰포트 안`, fmt(wa));
  const m = await metrics(page);
  check(m.sw <= VW, `${label}: 가로 스크롤 없음`, m.sw);
  for (const id of ['btn-leave', 'room-code', 'btn-copy', 'btn-room-profile']) {
    check((await page.locator(`.topbar #${id}`).count()) === 0, `${label}: 헤더에 #${id} 없음`);
  }
  check(await page.locator('#btn-menu').isVisible(), `${label}: ⋯ 메뉴 버튼 표시`);
}

async function mainRun() {
  await runMobileFlow(async (stage, ctx) => {
    const m = ctx.mobile;
    if (stage === 'landing') {
      const mm = await metrics(m);
      check(mm.sw <= VW, '랜딩(1단계): 가로 스크롤 없음', mm.sw);
      check(parseFloat(await m.locator('#nick').evaluate((e) => getComputedStyle(e).fontSize)) >= 16, '랜딩: 닉네임 입력 font-size ≥ 16px');
      check(await m.locator('#landing-step-profile').isVisible() && await m.locator('#landing-step-room').isHidden(), '랜딩: 첫 방문은 프로필 설정');
      check(await m.locator('#landing-step-start').isHidden() && await m.locator('#avatar-mode').isHidden(), '랜딩(로그인 꺼짐): 시작 단계 · 사진 탭 없음');
      check((await m.locator('.landing-card a[href="/privacy"]').count()) === 0 && (await m.locator('.landing-foot .privacy-link').count()) === 1, '랜딩: 개인정보 처리방침 링크는 카드 밖(페이지 맨 아래)');
      const pv = await box(m, '.landing-foot .privacy-link');
      check(pv && Math.abs(pv.x + pv.width / 2 - VW / 2) <= 2, '랜딩: 처리방침 링크 가로 가운데', fmt(pv));
      const card = await box(m, '.landing-card');
      check(card && card.x <= 16.5 && card.x + card.width >= VW - 16.5, '랜딩: 카드가 거의 전체 폭(좌우 여백 ≤ 16px)', fmt(card));
      const cb = await box(m, '#color-row .color-btn'), eb = await box(m, '#emoji-strip .emoji-btn'), nb = await box(m, '#btn-profile-next');
      check(cb && cb.width >= 32 && cb.height >= 32, '랜딩: 색상 버튼 탭 영역 ≥ 32px', fmt(cb));
      check(eb && eb.height >= 36, '랜딩: 얼굴 버튼 높이 ≥ 36px', fmt(eb));
      check(nb && nb.height >= 44, '랜딩: "다음" 버튼 높이 ≥ 44px', fmt(nb));
    }
    if (stage === 'landing-room') {
      const mm = await metrics(m);
      check(mm.sw <= VW, '랜딩(2단계): 가로 스크롤 없음', mm.sw);
      check((await m.locator('#me-name').textContent()).trim() === '모바일' && (await m.locator('#me-status').textContent()).trim() === '게스트', '랜딩(2단계): 프로필 요약(닉네임·게스트)');
      for (const sel of ['#btn-create', '#btn-join', '#room-code-input', '#btn-profile-edit']) {
        const b = await box(m, sel);
        check(inside(b) && b.height >= 38, `랜딩(2단계): ${sel} 화면 안 · 높이 ≥ 38px`, fmt(b));
      }
      check(parseFloat(await m.locator('#room-code-input').evaluate((e) => getComputedStyle(e).fontSize)) >= 16, '랜딩(2단계): 방 코드 입력 font-size ≥ 16px');
      const card2 = await box(m, '.landing-card'), pv2 = await box(m, '.landing-foot .privacy-link');
      check(card2 && pv2 && pv2.y >= card2.y + card2.height, '랜딩(2단계): 처리방침 링크는 카드 아래', `${fmt(card2)} / ${fmt(pv2)}`);
    }
    if (stage === 'lobby-mode') {
      const mm = await metrics(m);
      check(mm.phase === 'lobby', '로비: data-phase=lobby', mm.phase);
      check(mm.sw <= VW, '로비(모드): 가로 스크롤 없음', mm.sw);
      check(await m.locator('#timer').isHidden(), '로비: 타이머 원 숨김');
      check((await m.locator('#player-list li').count()) === 2, '로비: 플레이어 2명 칩 표시');
      check(await m.locator('#turn-strip').isHidden(), '로비: 턴 띠 숨김');
      check(await m.locator('.topbar #room-code').isVisible(), '로비: 방 코드는 헤더에 남김(공유용)');
      check((await m.locator('.topbar #btn-leave').count()) === 0 && (await m.locator('#sheet-menu #btn-leave').count()) === 1, '로비: 나가기는 메뉴 시트에');
    }
    if (stage === 'lobby-settings') {
      const mm = await metrics(m);
      check((await m.locator('#btn-start').count()) === 1, '로비(설정): #btn-start 존재');
      check(mm.chatFont >= 16, '채팅 입력 font-size ≥ 16px', mm.chatFont);
      check(mm.sw <= VW, '로비(설정): 가로 스크롤 없음', mm.sw);
      // 미니 채팅: 목록(최대 5줄) + 입력창이 보이고, 목록을 터치하면 시트
      const ml = await m.locator('#chat-panel #chat-list').evaluate((e) => ({ h: Math.round(e.getBoundingClientRect().height), maxH: getComputedStyle(e).maxHeight, vis: getComputedStyle(e).display !== 'none' }));
      check(ml.vis && ml.h <= 170, '로비: 미니 채팅 목록 표시(≤5줄, ≤170px)', JSON.stringify(ml));
      check(await m.locator('#chat-panel #chat-form').isVisible(), '로비: 미니 채팅 입력창 표시');
      check(await m.locator('#chat-bar').isHidden(), '로비: 접힌 바/펼치기 버튼은 없음');
      check((await m.locator('#chat-panel #chat-list').textContent()).includes('입장'), '로비: 미니 목록에 입장 메시지');
      await openSheet(m, '#chat-panel #chat-list', 'sheet-chat');
      check((await m.locator('#sheet-chat #chat-list').count()) === 1, '로비: 채팅 펼치기 → #sheet-chat 안에 #chat-list');
      const ci = await box(m, '#sheet-chat #chat-input');
      check(inside(ci), '로비: 채팅 시트 안 #chat-input 보임', fmt(ci));
      const lastMsg = await box(m, '#sheet-chat #chat-list > *:last-child');
      check(inside(lastMsg), '로비: 채팅 시트에 마지막 메시지 보임', fmt(lastMsg));
      await closeSheet(m, 'sheet-chat', 'backdrop');
      // 입력창을 터치하면 시트가 열리고 시트 안 입력창에 포커스
      await m.locator('#chat-panel #chat-input').dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true, cancelable: true, bubbles: true });
      await m.waitForSelector('#sheet-chat.open', { timeout: 3000 });
      await sleep(400);
      check(await m.evaluate(() => document.activeElement && document.activeElement.id === 'chat-input' && !!document.activeElement.closest('#sheet-chat')), '로비: 입력창 터치 → 시트 열리고 시트 안 입력창에 포커스');
      await closeSheet(m, 'sheet-chat', 'button');
      // 드래그로 닫기
      await openSheet(m, '#chat-panel #chat-list', 'sheet-chat');
      await closeSheet(m, 'sheet-chat', 'drag');
      check(await m.locator('#sheet-chat').isHidden(), '로비: 시트를 아래로 끌어 닫힘');
      // 기기 뒤로가기로 닫기 (방은 유지되어야 함)
      const urlBefore = m.url();
      await openSheet(m, '#chat-panel #chat-list', 'sheet-chat');
      await closeSheet(m, 'sheet-chat', 'back');
      check(await m.locator('#sheet-chat').isHidden(), '로비: 뒤로가기로 시트 닫힘');
      check(await m.locator('#view-room').isVisible() && m.url() === urlBefore, '로비: 뒤로가기 후에도 방 화면 유지', m.url());
      // 시트를 ✕로 닫은 뒤 뒤로가기를 눌러도 방을 떠나지 않아야 함 (우리가 넣은 history 항목이 정리됐는지)
      await openSheet(m, '#chat-panel #chat-list', 'sheet-chat');
      await closeSheet(m, 'sheet-chat', 'button');
      const histLen = await m.evaluate(() => history.state && history.state.sheet ? 'sheet-state-left' : 'clean');
      check(histLen === 'clean', '로비: ✕로 닫으면 시트용 history 항목이 정리됨', histLen);
      check((await m.locator('#chat-panel #chat-input').count()) === 1, '로비: 시트 닫으면 #chat-input 이 채팅 패널로 복귀');
    }
    if (stage === 'choosing-drawer') {
      const mm = await noPageScroll(m, 'choosing');
      check(mm.phase === 'choosing' && mm.role === 'drawer', 'choosing: data-phase/role', `${mm.phase}/${mm.role}`);
      const card = await box(m, '#overlay-choosing .card');
      check(inside(card), 'choosing: 단어 선택 카드가 뷰포트 안에', fmt(card));
      const opt = await box(m, '#word-options .word-option');
      check(inside(opt), 'choosing: 단어 후보 버튼이 보임', fmt(opt));
      const ov = await m.locator('#overlay-choosing').evaluate((e) => { const r = e.getBoundingClientRect(); return [getComputedStyle(e).position, Math.round(r.width), Math.round(r.height)]; });
      check(ov[0] === 'fixed' && ov[1] === VW && ov[2] === VH, 'choosing: 오버레이가 화면 전체(fixed)', ov.join(' '));
      check((await m.locator('#turn-strip').textContent()).includes('모바일'), 'choosing: 턴 띠에 출제자(나) 이름');
    }
    if (stage === 'drawing-drawer') {
      const mm = await noPageScroll(m, 'drawing(출제자)');
      check(mm.role === 'drawer', 'drawing(출제자): data-role=drawer', mm.role);
      await headerChecks(m, 'drawing(출제자)');
      const c = await box(m, '#canvas'), t = await box(m, '#toolbar');
      check(inside(c), 'drawing(출제자): #canvas 뷰포트 안', fmt(c));
      check(c && Math.abs(c.width / c.height - 4 / 3) < 0.02, 'drawing(출제자): 캔버스 4:3', c && (c.width / c.height).toFixed(3));
      check(inside(t), 'drawing(출제자): #toolbar 뷰포트 안', fmt(t));
      check(t && t.height <= 100, 'drawing(출제자): 툴바 높이 ≤ 100px', t && Math.round(t.height));
      check(c && t && c.y + c.height <= t.y + 0.5, 'drawing(출제자): 툴바가 캔버스 위에 겹치지 않음', `${fmt(c)} / ${fmt(t)}`);
      check(t && t.y + t.height >= VH - 40, 'drawing(출제자): 툴바(팔레트)가 화면 하단에 고정', t && Math.round(t.y + t.height));
      const cw = await box(m, '#canvas-wrap');
      check(c && cw && Math.abs(c.width - cw.width) <= 2, 'drawing(출제자): 캔버스가 래퍼를 채움', `${fmt(c)} in ${fmt(cw)}`);
      const pal = await m.locator('#palette').evaluate((e) => [Math.round(e.getBoundingClientRect().height), e.scrollWidth > e.clientWidth]);
      check(pal[0] <= 40 && pal[1], 'drawing(출제자): 팔레트 한 줄 + 가로 스크롤', pal.join(' '));
      check((await m.locator('#custom-color-input').count()) === 1, 'drawing(출제자): 커스텀 색상 피커 존재');
      const px = await m.evaluate(() => { const c = document.getElementById('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 250) n++; return n; });
      check(px > 300, 'drawing(출제자): 터치/마우스로 그린 획이 캔버스에', px);
      // 채팅 패널은 흐름에 없고 티커가 대신한다
      check((await display(m, '#chat-panel')) === 'none', 'drawing(출제자): #chat-panel 흐름에서 제외(display:none)');
      const dc = await box(m, '#drawer-chat'), ts = await box(m, '#turn-strip');
      const dcText = (await m.locator('#drawer-chat').textContent()).trim();
      check(inside(dc) && ts && dc.y >= ts.y + ts.height - 0.5 && dc.y + dc.height <= c.y + 0.5, 'drawing(출제자): 채팅 버블 영역이 턴 띠와 캔버스 사이', `${fmt(ts)} / ${fmt(dc)} / ${fmt(c)}`);
      check(dcText.includes('아무말'), 'drawing(출제자): 버블 영역에 최신 메시지', dcText.slice(0, 40));
      check((await m.locator('#drawer-chat .chat-bubble').count()) >= 1, 'drawing(출제자): 버블 1개 이상');
      check((await m.locator('.center-panel #drawer-chat').count()) === 0 && (await m.locator('.room-grid > #drawer-chat').count()) === 1, 'drawing(출제자): 채팅 버블 영역이 캔버스 패널과 분리된 독립 카드');
      const cpBox = await box(m, '.center-panel');
      check(dc && cpBox && dc.y + dc.height <= cpBox.y + 0.5, 'drawing(출제자): 버블 카드가 캔버스 패널 위쪽에 있고 겹치지 않음', `${fmt(dc)} / ${fmt(cpBox)}`);
      check(await m.locator('#chat-ticker').isHidden(), 'drawing(출제자): 캔버스 위 티커는 숨김(버블 영역으로 대체)');
      check(c && Math.abs((c.y + c.height) - t.y) <= 12, 'drawing(출제자): 캔버스와 팔레트가 한 묶음(간격 ≤ 12px)', `${Math.round(c.y + c.height)} vs ${Math.round(t.y)}`);
      // 턴 띠 → 플레이어 시트
      const strip = await box(m, '#turn-strip'), stripText = (await m.locator('#turn-strip').textContent()).replace(/\s+/g, ' ').trim();
      check(inside(strip) && strip.height <= 48, 'drawing(출제자): 턴 띠 한 줄(≤48px)', fmt(strip));
      check(stripText.includes('모바일') && stripText.includes('그리는 중'), 'drawing(출제자): 턴 띠에 출제자 이름', stripText);
      check(stripText.includes('다음') && stripText.includes('데스크톱'), 'drawing(출제자): 턴 띠에 다음 출제자', stripText);
      check(/정답 0\/1/.test(stripText), 'drawing(출제자): 턴 띠에 정답 0/1', stripText);
      await openSheet(m, '#turn-strip', 'sheet-players');
      check((await m.locator('#sheet-player-list li').count()) === 2, 'drawing(출제자): 플레이어 시트에 2명');
      check((await m.locator('#sheet-player-list li.drawing .badge-drawer').count()) === 1, 'drawing(출제자): 시트 목록에 ✏️ 배지');
      check((await m.locator('#sheet-player-list li .kick').count()) === 1, 'drawing(출제자): 호스트에게 강퇴 ✕ (상대 1명)');
      const li = await box(m, '#sheet-player-list li');
      check(inside(li), 'drawing(출제자): 시트 목록 항목 보임', fmt(li));
      await closeSheet(m, 'sheet-players', 'esc');
      // ⋯ → 메뉴 시트
      await openSheet(m, '#btn-menu', 'sheet-menu');
      for (const id of ['btn-leave', 'room-code', 'btn-copy', 'btn-room-profile']) {
        const b = await box(m, `#sheet-menu #${id}`);
        check((await m.locator(`#sheet-menu #${id}`).count()) === 1 && inside(b), `drawing(출제자): 메뉴 시트 안 #${id} 보임`, fmt(b));
      }
      check((await m.locator('#sheet-menu #room-code').textContent()).trim().length === 4, 'drawing(출제자): 메뉴 시트의 방 코드 4글자');
      await closeSheet(m, 'sheet-menu', 'button');
      check(await m.locator('#sheet-menu').isHidden(), 'drawing(출제자): 메뉴 시트 닫힘');
      // 버블 영역 → 채팅 시트(출제자도 정답자와 대화 가능)
      await openSheet(m, '#drawer-chat', 'sheet-chat');
      const sci = await box(m, '#sheet-chat #chat-input'), scl = await box(m, '#sheet-chat #chat-list');
      check(inside(sci), 'drawing(출제자): 채팅 시트 #chat-input 보임', fmt(sci));
      check(scl && scl.height >= 100, 'drawing(출제자): 채팅 시트 목록 충분히 큼(≥100px)', scl && Math.round(scl.height));
      check((await m.locator('#sheet-chat #chat-list').textContent()).includes('아무말'), 'drawing(출제자): 채팅 시트에 전체 기록');
      await closeSheet(m, 'sheet-chat', 'esc');
      check((await m.locator('#chat-panel #chat-list').count()) === 1, 'drawing(출제자): 시트 닫으면 #chat-list 복귀');
      await noPageScroll(m, 'drawing(출제자, 시트 후)');
    }
    if (stage === 'turnend') {
      await noPageScroll(m, 'turnEnd');
      const card = await box(m, '#overlay-turnend .card'), dl = await box(m, '#turnend-deltas');
      check(inside(card), 'turnEnd: 카드가 뷰포트 안에', fmt(card));
      check(inside(dl), 'turnEnd: 점수 델타 목록이 보임', fmt(dl));
    }
    if (stage === 'drawing-guesser') {
      const mm = await noPageScroll(m, 'drawing(관전자)');
      check(mm.phase === 'drawing' && mm.role === 'guesser', 'drawing(관전자): data-phase/role', `${mm.phase}/${mm.role}`);
      check((await m.locator('#turn-strip .ts-av').count()) === 1, 'drawing(관전자): 턴 띠에 그리는 사람 아바타');
      check(!mm.compact, 'drawing(관전자): 664px 에서는 컴팩트 아님', mm.compact);
      await headerChecks(m, 'drawing(관전자)');
      // 게임 중 기기 뒤로가기 → "방을 나갈까요?"(게임 문구) → 계속 있기
      await m.goBack();
      await m.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 }).catch(() => {});
      check(await m.locator('#overlay-leave').isVisible() && await m.locator('#view-room').isVisible(), 'drawing: 뒤로가기 → 나가기 확인(방 유지)');
      check((await m.locator('#leave-desc').textContent()).includes('게임'), 'drawing: 확인 문구에 게임에서 빠진다는 안내', await m.locator('#leave-desc').textContent());
      const lb = await box(m, '#overlay-leave .card-confirm');
      check(inside(lb), 'drawing: 확인 대화상자가 화면 안', fmt(lb));
      await m.click('#btn-leave-cancel');
      check(await m.locator('#overlay-leave').isHidden() && await m.locator('#view-room').isVisible(), 'drawing: 계속 있기 → 게임 유지');
      // 게임 중 설정: 효과음만(프로필은 대기실에서)
      await m.click('#btn-menu');
      await m.waitForSelector('#sheet-menu.open', { timeout: 3000 });
      await m.click('#sheet-menu #btn-room-profile');
      await m.waitForSelector('#sheet-profile.open', { timeout: 3000 });
      await sleep(350);
      check(await m.locator('#sheet-profile #btn-sound').isVisible() && await m.locator('#room-profile-locked').isVisible() && (await m.locator('#sheet-profile #landing-step-profile').count()) === 0, 'drawing: 설정 = 효과음 + "대기실에서 바꿀 수 있어요"(프로필 폼 없음)');
      const snd0 = await m.getAttribute('#btn-sound', 'aria-checked');
      await m.click('#btn-sound');
      check((await m.getAttribute('#btn-sound', 'aria-checked')) !== snd0 && (await m.textContent('#sound-state')) === (snd0 === 'true' ? '꺼짐' : '켜짐'), 'drawing: 효과음 스위치 전환');
      await m.click('#btn-sound');
      await m.keyboard.press('Escape');
      await m.waitForSelector('#sheet-profile', { state: 'hidden', timeout: 3000 });
      check(await m.locator('#view-room').isVisible(), 'drawing: 설정 닫아도 게임 유지');
      const c = await box(m, '#canvas'), ci = await box(m, '#chat-input'), ds = await box(m, '#draw-status'), strip = await box(m, '#turn-strip');
      check(inside(c), 'drawing(관전자): #canvas 뷰포트 안', fmt(c));
      check(inside(ci), 'drawing(관전자): #chat-input 뷰포트 안', fmt(ci));
      check(inside(ds), 'drawing(관전자): 👍👎 상태 띠 뷰포트 안', fmt(ds));
      check(c && Math.abs(c.width / c.height - 4 / 3) < 0.02, 'drawing(관전자): 캔버스 4:3', c && (c.width / c.height).toFixed(3));
      check(await m.locator('#toolbar').isHidden(), 'drawing(관전자): 툴바 숨김');
      check((await display(m, '#chat-panel')) !== 'none', 'drawing(관전자): 채팅 패널 흐름에 있음');
      const list = await m.locator('#chat-list').evaluate((e) => ({ h: Math.round(e.getBoundingClientRect().height), ov: getComputedStyle(e).overflowY }));
      check(list.h >= 56 && list.ov === 'auto', 'drawing(관전자): 채팅 목록 내부 스크롤(≥2줄)', JSON.stringify(list));
      check(mm.chatFont >= 16, 'drawing(관전자): 채팅 입력 font-size ≥ 16px', mm.chatFont);
      check(inside(strip) && strip.height <= 48, 'drawing(관전자): 턴 띠 높이 ≤ 48px', fmt(strip));
      const stripText = (await m.locator('#turn-strip').textContent()).replace(/\s+/g, ' ').trim();
      check(stripText.includes('데스크톱') && stripText.includes('그리는 중'), 'drawing(관전자): 턴 띠에 출제자 이름', stripText);
      check((await m.locator('#draw-status #btn-chat-expand').count()) === 1 && await m.locator('#btn-chat-expand').isVisible(), 'drawing(관전자): 상태 띠에 ⤢ 펼치기 버튼');
      check(await m.locator('#chat-bubbles').isHidden(), 'drawing(관전자): 비컴팩트에서는 말풍선 숨김');
      check(await m.locator('#chat-ticker').isHidden(), 'drawing(관전자): 티커는 출제자 전용(숨김)');
      // 겹침 없음: 헤더 → 턴 띠 → 가운데 → 채팅 순서로 아래로만
      const tb = await box(m, '.topbar');
      check(tb && strip && c && ci && tb.y + tb.height <= strip.y + 0.5 && strip.y + strip.height <= c.y + 0.5 && ds.y + ds.height <= ci.y + 0.5, 'drawing(관전자): 요소가 세로로 겹치지 않음', `${fmt(tb)} ${fmt(strip)} ${fmt(c)} ${fmt(ds)} ${fmt(ci)}`);

      // ---- 키보드 시뮬레이션: visualViewport 가 360px 로 줄면 컴팩트 모드 ----
      await m.setViewportSize({ width: VW, height: KB_VH });
      await m.waitForSelector('#view-room[data-compact="1"]', { timeout: 3000 }).catch(() => {});
      await sleep(250);
      const km = await noPageScroll(m, 'keyboard(360px)', KB_VH);
      check(km.compact === '1', 'keyboard: data-compact="1"', km.compact);
      const kc = await box(m, '#canvas'), ki = await box(m, '#chat-input'), kf = await box(m, '#chat-form');
      check(kc && kc.height >= 120, 'keyboard: 캔버스 높이 ≥ 120px', kc && Math.round(kc.height));
      check(inside(kc, KB_VH), 'keyboard: 캔버스 전부 보임', fmt(kc));
      check(kc && Math.abs(kc.width / kc.height - 4 / 3) < 0.02, 'keyboard: 캔버스 4:3 유지', kc && (kc.width / kc.height).toFixed(3));
      check(inside(ki, KB_VH), 'keyboard: #chat-input 전부 보임', fmt(ki));
      check(kf && kf.y + kf.height >= KB_VH - 20, 'keyboard: 입력줄이 visualViewport 바닥에 붙음', fmt(kf));
      check(kc && kf && kc.y + kc.height <= kf.y + 0.5, 'keyboard: 캔버스와 입력줄 겹침 없음', `${fmt(kc)} / ${fmt(kf)}`);
      check(await m.locator('#chat-panel #chat-list').isHidden(), 'keyboard: 채팅 목록 숨김');
      check(await m.locator('#draw-status').isHidden(), 'keyboard: 상태 띠 숨김(공간 확보)');
      await say(m, '컴팩트테스트');
      await m.waitForFunction(() => { const b = document.querySelectorAll('#chat-bubbles .chat-bubble'); return b.length >= 1 && (b[b.length - 1].textContent || '').includes('컴팩트테스트'); }, null, { timeout: 3000 }).catch(() => {}); // 시스템 메시지 말풍선이 먼저 있을 수 있으니 내 메시지가 올 때까지
      const nb = await m.locator('#chat-bubbles .chat-bubble').count();
      check(nb >= 1 && nb <= 3, 'keyboard: 캔버스 위 말풍선 1~3개', nb);
      const lastBubble = (await m.locator('#chat-bubbles .chat-bubble').last().textContent().catch(() => '')).trim();
      check(lastBubble.includes('컴팩트테스트'), 'keyboard: 마지막 말풍선이 내 메시지', lastBubble.slice(0, 40));
      const bb = await box(m, '#chat-bubbles');
      check(inside(bb, KB_VH) && overlaps(bb, kc), 'keyboard: 말풍선이 캔버스 위(안쪽)에', fmt(bb));
      const kci = await box(m, '#chat-input');
      check(inside(kci, KB_VH), 'keyboard: 메시지 후에도 #chat-input 보임', fmt(kci));
      await m.setViewportSize({ width: VW, height: VH });
      await m.waitForSelector('#view-room:not([data-compact])', { timeout: 3000 }).catch(() => {});
      await sleep(250);
      const rm = await noPageScroll(m, 'keyboard 복원(664px)');
      check(!rm.compact, 'keyboard 복원: 컴팩트 해제', rm.compact);
      check(await m.locator('#chat-panel #chat-list').isVisible(), 'keyboard 복원: 채팅 목록 다시 표시');
      const rc = await box(m, '#canvas');
      check(rc && Math.abs(rc.width - c.width) < 2, 'keyboard 복원: 캔버스 원래 크기', `${Math.round(rc.width)} vs ${Math.round(c.width)}`);
      // ⤢ 펼치기 → 채팅 시트 전체화면
      await openSheet(m, '#btn-chat-expand', 'sheet-chat');
      const sp = await box(m, '#sheet-chat .sheet-panel');
      check(sp && sp.height >= VH * 0.8, 'drawing(관전자): 채팅 시트가 화면 대부분(≥80%)', sp && Math.round(sp.height));
      check(inside(await box(m, '#sheet-chat #chat-input')), 'drawing(관전자): 채팅 시트 #chat-input 보임');
      await closeSheet(m, 'sheet-chat', 'esc');
      check((await m.locator('#chat-panel #chat-input').count()) === 1, 'drawing(관전자): 시트 닫으면 #chat-input 복귀');
    }
    if (stage === 'drawing-guesser-chat') {
      await noPageScroll(m, 'drawing(관전자, 채팅 후)');
      const ci = await box(m, '#chat-input');
      check(inside(ci), 'drawing(관전자, 채팅 후): #chat-input 여전히 뷰포트 안', fmt(ci));
      const last = (await m.locator('#chat-list > *:last-child').textContent()).trim();
      check(last.includes('틀린답'), 'drawing(관전자): 내 채팅이 목록 끝에', last.slice(0, 30));
      const lastBox = await box(m, '#chat-list > *:last-child');
      check(inside(lastBox), 'drawing(관전자): 마지막 채팅이 보임(자동 스크롤)', fmt(lastBox));
    }
    if (stage === 'gameover') {
      const rl = await box(m, '#ranking-list'), bg = await box(m, '#btn-gallery-open'), pod = await box(m, '#podium'), tm = await box(m, '#btn-results-done');
      check(inside(rl), 'gameOver: #ranking-list 뷰포트 안', fmt(rl));
      check(inside(bg), 'gameOver: #btn-gallery-open 뷰포트 안', fmt(bg));
      check(inside(pod), 'gameOver: 포디움 뷰포트 안', fmt(pod));
      check(inside(tm), 'gameOver: "대기실로 돌아가기" 버튼 뷰포트 안', fmt(tm));
      check(await m.locator('#btn-gallery-open').isVisible(), 'gameOver: 갤러리 버튼 visible');
      const mm = await metrics(m);
      check(mm.sw <= VW, 'gameOver: 가로 스크롤 없음', mm.sw);
    }
    if (stage === 'gallery') {
      const mm = await metrics(m);
      check(mm.sw <= VW, '갤러리: 가로 스크롤 없음', mm.sw);
      const cols = await m.locator('#gallery-grid').evaluate((e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
      check(cols === 2, '갤러리: 2열', cols);
      const n = await m.locator('#gallery-grid .gallery-item').count();
      check(n === 2, '갤러리: 2장', n);
      const lines = await m.locator('#gallery-grid .gallery-by').first().evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)));
      check(lines === 1, '갤러리: 메타 한 줄', lines);
      const btn = await box(m, '#gallery-grid .gallery-item .btn');
      check(inside(btn), '갤러리: PNG 버튼 보임', fmt(btn));
    }
  }, { onPageError: () => { failures++; } });
}

const LONG_WORDS = '아이스아메리카노한잔, 딸기바나나초코스무디, 민트초코칩아이스크림콘';
async function longWordRun() {
  await runMobileFlow(async (stage, ctx) => {
    const m = ctx.mobile;
    if (stage === 'drawing-drawer') {
      const w = (await m.locator('.word-secret .word').textContent().catch(() => '')).trim();
      check(w.length >= 10, '긴 단어(출제자): 단어 10자 이상', w);
      await headerChecks(m, '긴 단어(출제자)');
      await noPageScroll(m, '긴 단어(출제자)');
      check(inside(await box(m, '.word-secret .word')), '긴 단어(출제자): 단어 텍스트 뷰포트 안');
      check(inside(await box(m, '#toolbar')), '긴 단어(출제자): 툴바 여전히 뷰포트 안');
    }
    if (stage === 'drawing-guesser') {
      const len = Number(await m.locator('.mask-wrap').getAttribute('data-len').catch(() => 0));
      const size = await m.locator('.mask-wrap').getAttribute('data-size').catch(() => null);
      check(len >= 10, '긴 단어(관전자): 마스크 data-len ≥ 10', len);
      check(size === 'm' || size === 'l', '긴 단어(관전자): 마스크 data-size m/l', size);
      const bw = await m.locator('.mask-box').first().evaluate((e) => e.getBoundingClientRect().width);
      check(bw <= 20.5, '긴 단어(관전자): 마스크 칸 축소(≤20px)', bw);
      await headerChecks(m, '긴 단어(관전자)');
      await noPageScroll(m, '긴 단어(관전자)');
      check(inside(await box(m, '#canvas')), '긴 단어(관전자): 캔버스 뷰포트 안');
      check(inside(await box(m, '#chat-input')), '긴 단어(관전자): 입력창 뷰포트 안');
      const mw = await box(m, '.mask-wrap');
      check(inside(mw), '긴 단어(관전자): 마스크 전체가 뷰포트 안', fmt(mw));
    }
  }, { onPageError: () => { failures++; }, customWords: LONG_WORDS, wordCount: 2 });
}

(async () => {
  try {
    console.log('== 1회차: 기본 단어 ==');
    await mainRun();
    console.log('\n== 2회차: 긴 사용자 단어 ==');
    await longWordRun();
  } catch (e) {
    console.log('FAIL  예외:', e.message);
    failures++;
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
