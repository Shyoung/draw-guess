/**
 * 로그인 / 내 정보 / 단어 세트 UI 검증 (실제 Supabase 없이).
 *   node test/auth.js            → PASS/FAIL 줄 출력, 실패가 있으면 exit 1
 *
 * 1) 서버를 SUPABASE_* 환경 변수 없이 3130 포트로 띄운다 → /config.js 는 {} → 로그인 UI 가 전혀 보이지 않고 게임은 그대로 동작해야 한다.
 * 2) ?mock=1&auth=1&stay=1 : dev-mock.js 가 가짜 window.supabase + APP_CONFIG 를 설치한다(메모리 DB, 로그인된 상태로 시작).
 *    - 계정 칩 · 내 정보(프로필/닉네임 저장) · 단어 세트 생성(3단어)/목록/"이 세트로 방 설정"/수정/삭제 · 20개 제한 메시지 노출
 *    - 대기실 설정의 "내 세트 불러오기" 셀렉트 · "현재 단어를 세트로 저장" · 플레이어 목록에 ✔ 배지 없음(데이터 loggedIn 은 유지)
 *    - 로그아웃 → 칩 사라지고 로그인 버튼 표시 → 다시 로그인
 * 3) 모바일(iPhone 13): 내 정보가 바텀 시트(#sheet-account)로 열리고, 방 메뉴 시트에 "내 정보" 행이 있다.
 * 랜딩 2단계(1: #landing-step-profile 프로필/로그인 → 2: #landing-step-room 방 만들기/참가)
 *    - 첫 방문 1단계 · "다음"은 닉네임 1~12자일 때만 · 2단계 요약 카드 · 프로필 수정 → 1단계(값 유지) · 기기 뒤로가기 → 1단계
 *    - 저장된 프로필이면 새로고침 시 2단계 · ?room= 초대 카드 · 로그인(모크) 상태는 2단계 + 제공자 라벨 · 로그아웃 → 1단계
 */
const { spawn } = require('child_process');
const path = require('path');
const { chromium, devices } = require('playwright');

const PORT = 3130;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  -> ' + extra : ''}`);
  if (!cond) failures++;
}

async function startServer() {
  const env = { ...process.env, PORT: String(PORT) };
  delete env.SUPABASE_URL; delete env.SUPABASE_ANON_KEY; delete env.SUPABASE_SERVICE_ROLE_KEY;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[server:err] ' + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL + '/'); if (r.ok) return child; } catch {}
    await sleep(100);
  }
  throw new Error('server did not start');
}

async function newPage(browser, tag, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts || { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`[${tag}] pageerror: ${e.message}`); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${tag}] console.error: ${m.text()}`); });
  return page;
}
const val = (page, sel) => page.inputValue(sel);
const txt = async (page, sel) => (await page.locator(sel).first().textContent().catch(() => '') || '').trim();

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADFUL });
  const timeout = setTimeout(() => { console.log('FAIL  전체 타임아웃'); process.exit(2); }, 120000);
  try {
    // ---------- 0. 서버 설정 ----------
    const cfg = await (await fetch(URL + '/config.js')).text();
    check(/window\.APP_CONFIG\s*=\s*\{\s*\}/.test(cfg), 'Supabase 미설정: /config.js → APP_CONFIG = {}', cfg.trim());
    const health = await (await fetch(URL + '/healthz')).json();
    check(health.auth === false, 'Supabase 미설정: /healthz auth=false', JSON.stringify(health.auth));

    // ---------- 1. 게스트(로그인 꺼짐) + 랜딩 2단계 ----------
    console.log('\n== 게스트(로그인 꺼짐) · 랜딩 2단계 ==');
    const g = await newPage(browser, '게스트');
    await g.goto(URL + '/');
    await g.waitForSelector('#landing-step-profile:not([hidden])');
    await sleep(400);
    check(await g.locator('#landing-step-room').isHidden(), '첫 방문: 1단계(프로필)부터 시작');
    check(await g.locator('#nick').isVisible() && await g.locator('#emoji-strip .emoji-btn').first().isVisible() && await g.locator('#color-row .color-btn').first().isVisible(), '1단계: 게스트 폼(닉네임·얼굴·색상)');
    check(await g.locator('#auth-area').isHidden(), '게스트: 로그인 영역 숨김');
    check(await g.locator('#btn-login-google').isHidden() && await g.locator('#btn-login-kakao').isHidden(), '게스트: Google/카카오 버튼 없음');
    check(await g.locator('#auth-logged-out .divider').isHidden(), '로그인 꺼짐: "또는 게스트로 시작" 구분선 없음');
    check(await g.locator('#account-chip').isHidden(), '게스트: 계정 칩 없음');
    check(await g.locator('#btn-account-top').isHidden(), '게스트: 상단 "내 정보" 버튼 없음');
    check(await g.evaluate(() => !document.querySelector('script[src*="supabase"]')), '게스트: supabase 라이브러리를 로드하지 않음');
    check(await g.evaluate(() => window.Account && window.Account.isEnabled() === false), '게스트: Account.isEnabled() === false');
    check(await g.locator('#btn-profile-next').isDisabled(), '1단계: 닉네임이 비어 있으면 "다음" 비활성');
    await g.fill('#nick', '   ');
    check(await g.locator('#btn-profile-next').isDisabled(), '1단계: 공백만 입력해도 "다음" 비활성');
    await g.fill('#nick', '게스트');
    check(!(await g.locator('#btn-profile-next').isDisabled()), '1단계: 닉네임 입력 → "다음" 활성');
    check((await g.getAttribute('#nick', 'maxlength')) === '12', '1단계: 닉네임 최대 12자');
    await g.locator('#emoji-strip .emoji-btn').nth(5).click();
    const pickedEmoji = (await g.locator('#emoji-strip .emoji-btn').nth(5).textContent()).trim();
    await g.click('#btn-profile-next');
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    check(await g.locator('#landing-step-profile').isHidden(), '다음 → 2단계(방)');
    check((await txt(g, '#me-name')) === '게스트' && (await txt(g, '#me-status')) === '게스트', '2단계: 요약 카드(닉네임 · "게스트")', `${await txt(g, '#me-name')} / ${await txt(g, '#me-status')}`);
    check((await txt(g, '#me-avatar')) === pickedEmoji, '2단계: 요약 카드 아바타 = 고른 얼굴', await txt(g, '#me-avatar'));
    check(await g.locator('#btn-profile-edit').isVisible(), '2단계: "프로필 수정" 버튼');
    check(await g.locator('#btn-me-login').isHidden() && await g.locator('#me-account').isHidden(), '2단계(로그인 꺼짐): 로그인 링크 · 내 정보 · 로그아웃 없음');
    check(await g.locator('#btn-create').isVisible() && await g.locator('#room-code-input').isVisible() && await g.locator('#btn-join').isVisible(), '2단계: 방 만들기 + 방 코드 참가');
    check(await g.locator('#invite-card').isHidden(), '2단계: 초대 링크가 아니면 초대 카드 없음');
    // 프로필 수정 → 1단계(값 유지)
    await g.click('#btn-profile-edit');
    await g.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check(await g.locator('#landing-step-room').isHidden(), '프로필 수정 → 1단계');
    check((await val(g, '#nick')) === '게스트' && (await g.locator('#emoji-strip .emoji-btn').nth(5).getAttribute('aria-checked')) === 'true', '프로필 수정: 닉네임 · 얼굴 값 유지');
    // Enter = 다음
    await g.press('#nick', 'Enter');
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    check(await g.locator('#landing-step-room').isVisible(), '1단계: 닉네임에서 Enter = 다음');
    // 기기 뒤로가기(2단계 → 1단계, 페이지는 그대로)
    await g.evaluate(() => { window.__samePage = 1; });
    await g.goBack();
    await g.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 }).catch(() => {});
    check(await g.locator('#landing-step-profile').isVisible() && await g.evaluate(() => window.__samePage === 1) && g.url().startsWith(URL), '뒤로가기: 2단계 → 1단계(페이지를 떠나지 않음)', g.url());
    await g.click('#btn-profile-next');
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    // 저장된 프로필 → 새로고침하면 2단계부터
    await g.reload();
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 }).catch(() => {});
    check(await g.locator('#landing-step-room').isVisible() && await g.locator('#landing-step-profile').isHidden(), '새로고침(저장된 프로필): 2단계부터', await g.locator('#landing-step-room').isVisible());
    check((await txt(g, '#me-name')) === '게스트', '새로고침: 요약 카드에 저장된 닉네임');
    await g.evaluate(() => { window.__samePage = 2; });
    await g.goBack();
    await g.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 }).catch(() => {});
    check(await g.locator('#landing-step-profile').isVisible() && await g.evaluate(() => window.__samePage === 2), '새로고침 후에도 뒤로가기: 2단계 → 1단계');
    // 초대 링크(?room=ABCD, 저장된 프로필) → 2단계 초대 카드
    await g.goto(URL + '/?room=ABCD');
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    check(await g.locator('#invite-card').isVisible() && (await txt(g, '#invite-code')) === 'ABCD', '초대 링크: "초대받은 방 ABCD" 카드', await txt(g, '#invite-code'));
    check((await txt(g, '#btn-join')) === '이 방에 참가하기' && (await g.getAttribute('#btn-join', 'class')).includes('btn-primary'), '초대 카드: 주 버튼 "이 방에 참가하기"');
    check((await val(g, '#room-code-input')) === 'ABCD' && await g.locator('#room-code-input').isHidden(), '초대 카드: 코드 프리필(입력칸은 숨김)');
    check((await txt(g, '#btn-create')) === '새 방 만들기' && !(await g.getAttribute('#btn-create', 'class')).includes('btn-primary'), '초대 카드: "새 방 만들기"는 보조 버튼');
    await g.click('#btn-invite-dismiss');
    check(await g.locator('#invite-card').isHidden() && await g.locator('#room-code-input').isVisible() && (await val(g, '#room-code-input')) === 'ABCD', '다른 방 코드 입력: 일반 화면(코드 유지)');
    check((await txt(g, '#btn-create')) === '방 만들기' && !g.url().includes('room='), '다른 방 코드 입력: 방 만들기 주 버튼 · 주소에서 ?room= 제거', g.url());
    // 처음 온 사람 + 초대 링크 → 1단계 → 다음 → 초대 카드
    const g2 = await newPage(browser, '게스트2');
    await g2.goto(URL + '/?room=WXYZ');
    await g2.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 });
    check(await g2.locator('#landing-step-room').isHidden(), '초대 링크(새 방문자): 1단계부터');
    await g2.fill('#nick', '초대손님');
    await g2.click('#btn-profile-next');
    await g2.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    check(await g2.locator('#invite-card').isVisible() && (await txt(g2, '#invite-code')) === 'WXYZ', '초대 링크(새 방문자): 다음 → 초대 카드(코드 유지)');
    await g2.context().close();
    await g.click('#btn-create');
    await g.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await g.click('#mode-panel .mode-card[data-mode="classic"]');
    await g.waitForSelector('#settings-panel:not([hidden])', { timeout: 3000 });
    check(await g.locator('#settings-panel').isVisible(), '게스트: 방 만들기 → 설정 패널 표시');
    check(await g.locator('#wordset-tools').isHidden(), '게스트: 설정의 내 세트 도구 숨김');
    check((await g.locator('.login-badge').count()) === 0, '게스트: 플레이어 목록에 ✔ 배지 없음');
    check(await g.locator('#overlay-account').isHidden() && await g.locator('#sheet-account').isHidden(), '게스트: 내 정보 모달/시트 숨김');
    await g.click('#btn-leave');
    await g.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    await sleep(200);
    check(await g.locator('#landing-step-room').isVisible() && !g.url().includes('room='), '방 나가기 → 2단계(방 선택), 주소에 ?room= 없음', g.url());
    await g.evaluate(() => { window.__samePage = 3; });
    await g.goBack();
    await g.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 }).catch(() => {});
    check(await g.locator('#landing-step-profile').isVisible() && await g.evaluate(() => window.__samePage === 3), '방 나간 뒤 뒤로가기: 1단계(페이지 유지)');

    // ---------- 2. 가짜 Supabase (데스크톱) ----------
    console.log('\n== 로그인 UI (가짜 Supabase, 데스크톱) ==');
    const p = await newPage(browser, '로그인');
    await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    await p.waitForFunction(() => (document.getElementById('me-status').textContent || '').trim() === 'Google 계정', null, { timeout: 3000 }).catch(() => {});
    check(await p.locator('#landing-step-profile').isHidden(), '로그인(모크, 새 방문자): 프로필이 오면 2단계로');
    check((await txt(p, '#me-status')) === 'Google 계정', '2단계(로그인): 제공자 라벨 "Google 계정"', await txt(p, '#me-status'));
    check((await txt(p, '#me-name')) === '모크유저', '2단계(로그인): 요약 카드에 프로필 닉네임', await txt(p, '#me-name'));
    check(await p.locator('#btn-account-open').isVisible() && await p.locator('#btn-logout').isVisible() && await p.locator('#btn-me-login').isHidden(), '2단계(로그인): 내 정보 · 로그아웃 표시, 로그인 링크 없음');
    check((await val(p, '#nick')) === '모크유저', '로그인: 닉네임 입력이 프로필로 프리필', await val(p, '#nick'));
    // 프로필 수정 → 1단계: 로그인 버튼 대신 계정 칩 + 폼
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check(await p.locator('#account-chip').isVisible(), '1단계(로그인): 계정 칩 표시');
    check((await txt(p, '#chip-name')) === '모크유저' && (await txt(p, '#chip-provider')).includes('Google'), '1단계(로그인): 칩에 닉네임 · 제공자', `${await txt(p, '#chip-name')} / ${await txt(p, '#chip-provider')}`);
    check(await p.locator('#auth-logged-out').isHidden(), '1단계(로그인): Google/카카오 버튼 숨김');
    check(await p.locator('#nick').isVisible() && (await val(p, '#nick')) === '모크유저', '1단계(로그인): 닉네임 폼 프리필(수정 가능)');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });

    // 내 정보 열기(칩)
    await p.click('#btn-account-open');
    await p.waitForSelector('#overlay-account:not([hidden])', { timeout: 3000 });
    check((await p.locator('#account-modal-body #account-body').count()) === 1, '데스크톱: 내 정보가 모달(.modal)에 렌더링');
    check((await txt(p, '#acct-provider')).includes('Google'), '내 정보: 제공자 라벨(Google)', await txt(p, '#acct-provider'));
    check((await val(p, '#acct-nick')) === '모크유저', '내 정보: 닉네임 입력 프리필');
    await p.waitForSelector('#wordset-empty:not([hidden])', { timeout: 3000 });
    check(await p.locator('#wordset-empty').isVisible(), '내 정보: 세트 없음 안내');
    check((await txt(p, '#wordset-count')) === '0 / 20', '내 정보: 세트 개수 0 / 20', await txt(p, '#wordset-count'));

    // 새 세트 (3단어, 빈 항목·공백은 무시)
    await p.click('#btn-wordset-new');
    await p.waitForSelector('#wordset-form:not([hidden])', { timeout: 2000 });
    await p.fill('#ws-name', '과일');
    await p.fill('#ws-words', '사과, 바나나 , 포도,, ');
    check((await txt(p, '#ws-count')).startsWith('3개'), '새 세트: 실시간 단어 수 3개', await txt(p, '#ws-count'));
    await p.fill('#ws-words', '사과, 바나나, 포도, ' + '가'.repeat(21));
    check((await txt(p, '#ws-count')).includes('제외 1개'), '새 세트: 21자 이상 단어는 제외로 표시', await txt(p, '#ws-count'));
    await p.fill('#ws-words', '사과, 바나나, 포도');
    await p.click('#btn-ws-submit');
    await p.waitForSelector('#wordset-list .wordset-item', { timeout: 3000 });
    check((await p.locator('#wordset-list .wordset-item').count()) === 1, '새 세트: 목록에 1개');
    check((await txt(p, '#wordset-list .ws-name')) === '과일' && (await txt(p, '#wordset-list .ws-meta')).startsWith('3개'), '새 세트: 이름·단어 수 표시', `${await txt(p, '#wordset-list .ws-name')} / ${await txt(p, '#wordset-list .ws-meta')}`);
    check((await txt(p, '#wordset-count')) === '1 / 20', '새 세트: 개수 1 / 20');
    check(await p.locator('#wordset-form').isHidden(), '새 세트: 저장 후 폼 닫힘');
    check(await p.locator('#wordset-list .ws-apply').isDisabled(), '방 밖: "이 세트로 방 설정" 비활성');
    check(await p.locator('#wordset-apply-hint').isVisible(), '방 밖: 적용 불가 안내 표시');
    check(await p.evaluate(() => window.__mockAuth.tables.word_sets.length === 1 && window.__mockAuth.tables.word_sets[0].owner_id === 'mock-user-1'), '새 세트: DB 행에 owner_id 포함');

    // 빈 폼 검증
    await p.click('#btn-wordset-new');
    await p.fill('#ws-name', '');
    await p.fill('#ws-words', '');
    await p.click('#btn-ws-submit');
    check((await txt(p, '#ws-error')).includes('이름'), '검증: 이름 없이 저장 → 오류 문구', await txt(p, '#ws-error'));
    await p.click('#btn-ws-cancel');
    check(await p.locator('#wordset-form').isHidden(), '검증: 취소로 폼 닫힘');

    // 닉네임 저장 → 칩과 랜딩 입력에 반영
    await p.fill('#acct-nick', '모크짱');
    await p.click('#btn-acct-nick-save');
    await p.waitForFunction(() => (document.getElementById('chip-name').textContent || '').trim() === '모크짱', null, { timeout: 3000 }).catch(() => {});
    check((await txt(p, '#chip-name')) === '모크짱', '닉네임 저장: 칩 갱신', await txt(p, '#chip-name'));
    check((await val(p, '#nick')) === '모크짱', '닉네임 저장: 랜딩 닉네임 입력 갱신', await val(p, '#nick'));
    check((await txt(p, '#me-name')) === '모크짱', '닉네임 저장: 2단계 요약 카드 갱신', await txt(p, '#me-name'));
    check(await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname === '모크짱'), '닉네임 저장: DB 반영');
    await p.click('#btn-account-close');
    check(await p.locator('#overlay-account').isHidden(), '내 정보: 닫기');

    // 1단계에서 닉네임을 바꾸고 "다음" → 프로필에 저장, 그 뒤 방 만들기(모크 대기실, 호스트)
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    await p.fill('#nick', '방장모크');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await p.waitForFunction(() => window.__mockAuth.tables.profiles[0].nickname === '방장모크', null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname === '방장모크'), '다음: 바꾼 닉네임이 프로필에 저장', await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname));
    check((await txt(p, '#me-name')) === '방장모크', '다음: 요약 카드에 바꾼 닉네임');
    await p.click('#btn-create');
    await p.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#settings-panel:not([hidden])', { timeout: 5000 });
    check(await p.locator('.topbar #btn-account-top').isVisible(), '방 안(데스크톱): 상단바 "내 정보" 버튼');
    check(await p.locator('#wordset-tools').isVisible() && await p.locator('#btn-wordset-save').isVisible(), '설정: "현재 단어를 세트로 저장" 표시');
    check(await p.locator('#wordset-load').isVisible() && (await p.locator('#wordset-load option').count()) === 2, '설정: "내 세트 불러오기" 셀렉트(세트 1개)', await p.locator('#wordset-load option').count());
    await p.waitForFunction(() => window.__dg.state.players.some((pl) => pl.loggedIn), null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => window.__dg.state.players.some((pl) => pl.id === window.__dg.myId() && pl.loggedIn)), '데이터: players[].loggedIn 은 그대로 받음');
    check((await p.locator('.login-badge').count()) === 0, '플레이어 목록: 로그인해도 ✔ 배지를 그리지 않음');

    // "이 세트로 방 설정"
    await p.click('#btn-account-top');
    await p.waitForSelector('#overlay-account:not([hidden])', { timeout: 3000 });
    check(!(await p.locator('#wordset-list .ws-apply').isDisabled()), '호스트·대기실: "이 세트로 방 설정" 활성');
    await p.click('#wordset-list .ws-apply');
    await p.waitForSelector('#overlay-account', { state: 'hidden', timeout: 3000 });
    await p.waitForFunction(() => window.__dg.state.settings.customWordsOnly === true, null, { timeout: 3000 }).catch(() => {});
    const cw = await val(p, '#set-customWords');
    check(cw.includes('사과') && cw.includes('바나나') && cw.includes('포도'), '세트 적용: #set-customWords 에 단어', cw);
    check(await p.isChecked('#set-customWordsOnly'), '세트 적용: #set-customWordsOnly 체크');
    check(await p.evaluate(() => window.__dg.state.settings.customWordsOnly && /사과/.test(window.__dg.state.settings.customWords)), '세트 적용: room:settings 전송 → state 반영');

    // 셀렉트로 불러오기 (텍스트 영역만 채움)
    await p.fill('#set-customWords', '임시');
    await p.locator('#set-customWords').blur();
    await p.selectOption('#wordset-load', { index: 1 });
    await sleep(300);
    check((await val(p, '#set-customWords')) === '사과, 바나나, 포도', '셀렉트 불러오기: 텍스트 영역 채움', await val(p, '#set-customWords'));
    check((await val(p, '#wordset-load')) === '', '셀렉트 불러오기: 셀렉트는 기본값으로 복귀');

    // 현재 단어를 세트로 저장 → 폼 프리필
    await p.fill('#set-customWords', '고양이, 강아지');
    await p.locator('#set-customWords').blur();
    await p.click('#btn-wordset-save');
    await p.waitForSelector('#overlay-account:not([hidden])', { timeout: 3000 });
    await p.waitForSelector('#wordset-form:not([hidden])', { timeout: 2000 });
    check((await val(p, '#ws-words')) === '고양이, 강아지', '현재 단어 저장: 폼에 단어 프리필', await val(p, '#ws-words'));
    await p.fill('#ws-name', '동물');
    await p.click('#btn-ws-submit');
    await p.waitForFunction(() => document.querySelectorAll('#wordset-list .wordset-item').length === 2, null, { timeout: 3000 });
    check((await p.locator('#wordset-list .wordset-item').count()) === 2, '현재 단어 저장: 세트 2개');
    check((await p.locator('#wordset-load option').count()) === 3, '설정 셀렉트도 갱신(세트 2개)');

    // 수정
    const fruit = p.locator('#wordset-list .wordset-item', { hasText: '과일' });
    await fruit.locator('.ws-edit').click();
    await p.waitForSelector('#wordset-form:not([hidden])', { timeout: 2000 });
    check((await txt(p, '#ws-form-title')) === '세트 수정' && (await val(p, '#ws-name')) === '과일' && (await val(p, '#ws-words')) === '사과, 바나나, 포도', '수정: 폼에 기존 값 프리필');
    await p.fill('#ws-name', '과일2');
    await p.fill('#ws-words', '사과, 바나나, 포도, 키위');
    await p.click('#btn-ws-submit');
    await p.waitForFunction(() => [...document.querySelectorAll('#wordset-list .ws-name')].some((n) => n.textContent === '과일2'), null, { timeout: 3000 });
    const edited = p.locator('#wordset-list .wordset-item', { hasText: '과일2' });
    check((await edited.count()) === 1 && (await edited.locator('.ws-meta').textContent()).startsWith('4개'), '수정: 이름·단어 수 갱신');
    check((await p.locator('#wordset-list .wordset-item').count()) === 2, '수정: 세트 수 그대로 2개');

    // 20개 제한: DB 에 19개를 직접 넣고 새로 만들면 트리거 메시지가 그대로 폼 오류로 뜬다
    await p.evaluate(() => { for (let i = 0; i < 18; i++) window.__mockAuth.tables.word_sets.push({ id: 'seed-' + i, owner_id: 'mock-user-1', name: '채움' + i, words: ['a'], is_public: false, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }); });
    await p.click('#btn-wordset-new');
    await p.fill('#ws-name', '스물한번째');
    await p.fill('#ws-words', '하나');
    await p.click('#btn-ws-submit');
    await p.waitForFunction(() => (document.getElementById('ws-error').textContent || '').length > 0, null, { timeout: 3000 }).catch(() => {});
    check((await txt(p, '#ws-error')) === '단어 세트는 20개까지 만들 수 있어요', '20개 제한: DB 오류 메시지가 그대로 노출', await txt(p, '#ws-error'));
    check((await p.locator('#toasts .toast').filter({ hasText: '20개까지' }).count()) >= 1, '20개 제한: 토스트에도 안내');
    await p.click('#btn-ws-cancel');
    // 실패 후 목록을 다시 불러오므로 20개가 보이고 "새 세트"는 비활성
    await p.waitForFunction(() => document.querySelectorAll('#wordset-list .wordset-item').length === 20, null, { timeout: 3000 }).catch(() => {});
    check((await p.locator('#wordset-list .wordset-item').count()) === 20 && await p.locator('#btn-wordset-new').isDisabled(), '20개 제한: 목록 20개면 "새 세트" 비활성', await p.locator('#wordset-list .wordset-item').count());
    check((await txt(p, '#wordset-count')) === '20 / 20', '20개 제한: 개수 20 / 20', await txt(p, '#wordset-count'));
    await p.evaluate(() => { const t = window.__mockAuth.tables; t.word_sets = t.word_sets.filter((r) => !String(r.id).startsWith('seed-')); });

    // 삭제 (confirm 수락) → 목록 새로 고침(채움 행은 이미 DB 에서 빠졌으므로 1개 남는다)
    p.once('dialog', (d) => d.accept());
    await edited.locator('.ws-delete').click();
    await p.waitForFunction(() => document.querySelectorAll('#wordset-list .wordset-item').length === 1, null, { timeout: 3000 });
    check((await p.locator('#wordset-list .wordset-item', { hasText: '과일2' }).count()) === 0, '삭제: 목록에서 제거');
    check(await p.evaluate(() => !window.__mockAuth.tables.word_sets.some((r) => r.name === '과일2')), '삭제: DB 에서 제거');
    check(!(await p.locator('#btn-wordset-new').isDisabled()), '삭제 후: "새 세트" 다시 활성');

    // ESC 로 모달 닫기
    await p.keyboard.press('Escape');
    check(await p.locator('#overlay-account').isHidden(), 'ESC: 내 정보 모달 닫힘');

    // 로그아웃(방 안에서, 새로고침 없이) → 게스트 UI
    await p.click('#btn-account-top');
    await p.waitForSelector('#overlay-account:not([hidden])', { timeout: 3000 });
    await p.click('#btn-acct-logout');
    await p.waitForSelector('#account-chip', { state: 'hidden', timeout: 3000 });
    check(await p.locator('#overlay-account').isHidden(), '로그아웃: 내 정보 닫힘');
    check(await p.locator('#btn-account-top').isHidden() && await p.locator('#wordset-tools').isHidden(), '로그아웃: 방 안 계정 UI 숨김');
    check(await p.locator('#view-room').isVisible(), '로그아웃: 방은 그대로(새로고침 없음)');
    await p.waitForFunction(() => !window.__dg.state.players.some((pl) => pl.loggedIn), null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => !window.__dg.state.players.some((pl) => pl.loggedIn)), '로그아웃: auth:token null → loggedIn 해제');
    await p.click('#btn-leave');
    await p.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    check(await p.locator('#landing-step-room').isVisible() && (await txt(p, '#me-status')) === '게스트', '로그아웃 후 방 나가기: 2단계(게스트)', await txt(p, '#me-status'));
    check(await p.locator('#btn-me-login').isVisible() && await p.locator('#me-account').isHidden(), '2단계(게스트, 로그인 가능): "로그인" 링크 · 내 정보 없음');
    await p.click('#btn-me-login');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check(await p.locator('#account-chip').isHidden(), '로그아웃: 랜딩 칩 없음');
    check((await txt(p, '.auth-title')) === '로그인하고 시작', '1단계(로그아웃): "로그인하고 시작" 블록');
    check(await p.locator('#btn-login-google').isVisible() && await p.locator('#btn-login-kakao').isVisible(), '로그아웃: Google/카카오 버튼 표시');
    check(await p.locator('#auth-logged-out .divider').isVisible() && (await txt(p, '#auth-logged-out .divider')) === '또는 게스트로 시작', '1단계(로그아웃): "또는 게스트로 시작" 구분선 아래 게스트 폼');
    const order = await p.evaluate(() => { const a = document.getElementById('btn-login-google').getBoundingClientRect().top, n = document.getElementById('nick').getBoundingClientRect().top; return a < n; });
    check(order, '1단계(로그아웃): 로그인 버튼이 게스트 폼보다 위');
    check((await txt(p, '.auth-note')).includes('단어 세트') && (await p.locator('.auth-note a[href="/privacy"]').count()) === 1, '로그아웃: 안내 문구 + 개인정보 처리방침 링크');
    const kakaoBg = await p.locator('#btn-login-kakao').evaluate((e) => getComputedStyle(e).backgroundColor);
    const kakaoFg = await p.locator('#btn-login-kakao').evaluate((e) => getComputedStyle(e).color);
    check(kakaoBg === 'rgb(254, 229, 0)' && kakaoFg === 'rgb(0, 0, 0)', '카카오 버튼: #FEE500 배경 + 검정 글자', `${kakaoBg} / ${kakaoFg}`);
    check((await p.locator('#btn-login-google').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(255, 255, 255)', 'Google 버튼: 흰 배경');

    // 초대 링크로 와서(로그아웃 상태) 1단계에서 로그인(모크는 즉시) → 2단계 + 초대 카드 유지
    await p.goto(`${URL}/?mock=1&auth=1&stay=1&auth_state=out&room=ABCD`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    check(await p.locator('#invite-card').isVisible() && (await txt(p, '#invite-code')) === 'ABCD', '초대 링크(저장된 프로필, 로그아웃): 2단계 초대 카드');
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#btn-login-kakao:visible', { timeout: 5000 });
    await p.click('#btn-login-kakao');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    await p.waitForFunction(() => (document.getElementById('me-status').textContent || '').trim() === '카카오 계정', null, { timeout: 3000 }).catch(() => {});
    check((await txt(p, '#me-status')) === '카카오 계정' && await p.locator('#me-account').isVisible(), '재로그인(카카오): 2단계로 · "카카오 계정"', await txt(p, '#me-status'));
    check(await p.locator('#invite-card').isVisible() && (await txt(p, '#invite-code')) === 'ABCD', '재로그인: 초대 카드 유지');
    await p.click('#btn-account-open');
    await p.waitForSelector('#overlay-account:not([hidden])', { timeout: 3000 });
    check((await txt(p, '#acct-provider')).includes('카카오'), '재로그인: 제공자 라벨(카카오)', await txt(p, '#acct-provider'));
    await p.click('#btn-account-close');
    // 로그인 버튼을 누르기 전의 초대 코드는 OAuth 리다이렉트 뒤 복원하도록 임시 저장된다(모크는 실제로 이동하지 않으므로 남아 있음) → 다시 열면 초대 카드로 복원되고 소비된다
    check(await p.evaluate(() => sessionStorage.getItem('drawguess.pendingRoom') === 'ABCD'), '로그인 시도 전 방 코드 임시 저장(리다이렉트 복원용)');
    await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#me-account:not([hidden])', { timeout: 5000 });
    check(await p.locator('#invite-card').isVisible() && (await txt(p, '#invite-code')) === 'ABCD' && (await val(p, '#room-code-input')) === 'ABCD', '리다이렉트 복귀(로그인): 2단계 초대 카드로 방 코드 복원', await val(p, '#room-code-input'));
    check(await p.evaluate(() => sessionStorage.getItem('drawguess.pendingRoom') === null), '리다이렉트 복귀: 임시 저장 소비됨');
    // 2단계에서 로그아웃 → 1단계
    await p.evaluate(() => { window.__samePage = 9; });
    await p.click('#btn-logout');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 }).catch(() => {});
    await sleep(300);
    check(await p.locator('#landing-step-profile').isVisible() && await p.locator('#btn-login-google').isVisible() && await p.evaluate(() => window.__samePage === 9), '로그아웃(2단계) → 1단계(로그인 버튼), 페이지 유지');
    check(await p.evaluate(() => !(history.state && history.state.landing === 'room')), '로그아웃: 2단계 history 항목 정리');

    // ---------- 3. 모바일 ----------
    console.log('\n== 로그인 UI (가짜 Supabase, 모바일) ==');
    const m = await newPage(browser, '모바일', { ...devices['iPhone 13'] });
    await m.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await m.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    await m.waitForSelector('#me-account:not([hidden])', { timeout: 5000 });
    let sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 랜딩(로그인, 2단계): 가로 스크롤 없음', sw);
    check((await txt(m, '#me-status')) === 'Google 계정', '모바일: 로그인 상태는 2단계 + 제공자 라벨');
    await m.click('#btn-account-open');
    await m.waitForSelector('#sheet-account.open', { timeout: 3000 });
    check((await m.locator('#sheet-account-body #account-body').count()) === 1, '모바일: 내 정보가 바텀 시트에 렌더링');
    check(await m.locator('#overlay-account').isHidden(), '모바일: 데스크톱 모달은 열리지 않음');
    const bb = await m.locator('#btn-wordset-new').boundingBox();
    check(!!bb && bb.x >= 0 && bb.x + bb.width <= 390, '모바일: 시트 안 "새 세트" 버튼이 화면 안', bb && Math.round(bb.x + bb.width));
    await m.click('#sheet-account .sheet-close');
    await m.waitForSelector('#sheet-account', { state: 'hidden', timeout: 3000 });
    check(await m.evaluate(() => window.__dg.acct.open === false), '모바일: ✕로 닫으면 열림 상태 해제');
    check(await m.locator('#landing-step-room').isVisible(), '모바일: 시트를 닫아도 2단계 유지');
    await m.click('#btn-create');
    await m.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await m.waitForSelector('#settings-panel:not([hidden])', { timeout: 5000 });
    check((await m.locator('.topbar #btn-account-top').count()) === 0 && (await m.locator('#sheet-menu #btn-account-top').count()) === 1, '모바일 방: "내 정보" 버튼은 헤더가 아니라 메뉴 시트에');
    await m.click('#btn-menu');
    await m.waitForSelector('#sheet-menu.open', { timeout: 3000 });
    check(await m.locator('#sheet-menu #btn-account-top').isVisible(), '모바일 메뉴 시트: "내 정보" 행 표시');
    await m.click('#sheet-menu #btn-account-top');
    await m.waitForSelector('#sheet-account.open', { timeout: 3000 });
    check(await m.locator('#sheet-menu').isHidden(), '모바일: 메뉴 → 내 정보 시트로 전환(메뉴 닫힘)');
    await m.waitForSelector('#wordset-empty:not([hidden])', { timeout: 3000 });
    check(await m.locator('#wordset-empty').isVisible(), '모바일: 시트 안 세트 목록(빈 상태) 표시');
    sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 대기실(로그인): 가로 스크롤 없음', sw);
    await m.keyboard.press('Escape');
    await m.waitForSelector('#sheet-account', { state: 'hidden', timeout: 3000 });
    check(await m.locator('#wordset-tools').isVisible(), '모바일 설정: 세트 도구 표시');
    check((await m.locator('.login-badge').count()) === 0, '모바일: ✔ 로그인 배지 없음');
  } catch (e) {
    console.log('FAIL  예외:', e.stack || e.message);
    failures++;
  } finally {
    clearTimeout(timeout);
    await browser.close();
    server.kill();
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  }
})();
