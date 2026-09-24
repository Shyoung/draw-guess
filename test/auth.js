/**
 * 로그인 / 내 정보 / 단어 세트 UI 검증 (실제 Supabase 없이).
 *   node test/auth.js            → PASS/FAIL 줄 출력, 실패가 있으면 exit 1
 *
 * 1) 서버를 SUPABASE_* 환경 변수 없이 3130 포트로 띄운다 → /config.js 는 {} → 로그인 UI 가 전혀 보이지 않고 게임은 그대로 동작해야 한다.
 * 2) ?mock=1&auth=1&stay=1 : dev-mock.js 가 가짜 window.supabase + APP_CONFIG 를 설치한다(메모리 DB, 로그인된 상태로 시작).
 *    - 계정 칩 · 내 정보(프로필/닉네임 저장) · 단어 세트 생성(3단어)/목록/"이 세트로 방 설정"/수정/삭제 · 20개 제한 메시지 노출
 *    - 대기실 설정의 "내 세트 불러오기" 셀렉트 · "현재 단어를 세트로 저장" · 플레이어 목록 ✔ 배지
 *    - 로그아웃 → 칩 사라지고 로그인 버튼 표시 → 다시 로그인
 * 3) 모바일(iPhone 13): 내 정보가 바텀 시트(#sheet-account)로 열리고, 방 메뉴 시트에 "내 정보" 행이 있다.
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

    // ---------- 1. 게스트(로그인 꺼짐) ----------
    console.log('\n== 게스트(로그인 꺼짐) ==');
    const g = await newPage(browser, '게스트');
    await g.goto(URL + '/');
    await g.waitForSelector('#btn-create');
    await sleep(400);
    check(await g.locator('#auth-area').isHidden(), '게스트: 로그인 영역 숨김');
    check(await g.locator('#btn-login-google').isHidden() && await g.locator('#btn-login-kakao').isHidden(), '게스트: Google/카카오 버튼 없음');
    check(await g.locator('#account-chip').isHidden(), '게스트: 계정 칩 없음');
    check(await g.locator('#btn-account-top').isHidden(), '게스트: 상단 "내 정보" 버튼 없음');
    check(await g.evaluate(() => !document.querySelector('script[src*="supabase"]')), '게스트: supabase 라이브러리를 로드하지 않음');
    check(await g.evaluate(() => window.Account && window.Account.isEnabled() === false), '게스트: Account.isEnabled() === false');
    await g.fill('#nick', '게스트');
    await g.click('#btn-create');
    await g.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await g.click('#mode-panel .mode-card[data-mode="classic"]');
    await g.waitForSelector('#settings-panel:not([hidden])', { timeout: 3000 });
    check(await g.locator('#settings-panel').isVisible(), '게스트: 방 만들기 → 설정 패널 표시');
    check(await g.locator('#wordset-tools').isHidden(), '게스트: 설정의 내 세트 도구 숨김');
    check((await g.locator('#player-list .login-badge').count()) === 0, '게스트: 플레이어 목록에 ✔ 배지 없음');
    check(await g.locator('#overlay-account').isHidden() && await g.locator('#sheet-account').isHidden(), '게스트: 내 정보 모달/시트 숨김');
    await g.click('#btn-leave');
    await g.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });

    // ---------- 2. 가짜 Supabase (데스크톱) ----------
    console.log('\n== 로그인 UI (가짜 Supabase, 데스크톱) ==');
    const p = await newPage(browser, '로그인');
    await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#account-chip:not([hidden])', { timeout: 5000 });
    await p.waitForFunction(() => (document.getElementById('chip-name').textContent || '').trim() === '모크유저', null, { timeout: 3000 }).catch(() => {});
    check(await p.locator('#account-chip').isVisible(), '로그인: 계정 칩 표시');
    check((await txt(p, '#chip-name')) === '모크유저', '로그인: 칩에 닉네임', await txt(p, '#chip-name'));
    check(await p.locator('#auth-logged-out').isHidden(), '로그인: Google/카카오 버튼 숨김');
    check((await val(p, '#nick')) === '모크유저', '로그인: 닉네임 입력이 프로필로 프리필', await val(p, '#nick'));

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
    check(await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname === '모크짱'), '닉네임 저장: DB 반영');
    await p.click('#btn-account-close');
    check(await p.locator('#overlay-account').isHidden(), '내 정보: 닫기');

    // 방 만들기(모크 대기실, 호스트) — 닉네임을 바꿔서 들어가면 프로필에 저장돼야 한다
    await p.fill('#nick', '방장모크');
    await p.click('#btn-create');
    await p.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#settings-panel:not([hidden])', { timeout: 5000 });
    await p.waitForFunction(() => window.__mockAuth.tables.profiles[0].nickname === '방장모크', null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname === '방장모크'), '방 만들기: 바꾼 닉네임이 프로필에 저장', await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname));
    check(await p.locator('.topbar #btn-account-top').isVisible(), '방 안(데스크톱): 상단바 "내 정보" 버튼');
    check(await p.locator('#wordset-tools').isVisible() && await p.locator('#btn-wordset-save').isVisible(), '설정: "현재 단어를 세트로 저장" 표시');
    check(await p.locator('#wordset-load').isVisible() && (await p.locator('#wordset-load option').count()) === 2, '설정: "내 세트 불러오기" 셀렉트(세트 1개)', await p.locator('#wordset-load option').count());
    check((await p.locator('#player-list li.me .login-badge').count()) === 1, '플레이어 목록: 내 이름 옆 ✔ 배지');
    check((await p.locator('#player-list li.me .login-badge').getAttribute('title')) === '로그인 사용자', '✔ 배지 title');

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
    await p.waitForFunction(() => document.querySelectorAll('#player-list li.me .login-badge').length === 0, null, { timeout: 3000 }).catch(() => {});
    check((await p.locator('#player-list li.me .login-badge').count()) === 0, '로그아웃: auth:token null → ✔ 배지 제거');
    await p.click('#btn-leave');
    await p.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    check(await p.locator('#account-chip').isHidden(), '로그아웃: 랜딩 칩 없음');
    check(await p.locator('#btn-login-google').isVisible() && await p.locator('#btn-login-kakao').isVisible(), '로그아웃: Google/카카오 버튼 표시');
    check((await txt(p, '.auth-note')).includes('단어 세트') && (await p.locator('.auth-note a[href="/privacy"]').count()) === 1, '로그아웃: 안내 문구 + 개인정보 처리방침 링크');
    const kakaoBg = await p.locator('#btn-login-kakao').evaluate((e) => getComputedStyle(e).backgroundColor);
    const kakaoFg = await p.locator('#btn-login-kakao').evaluate((e) => getComputedStyle(e).color);
    check(kakaoBg === 'rgb(254, 229, 0)' && kakaoFg === 'rgb(0, 0, 0)', '카카오 버튼: #FEE500 배경 + 검정 글자', `${kakaoBg} / ${kakaoFg}`);
    check((await p.locator('#btn-login-google').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(255, 255, 255)', 'Google 버튼: 흰 배경');

    // 다시 로그인(모크는 즉시) → 칩
    await p.fill('#room-code-input', 'ABCD');
    await p.click('#btn-login-kakao');
    await p.waitForSelector('#account-chip:not([hidden])', { timeout: 3000 });
    check(await p.locator('#account-chip').isVisible() && await p.locator('#auth-logged-out').isHidden(), '재로그인: 칩 표시 · 버튼 숨김');
    await p.click('#btn-account-open');
    await p.waitForSelector('#overlay-account:not([hidden])', { timeout: 3000 });
    check((await txt(p, '#acct-provider')).includes('카카오'), '재로그인: 제공자 라벨(카카오)', await txt(p, '#acct-provider'));
    await p.click('#btn-account-close');
    // 로그인 버튼을 누르기 전 입력한 방 코드는 OAuth 리다이렉트 뒤 복원하도록 임시 저장된다(모크는 실제로 이동하지 않으므로 남아 있음) → 다시 열면 채워지고 소비된다
    check(await p.evaluate(() => sessionStorage.getItem('drawguess.pendingRoom') === 'ABCD'), '로그인 시도 전 방 코드 임시 저장(리다이렉트 복원용)');
    await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#account-chip:not([hidden])', { timeout: 5000 });
    check((await val(p, '#room-code-input')) === 'ABCD', '리다이렉트 복귀: 방 코드 입력 복원', await val(p, '#room-code-input'));
    check(await p.evaluate(() => sessionStorage.getItem('drawguess.pendingRoom') === null), '리다이렉트 복귀: 임시 저장 소비됨');

    // ---------- 3. 모바일 ----------
    console.log('\n== 로그인 UI (가짜 Supabase, 모바일) ==');
    const m = await newPage(browser, '모바일', { ...devices['iPhone 13'] });
    await m.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await m.waitForSelector('#account-chip:not([hidden])', { timeout: 5000 });
    let sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 랜딩(로그인): 가로 스크롤 없음', sw);
    await m.click('#btn-account-open');
    await m.waitForSelector('#sheet-account.open', { timeout: 3000 });
    check((await m.locator('#sheet-account-body #account-body').count()) === 1, '모바일: 내 정보가 바텀 시트에 렌더링');
    check(await m.locator('#overlay-account').isHidden(), '모바일: 데스크톱 모달은 열리지 않음');
    const bb = await m.locator('#btn-wordset-new').boundingBox();
    check(!!bb && bb.x >= 0 && bb.x + bb.width <= 390, '모바일: 시트 안 "새 세트" 버튼이 화면 안', bb && Math.round(bb.x + bb.width));
    await m.click('#sheet-account .sheet-close');
    await m.waitForSelector('#sheet-account', { state: 'hidden', timeout: 3000 });
    check(await m.evaluate(() => window.__dg.acct.open === false), '모바일: ✕로 닫으면 열림 상태 해제');
    await m.fill('#nick', '모바일모크');
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
