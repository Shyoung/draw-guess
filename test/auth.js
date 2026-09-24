/**
 * 로그인 / 프로필 사진 / 내 정보 / 단어 세트 UI 검증 (실제 Supabase 없이).
 *   node test/auth.js            → PASS/FAIL 줄 출력, 실패가 있으면 exit 1
 *
 * 랜딩 3단계: #landing-step-start(시작: Google/카카오/게스트) → #landing-step-profile(프로필 설정) → #landing-step-room(방)
 * 1) 서버를 SUPABASE_* 환경 변수 없이 3130 포트로 띄운다 → /config.js 는 {} → 시작 단계를 건너뛰고 프로필 설정부터, 로그인 UI 없음.
 *    - "저장"은 닉네임 1~12자일 때만 · 방 단계 요약 카드 · 프로필 수정 → 프로필(값 유지) · 기기 뒤로가기 → 프로필
 *    - 저장된 닉네임이면 새로고침 시 방 단계 · ?room= 초대 카드 · 개인정보 처리방침 링크는 카드 밖 맨 아래
 * 2) ?mock=1&auth=1&stay=1 : dev-mock.js 가 가짜 window.supabase(+storage) + APP_CONFIG 를 설치한다(메모리 DB).
 *    - 시작 단계: 버튼 3개(Google/카카오/게스트)와 "또는"만. 태그라인·"로그인하고 시작"·안내 문구 없음. 처리방침 링크는 카드 밖 맨 아래 가운데
 *    - 게스트로 시작하기 → 프로필(이모지·색상만, 사진 탭 없음) → 방 · 뒤로가기 방 → 프로필 → 시작
 *    - 로그인(모크) → 처음이면 프로필 설정(사진 모드 기본 + 소셜 사진) · 이모지 ↔ 사진 · 사진 올리기(256px webp, <uid>/ 폴더) ·
 *      기본 사진으로 · 저장 → avatar_mode/avatar_url 저장 + 안 쓰는 업로드 삭제 · 새로고침(확정 후) → 방 바로
 *    - 방(모크) 플레이어 목록: 사진 모드면 <img>, 이모지 모드면 이모지
 *    - 내 정보(닉네임 저장) · 단어 세트 생성/목록/"이 세트로 방 설정"/수정/삭제 · 20개 제한 · 대기실 세트 도구 · 로그아웃 → 시작
 * 3) 모바일(iPhone 13): 첫 로그인 → 프로필 설정(사진) → 방, 내 정보(/me) 화면, 방 메뉴 시트의 "프로필"(시트)·"내 정보"(나가고 이동) 행.
 * 내 정보는 /me 화면(프로필 요약 · 단어 세트 | 그림 탭 · 로그아웃 · 회원 탈퇴). 방 안에서는 "프로필"(대기실에서만, player:update)과
 * "내 정보"(방에서 나가고 이동할지 묻는다)만 있다.
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

const pathOf = (pg) => new globalThis.URL(pg.url()).pathname;
async function newPage(browser, tag, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts || { viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`[${tag}] pageerror: ${e.message}`); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${tag}] console.error: ${m.text()}`); });
  return page;
}
const val = (page, sel) => page.inputValue(sel);
const txt = async (page, sel) => (await page.locator(sel).first().textContent().catch(() => '') || '').trim();
const imgSrc = (page, sel) => page.locator(sel).first().getAttribute('src').catch(() => null);
/** 지금 보이는 랜딩 단계 id(없으면 '') */
const visibleStep = (page) => page.evaluate(() => ['start', 'profile', 'room', 'me'].filter((s) => !document.getElementById('landing-step-' + s).hidden).join(','));
/** 개인정보 처리방침 링크: 카드 밖 · 가로 가운데 · 화면 맨 아래 */
async function privacyChecks(page, label) {
  const inCard = await page.locator('.landing-card a[href="/privacy"]').count();
  const link = page.locator('.landing-foot a.privacy-link[href="/privacy"]');
  check(inCard === 0 && (await link.count()) === 1 && await link.isVisible(), `${label}: 개인정보 처리방침 링크는 카드 밖에 1개`);
  const geo = await page.evaluate(() => {
    const a = document.querySelector('.landing-foot a.privacy-link').getBoundingClientRect();
    const c = document.querySelector('.landing-card').getBoundingClientRect();
    const f = document.querySelector('.landing-foot').getBoundingClientRect();
    return { cx: a.left + a.width / 2, vw: document.documentElement.clientWidth, bottom: a.bottom + window.scrollY, docH: document.documentElement.scrollHeight, belowCard: a.top >= c.bottom, dbg: [Math.round(f.left), Math.round(f.top), Math.round(f.width), Math.round(c.left), Math.round(c.top), Math.round(c.width), Math.round(c.height), window.scrollY].join(',') };
  });
  check(Math.abs(geo.cx - geo.vw / 2) <= 2, `${label}: 처리방침 링크 가로 가운데`, `${Math.round(geo.cx)} / ${geo.vw / 2} [${geo.dbg}]`);
  check(geo.belowCard && geo.docH - geo.bottom <= 48, `${label}: 처리방침 링크는 카드 아래, 페이지 맨 아래`, `bottom=${Math.round(geo.bottom)} docH=${geo.docH}`);
}
/** 256x256 이 아니거나 읽을 수 없으면 null */
const blobSize = (page, path) => page.evaluate(async (p) => {
  const f = window.__mockAuth.storage.avatars[p]; if (!f) return null;
  const bmp = await createImageBitmap(f.blob); return { w: bmp.width, h: bmp.height, type: f.type, size: f.size };
}, path);
/** 320x200 (가로로 긴) PNG — 가운데 정사각형으로 잘리는지 보려고 왼쪽/오른쪽을 다른 색으로 */
async function makePng(page, color) {
  const b64 = await page.evaluate((c) => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 200;
    const g = cv.getContext('2d'); g.fillStyle = '#222'; g.fillRect(0, 0, 320, 200); g.fillStyle = c; g.fillRect(60, 0, 200, 200);
    return cv.toDataURL('image/png').split(',')[1];
  }, color);
  return { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') };
}
const storagePaths = (page) => page.evaluate(() => Object.keys(window.__mockAuth.storage.avatars));

(async () => {
  const server = await startServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: !process.env.HEADFUL });
  const timeout = setTimeout(() => { console.log('FAIL  전체 타임아웃'); process.exit(2); }, 150000);
  try {
    // ---------- 0. 서버 설정 ----------
    const cfg = await (await fetch(URL + '/config.js')).text();
    check(/window\.APP_CONFIG\s*=\s*\{\s*\}/.test(cfg), 'Supabase 미설정: /config.js → APP_CONFIG = {}', cfg.trim());
    const health = await (await fetch(URL + '/healthz')).json();
    check(health.auth === false, 'Supabase 미설정: /healthz auth=false', JSON.stringify(health.auth));

    // ---------- 1. 게스트(로그인 꺼짐) + 랜딩 ----------
    console.log('\n== 게스트(로그인 꺼짐) · 랜딩 ==');
    const g = await newPage(browser, '게스트');
    await g.goto(URL + '/');
    await g.waitForSelector('#landing-step-profile:not([hidden])');
    await sleep(400);
    check((await visibleStep(g)) === 'profile', '로그인 꺼짐: 시작 단계를 건너뛰고 프로필 설정부터', await visibleStep(g));
    check(await g.locator('#nick').isVisible() && await g.locator('#emoji-strip .emoji-btn').first().isVisible() && await g.locator('#color-row .color-btn').first().isVisible(), '프로필: 게스트 폼(닉네임·얼굴·색상)');
    check(await g.locator('#avatar-mode').isHidden() && await g.locator('#photo-panel').isHidden(), '게스트: 사진 | 이모지 선택 없음');
    check(await g.locator('#btn-login-google').isHidden() && await g.locator('#btn-login-kakao').isHidden(), '게스트: Google/카카오 버튼 없음');
    check(await g.locator('#btn-account-top').isHidden(), '게스트: 상단 "내 정보" 버튼 없음');
    check(await g.evaluate(() => !document.querySelector('script[src*="supabase"]')), '게스트: supabase 라이브러리를 로드하지 않음');
    check(await g.evaluate(() => window.Account && window.Account.isEnabled() === false), '게스트: Account.isEnabled() === false');
    check((await g.locator('.tagline').count()) === 0, '랜딩: 태그라인 없음');
    await privacyChecks(g, '로그인 꺼짐(프로필)');
    check(await g.locator('#btn-profile-next').isDisabled(), '프로필: 닉네임이 비어 있으면 "저장" 비활성');
    await g.fill('#nick', '   ');
    check(await g.locator('#btn-profile-next').isDisabled(), '프로필: 공백만 입력해도 "저장" 비활성');
    await g.fill('#nick', '게스트');
    check(!(await g.locator('#btn-profile-next').isDisabled()), '프로필: 닉네임 입력 → "저장" 활성');
    check((await g.getAttribute('#nick', 'maxlength')) === '12', '프로필: 닉네임 최대 12자');
    await g.locator('#emoji-strip .emoji-btn').nth(5).click();
    const pickedEmoji = (await g.locator('#emoji-strip .emoji-btn').nth(5).textContent()).trim();
    await g.click('#btn-profile-next');
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    check(await g.locator('#landing-step-profile').isHidden(), '저장 → 방 단계');
    check((await txt(g, '#me-name')) === '게스트' && (await txt(g, '#me-status')) === '게스트', '방 단계: 요약 카드(닉네임 · "게스트")', `${await txt(g, '#me-name')} / ${await txt(g, '#me-status')}`);
    check((await txt(g, '#me-avatar')) === pickedEmoji && (await g.locator('#me-avatar img').count()) === 0, '방 단계: 요약 카드 아바타 = 고른 얼굴(사진 없음)', await txt(g, '#me-avatar'));
    check(await g.locator('#btn-profile-edit').isVisible(), '방 단계: "프로필 수정" 버튼');
    check(await g.locator('#btn-me-login').isHidden() && await g.locator('#me-account').isHidden(), '방 단계(로그인 꺼짐): 로그인 링크 · 내 정보 · 로그아웃 없음');
    check(await g.locator('#btn-create').isVisible() && await g.locator('#room-code-input').isVisible() && await g.locator('#btn-join').isVisible(), '방 단계: 방 만들기 + 방 코드 참가');
    check(await g.locator('#invite-card').isHidden(), '방 단계: 초대 링크가 아니면 초대 카드 없음');
    await privacyChecks(g, '로그인 꺼짐(방)');
    check(pathOf(g) === '/', '주소: 메인 = /', g.url());
    // 프로필 수정 → /profile(값 유지) → 기기 뒤로가기 = 메인
    await g.evaluate(() => { window.__samePage = 1; });
    await g.click('#btn-profile-edit');
    await g.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check(await g.locator('#landing-step-room').isHidden() && pathOf(g) === '/profile', '프로필 수정 → 프로필 설정(/profile)', g.url());
    check((await val(g, '#nick')) === '게스트' && (await g.locator('#emoji-strip .emoji-btn').nth(5).getAttribute('aria-checked')) === 'true', '프로필 수정: 닉네임 · 얼굴 값 유지');
    await g.goBack();
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(g)) === 'room' && pathOf(g) === '/' && await g.evaluate(() => window.__samePage === 1), '메인 → 프로필 수정 → 뒤로가기: 메인(페이지 유지)', `${await visibleStep(g)} ${g.url()}`);
    // 프로필 수정 → Enter = 저장 → 메인(들어온 항목을 되돌린다)
    await g.click('#btn-profile-edit');
    await g.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    await g.press('#nick', 'Enter');
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await sleep(300);
    check((await visibleStep(g)) === 'room' && pathOf(g) === '/', '프로필 수정: 닉네임에서 Enter = 저장 → 메인(/)', g.url());
    check(await g.evaluate(() => !!(history.state && history.state.landing === 'room' && !history.state.from)), '프로필 수정 저장: 메인 항목으로 되돌아감', await g.evaluate(() => JSON.stringify(history.state)));
    await g.goForward();
    await g.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(g)) === 'profile' && pathOf(g) === '/profile', '앞으로가기: 프로필 수정 항목으로', g.url());
    await g.goBack();
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 }).catch(() => {});
    // 같은 탭 새로고침: 지금 화면(메인) 그대로
    await g.reload();
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 }).catch(() => {});
    check((await visibleStep(g)) === 'room' && (await txt(g, '#me-name')) === '게스트', '같은 탭 새로고침(게스트): 메인 그대로', await visibleStep(g));
    // 새 탭(새 방문): 게스트는 첫 화면부터(로그인 꺼짐 = 프로필 설정), 저장된 닉네임·얼굴 프리필
    const gt = await g.context().newPage();
    gt.on('pageerror', (e) => { console.log('[게스트 새 탭] pageerror: ' + e.message); failures++; });
    await gt.goto(URL + '/');
    await gt.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 }).catch(() => {});
    check((await visibleStep(gt)) === 'profile' && pathOf(gt) === '/profile', '새 방문(게스트, 저장된 닉네임): 첫 화면부터 · 주소 /profile', `${await visibleStep(gt)} ${gt.url()}`);
    check((await val(gt, '#nick')) === '게스트' && (await gt.locator('#emoji-strip .emoji-btn').nth(5).getAttribute('aria-checked')) === 'true', '새 방문: 저장된 닉네임·얼굴 프리필');
    check((await txt(gt, '#btn-profile-next')) === '저장', '프로필: CTA 문구 "저장"', await txt(gt, '#btn-profile-next'));
    await gt.click('#btn-profile-next');
    await gt.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    check(pathOf(gt) === '/' && (await txt(gt, '#me-name')) === '게스트', '저장 → 메인(/) 요약 카드에 저장된 닉네임', gt.url());
    // 직접 주소: 새 탭에서 / 로 오면 첫 화면으로 주소도 바뀐다, /profile 직접 방문도 같은 규칙
    const gt2 = await g.context().newPage();
    await gt2.goto(URL + '/?room=ABCD');
    await gt2.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 });
    check((await val(gt2, '#nick')) === '게스트' && pathOf(gt2) === '/profile' && gt2.url().includes('room=ABCD'), '초대 링크(새 탭, 저장된 프로필): /profile?room=ABCD, 닉네임 프리필', gt2.url());
    await gt2.click('#btn-profile-next');
    await gt2.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    check(await gt2.locator('#invite-card').isVisible() && (await txt(gt2, '#invite-code')) === 'ABCD' && pathOf(gt2) === '/', '초대 링크: 저장 → 메인 초대 카드(코드 유지)', gt2.url());
    await gt.close(); await gt2.close();
    // 초대 링크(같은 탭, 이미 시작함) → 메인 초대 카드
    await g.goto(URL + '/?room=ABCD');
    await g.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    check(await g.locator('#invite-card').isVisible() && (await txt(g, '#invite-code')) === 'ABCD', '초대 링크: "초대받은 방 ABCD" 카드', await txt(g, '#invite-code'));
    check((await txt(g, '#btn-join')) === '이 방에 참가하기' && (await g.getAttribute('#btn-join', 'class')).includes('btn-primary'), '초대 카드: 주 버튼 "이 방에 참가하기"');
    check((await val(g, '#room-code-input')) === 'ABCD' && await g.locator('#room-code-input').isHidden(), '초대 카드: 코드 프리필(입력칸은 숨김)');
    check((await txt(g, '#btn-create')) === '새 방 만들기' && !(await g.getAttribute('#btn-create', 'class')).includes('btn-primary'), '초대 카드: "새 방 만들기"는 보조 버튼');
    await g.click('#btn-invite-dismiss');
    check(await g.locator('#invite-card').isHidden() && await g.locator('#room-code-input').isVisible() && (await val(g, '#room-code-input')) === 'ABCD', '다른 방 코드 입력: 일반 화면(코드 유지)');
    check((await txt(g, '#btn-create')) === '방 만들기' && !g.url().includes('room='), '다른 방 코드 입력: 일반 메인 · 주소에서 ?room= 제거', g.url());
    const mainOrder = await g.evaluate(() => {
      const ids = ['join-row', 'join-divider', 'btn-create'];
      const ys = ids.map((id) => document.getElementById(id).getBoundingClientRect().top);
      return { ys, joinCls: document.getElementById('btn-join').className, createCls: document.getElementById('btn-create').className,
        div: document.getElementById('join-divider-text').textContent.trim(), plus: getComputedStyle(document.getElementById('btn-create'), '::before').content };
    });
    check(mainOrder.ys[0] < mainOrder.ys[1] && mainOrder.ys[1] < mainOrder.ys[2], '메인 순서: 코드 입력 + 참가하기 → 또는 → 방 만들기', JSON.stringify(mainOrder.ys.map(Math.round)));
    check(mainOrder.joinCls.includes('btn-primary') && !mainOrder.createCls.includes('btn-primary') && mainOrder.createCls.includes('btn-outline'), '메인 위계: 참가하기 = 주 버튼, 방 만들기 = 보조', `${mainOrder.joinCls} / ${mainOrder.createCls}`);
    check(mainOrder.div === '또는' && mainOrder.plus === '"+"', '메인: 구분선 "또는" · 방 만들기 앞 "+"', `${mainOrder.div} ${mainOrder.plus}`);
    // 처음 온 사람 + 초대 링크 → 프로필 → 저장 → 초대 카드
    const g2 = await newPage(browser, '게스트2');
    await g2.goto(URL + '/?room=WXYZ');
    await g2.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 });
    check(await g2.locator('#landing-step-room').isHidden(), '초대 링크(새 방문자): 프로필 설정부터');
    await g2.fill('#nick', '초대손님');
    await g2.click('#btn-profile-next');
    await g2.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    check(await g2.locator('#invite-card').isVisible() && (await txt(g2, '#invite-code')) === 'WXYZ', '초대 링크(새 방문자): 저장 → 초대 카드(코드 유지)');
    await g2.context().close();
    await g.click('#btn-create');
    await g.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await g.click('#mode-panel .mode-card[data-mode="classic"]');
    await g.waitForSelector('#settings-panel:not([hidden])', { timeout: 3000 });
    check(await g.locator('#settings-panel').isVisible(), '게스트: 방 만들기 → 설정 패널 표시');
    check(await g.locator('#wordset-tools').isHidden(), '게스트: 설정의 내 세트 도구 숨김');
    check((await g.locator('.login-badge').count()) === 0, '게스트: 플레이어 목록에 ✔ 배지 없음');
    check((await g.locator('#player-list .avatar img').count()) === 0, '게스트(실서버): 플레이어 목록 아바타는 이모지');
    check(await g.locator('#btn-room-profile').isVisible() && await g.locator('#btn-account-top').isHidden(), '게스트 방: "프로필" 버튼 있음 · "내 정보" 없음');
    // 방 안 뒤로가기 → "방을 나갈까요?" (방은 그대로)
    await sleep(200);
    check(pathOf(g) === '/' && g.url().includes('room=') && await g.evaluate(() => !!(history.state && history.state.inRoom)), '방: 메인 위에 방 항목(/?room=)', g.url());
    await g.evaluate(() => { window.__samePage = 'room'; });
    await g.goBack();
    await g.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 }).catch(() => {});
    check(await g.locator('#overlay-leave').isVisible() && await g.locator('#view-room').isVisible(), '방 안 뒤로가기: 나가기 확인 대화상자 · 방 유지');
    check((await txt(g, '#leave-title')) === '방을 나갈까요?' && (await txt(g, '#leave-desc')).includes('메인 화면'), '나가기 확인: 문구(대기실)', await txt(g, '#leave-desc'));
    check(g.url().includes('room=') && await g.evaluate(() => !!(history.state && history.state.inRoom) && window.__samePage === 'room'), '나가기 확인: 방 항목을 다시 쌓음(페이지 유지)', g.url());
    await g.click('#btn-leave-cancel');
    check(await g.locator('#overlay-leave').isHidden() && await g.locator('#view-room').isVisible(), '계속 있기: 대화상자 닫힘 · 방 유지');
    // 대화상자가 떠 있을 때 뒤로가기 = 취소
    await g.goBack();
    await g.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 }).catch(() => {});
    await g.goBack();
    await sleep(300);
    check(await g.locator('#overlay-leave').isHidden() && await g.locator('#view-room').isVisible() && await g.evaluate(() => window.__samePage === 'room'), '대화상자 위 뒤로가기 = 취소(방 유지)');
    // ESC = 취소
    await g.goBack();
    await g.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 }).catch(() => {});
    await g.keyboard.press('Escape');
    check(await g.locator('#overlay-leave').isHidden() && await g.locator('#view-room').isVisible(), 'ESC = 취소');
    // 나가기 → 메인
    await g.goBack();
    await g.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 }).catch(() => {});
    await g.click('#btn-leave-confirm');
    await g.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    await sleep(400);
    check(await g.locator('#landing-step-room').isVisible() && pathOf(g) === '/' && !g.url().includes('room=') && await g.evaluate(() => !!(history.state && history.state.landing === 'room')), '나가기 확인 → 메인(/, ?room= 없음)', `${g.url()} ${await g.evaluate(() => JSON.stringify(history.state))}`);
    const leftCode = await g.evaluate(() => window.__dg && window.__dg.state ? window.__dg.state.roomCode : null);
    check(!leftCode, '나가기 확인: 방 상태 비움', String(leftCode));
    // 다시 방 만들기 → 나가기 버튼(확인 없이) → 메인, 앞으로가기로 방에 되돌아가지 않음
    await g.click('#btn-create');
    await g.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await sleep(200);
    await g.click('#btn-leave');
    await g.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    await sleep(400);
    check(pathOf(g) === '/' && !g.url().includes('room=') && await g.locator('#overlay-leave').isHidden(), '나가기 버튼 → 메인(확인 없음)', g.url());
    await g.goForward();
    await sleep(400);
    check(await g.locator('#landing-step-room').isVisible() && !g.url().includes('room=') && await g.locator('#view-room').isHidden(), '나간 뒤 앞으로가기: 메인 그대로(방 주소 정리)', g.url());
    await g.click('#btn-create');
    await g.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await g.click('#btn-leave');
    await g.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    await sleep(200);
    check(await g.locator('#landing-step-room').isVisible() && !g.url().includes('room='), '방 나가기 → 방 단계, 주소에 ?room= 없음', g.url());
    check(pathOf(g) === '/', '방 나가기 → 주소 /', g.url());

    // ---------- 2-a. 가짜 Supabase: 시작 단계 · 게스트 흐름 ----------
    console.log('\n== 시작 단계 · 게스트로 시작 (가짜 Supabase, 로그아웃) ==');
    const p = await newPage(browser, '로그인');
    await p.goto(`${URL}/?mock=1&auth=1&stay=1&auth_state=out`);
    await p.waitForSelector('#landing-step-start:not([hidden])', { timeout: 5000 });
    await sleep(300);
    check((await visibleStep(p)) === 'start', '첫 방문(로그인 켜짐): 시작 단계', await visibleStep(p));
    const startBtns = await p.locator('#landing-step-start button:visible').allTextContents();
    check(JSON.stringify(startBtns.map((s) => s.trim())) === JSON.stringify(['Google로 시작하기', '카카오로 시작하기', '게스트로 시작하기']), '시작: 버튼은 Google · 카카오 · 게스트 3개뿐', JSON.stringify(startBtns));
    check((await txt(p, '#landing-step-start .divider')) === '또는', '시작: 구분선 문구는 "또는"', await txt(p, '#landing-step-start .divider'));
    const startText = await p.locator('.landing-card').innerText();
    check(!/친구들과 함께|로그인하고 시작|로그인하면|단어 세트/.test(startText), '시작: 태그라인 · "로그인하고 시작" · 안내 문구 없음', JSON.stringify(startText));
    check((await p.locator('.tagline, .auth-title, .auth-note').count()) === 0, '시작: 태그라인/제목/안내 노드 자체가 없음');
    check((await p.locator('#landing-step-start .btn-outline#btn-start-guest').count()) === 1, '시작: 게스트 버튼은 보조(outline) 스타일');
    await privacyChecks(p, '시작');
    const pl = p.locator('.privacy-link');
    const plStyle = await pl.evaluate((e) => { const s = getComputedStyle(e); return { fs: parseFloat(s.fontSize), deco: s.textDecorationLine, color: s.color }; });
    check(plStyle.fs <= 13 && plStyle.deco === 'none', '처리방침 링크: 작게 · 밑줄 없음', JSON.stringify(plStyle));
    await pl.hover();
    await sleep(100);
    check((await pl.evaluate((e) => getComputedStyle(e).textDecorationLine)) === 'underline', '처리방침 링크: hover 시 밑줄');
    await p.mouse.move(5, 5);
    const kakaoBg = await p.locator('#btn-login-kakao').evaluate((e) => getComputedStyle(e).backgroundColor);
    const kakaoFg = await p.locator('#btn-login-kakao').evaluate((e) => getComputedStyle(e).color);
    check(kakaoBg === 'rgb(254, 229, 0)' && kakaoFg === 'rgba(0, 0, 0, 0.85)', '카카오 버튼: #FEE500 배경 + 레이블 검정 85%', `${kakaoBg} / ${kakaoFg}`);
    const brand = await p.evaluate(() => {
      const r = (sel) => getComputedStyle(document.querySelector(sel));
      const ks = document.querySelector('#btn-login-kakao svg.k-symbol path');
      const gp = [...document.querySelectorAll('#btn-login-google svg.g-logo path')].map((e) => e.getAttribute('fill').toUpperCase());
      return { kr: r('#btn-login-kakao').borderRadius, gr: r('#btn-login-google').borderRadius, ks: ks && ks.getAttribute('fill'), gp };
    });
    check(brand.kr === '12px' && brand.gr === '12px', '로그인 버튼: 모서리 12px(카카오 가이드)', `${brand.kr} / ${brand.gr}`);
    check(brand.ks === '#000000', '카카오 버튼: 말풍선 심볼(검정)', String(brand.ks));
    check(JSON.stringify(brand.gp) === JSON.stringify(['#EA4335', '#4285F4', '#FBBC05', '#34A853']), 'Google 버튼: 공식 4색 G 로고', JSON.stringify(brand.gp));
    await p.hover('#btn-login-kakao');
    await sleep(250);
    check((await p.locator('#btn-login-kakao').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(254, 229, 0)', '카카오 버튼: hover 에도 배경색 유지');
    await p.mouse.move(5, 5);
    check((await p.locator('#btn-login-google').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(255, 255, 255)', 'Google 버튼: 흰 배경');
    // 게스트로 시작하기 → 프로필(이모지·색상만)
    await p.evaluate(() => { window.__samePage = 'mock'; });
    check(pathOf(p) === '/login', '주소: 시작 = /login', p.url());
    check(p.url().includes('mock=1'), '주소를 바꿔도 쿼리 유지', p.url());
    await p.click('#btn-start-guest');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check((await visibleStep(p)) === 'profile' && pathOf(p) === '/profile', '게스트로 시작하기 → 프로필 설정(/profile)', p.url());
    check(await p.locator('#avatar-mode').isHidden() && await p.locator('#photo-panel').isHidden() && (await p.locator('#btn-mode-photo:visible').count()) === 0, '게스트 프로필: 사진 탭 없음');
    check(await p.locator('#emoji-strip').isVisible() && await p.locator('#color-row').isVisible() && await p.locator('#avatar-preview').isVisible(), '게스트 프로필: 얼굴 · 색상 · 미리보기');
    await privacyChecks(p, '게스트 프로필');
    await p.fill('#nick', '게스트모크');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    check((await txt(p, '#me-status')) === '게스트' && await p.locator('#btn-me-login').isVisible(), '방 단계(게스트, 로그인 가능): "게스트" + "로그인" 링크');
    check(pathOf(p) === '/', '저장 → 메인(/)', p.url());
    // 뒤로가기: 메인 → 시작(시작 → 프로필 → 저장 흐름은 프로필 항목을 메인으로 바꾼다)
    await p.goBack();
    await p.waitForSelector('#landing-step-start:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'start' && pathOf(p) === '/login' && await p.evaluate(() => window.__samePage === 'mock'), '뒤로가기: 메인 → 시작(/login, 페이지 유지)', `${await visibleStep(p)} ${p.url()}`);
    await p.goForward();
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'room' && pathOf(p) === '/', '앞으로가기: 시작 → 메인', p.url());
    await p.goBack();
    await p.waitForSelector('#landing-step-start:not([hidden])', { timeout: 3000 }).catch(() => {});
    // 다시 앞으로: 게스트 → 프로필(값 유지) → 방 → "로그인" 링크 → 시작
    await p.click('#btn-start-guest');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check((await val(p, '#nick')) === '게스트모크', '게스트 프로필: 입력한 닉네임 유지');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await p.click('#btn-me-login');
    await p.waitForSelector('#landing-step-start:not([hidden])', { timeout: 3000 });
    await sleep(300);
    check((await visibleStep(p)) === 'start' && pathOf(p) === '/login' && await p.evaluate(() => !!(history.state && history.state.landing === 'start' && history.state.from === 'room')), '메인 "로그인" 링크 → 시작(/login, 메인에서 옴)', await p.evaluate(() => JSON.stringify(history.state)));
    await p.goBack();
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'room' && pathOf(p) === '/', '메인 → 로그인 → 뒤로가기: 메인', p.url());
    await p.click('#btn-me-login');
    await p.waitForSelector('#landing-step-start:not([hidden])', { timeout: 3000 });
    await sleep(300);

    // ---------- 2-b. 로그인 → 프로필 설정(사진) ----------
    console.log('\n== 로그인 · 프로필 사진 (가짜 Supabase, 데스크톱) ==');
    const social = await p.evaluate(() => window.__mockAuth.socialPhoto);
    await p.click('#btn-login-google');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#avatar-mode:not([hidden])', { timeout: 3000 });
    await p.waitForFunction(() => document.getElementById('nick').value === '모크유저', null, { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'profile', '첫 로그인(이 브라우저): 프로필 설정으로', await visibleStep(p));
    check((await val(p, '#nick')) === '모크유저', '첫 로그인: 닉네임 = 소셜 닉네임', await val(p, '#nick'));
    check((await p.getAttribute('#btn-mode-photo', 'aria-checked')) === 'true' && (await p.getAttribute('#btn-mode-emoji', 'aria-checked')) === 'false', '첫 로그인: "사진 | 이모지" 중 사진이 기본');
    check(await p.locator('#photo-panel').isVisible() && await p.locator('#emoji-pickers').isHidden() && await p.locator('#avatar-preview').isHidden(), '사진 모드: 큰 사진 미리보기, 얼굴/색상 숨김');
    check((await imgSrc(p, '#photo-preview img.avatar-img')) === social, '사진 모드: 소셜 사진 표시', (await imgSrc(p, '#photo-preview img')) || 'none');
    check((await p.getAttribute('#photo-preview img', 'referrerpolicy')) === 'no-referrer', '사진 <img>: referrerpolicy=no-referrer');
    check(await p.locator('#btn-photo-upload').isVisible() && await p.locator('#btn-photo-reset').isHidden(), '사진 모드: "사진 올리기", 기본 사진이면 "기본 사진으로" 숨김');
    const photoBox = await p.locator('#photo-preview').boundingBox();
    check(photoBox && photoBox.width >= 96 && Math.abs(photoBox.width - photoBox.height) < 1, '사진 미리보기: 큰 원(≥96px)', photoBox && Math.round(photoBox.width));
    await privacyChecks(p, '로그인 프로필');
    // 이모지 ↔ 사진
    await p.click('#btn-mode-emoji');
    check(await p.locator('#photo-panel').isHidden() && await p.locator('#emoji-strip').isVisible() && await p.locator('#color-row').isVisible() && await p.locator('#avatar-preview').isVisible(), '이모지 모드: 얼굴 · 색상 · 작은 미리보기');
    check((await p.getAttribute('#btn-mode-emoji', 'aria-checked')) === 'true', '이모지 탭 선택 표시');
    await p.locator('#emoji-strip .emoji-btn').nth(8).click();
    await p.click('#btn-mode-photo');
    check(await p.locator('#photo-panel').isVisible() && (await imgSrc(p, '#photo-preview img')) === social, '사진 모드로 돌아오면 사진 그대로');
    // 사진 올리기 (320x200 PNG → 256x256 webp, <uid>/ 폴더)
    await p.setInputFiles('#photo-file', await makePng(p, '#e53935'));
    await p.waitForFunction(() => { const i = document.querySelector('#photo-preview img'); return i && i.src.startsWith('blob:'); }, null, { timeout: 5000 }).catch(() => {});
    const up1 = await imgSrc(p, '#photo-preview img');
    check(!!up1 && up1.startsWith('blob:'), '사진 올리기: 미리보기가 올린 사진으로', up1);
    let paths = await storagePaths(p);
    check(paths.length === 1 && /^mock-user-1\/avatar-\d+\.webp$/.test(paths[0]), '사진 올리기: 저장소 <userId>/avatar-<ts>.webp', JSON.stringify(paths));
    const meta1 = paths[0] ? await blobSize(p, paths[0]) : null;
    check(meta1 && meta1.w === 256 && meta1.h === 256 && meta1.type === 'image/webp' && meta1.size <= 1048576, '사진 올리기: 256×256 webp · 1MB 이하', JSON.stringify(meta1));
    const upload1Upsert = await p.evaluate(() => !!window.Account && typeof window.Account.uploadAvatar === 'function');
    check(upload1Upsert, 'Account.uploadAvatar 제공');
    check(await p.locator('#btn-photo-reset').isVisible(), '올린 사진이면 "기본 사진으로" 표시');
    // 기본 사진으로
    await p.click('#btn-photo-reset');
    check((await imgSrc(p, '#photo-preview img')) === social && await p.locator('#btn-photo-reset').isHidden(), '"기본 사진으로": 소셜 사진 복원 · 버튼 숨김');
    // 다시 올리면 앞서 올리고 저장하지 않은 사진은 지운다
    await p.setInputFiles('#photo-file', await makePng(p, '#1e88e5'));
    await p.waitForFunction((u) => { const i = document.querySelector('#photo-preview img'); return i && i.src.startsWith('blob:') && i.src !== u; }, up1, { timeout: 5000 }).catch(() => {});
    const up2 = await imgSrc(p, '#photo-preview img');
    await sleep(200);
    paths = await storagePaths(p);
    check(!!up2 && up2 !== up1 && paths.length === 1, '다시 올리기: 새 사진 · 저장하지 않은 이전 업로드는 삭제', JSON.stringify(paths));
    // 저장 → 프로필 저장(avatar_mode/avatar_url) → 방 단계(요약 카드에 사진)
    await p.fill('#nick', '사진모크');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await p.waitForFunction((u) => { const r = window.__mockAuth.tables.profiles[0]; return r.avatar_url === u && r.nickname === '사진모크'; }, up2, { timeout: 3000 }).catch(() => {});
    let row = await p.evaluate(() => window.__mockAuth.tables.profiles[0]);
    check(row.avatar_mode === 'photo' && row.avatar_url === up2, '저장: 프로필에 avatar_mode=photo · avatar_url=올린 사진', `${row.avatar_mode} / ${String(row.avatar_url).slice(0, 30)}`);
    check(row.nickname === '사진모크' && row.avatar_emoji && row.avatar_color, '저장: 닉네임 · 얼굴 · 색상도 저장', `${row.nickname} ${row.avatar_emoji} ${row.avatar_color}`);
    check((await imgSrc(p, '#me-avatar img.avatar-img')) === up2, '방 단계: 요약 카드에 사진', await imgSrc(p, '#me-avatar img'));
    check((await txt(p, '#me-status')) === 'Google 계정' && await p.locator('#me-account').isVisible() && await p.locator('#btn-me-login').isHidden(), '방 단계(로그인): 제공자 라벨 · 내 정보 · 로그아웃');
    check(await p.evaluate(() => { try { return !!JSON.parse(localStorage.getItem('drawguess.profileConfirmed'))['mock-user-1']; } catch (e) { return false; } }), '저장: 이 브라우저에 프로필 확정 표시(사용자별)');
    // 프로필 수정 → 기본 사진으로 → 저장: 올린 사진 파일은 저장소에서 삭제
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check((await imgSrc(p, '#photo-preview img')) === up2 && await p.locator('#btn-photo-reset').isVisible(), '프로필 수정: 저장한 사진 · "기본 사진으로" 표시');
    await p.click('#btn-photo-reset');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await p.waitForFunction((s) => window.__mockAuth.tables.profiles[0].avatar_url === s, social, { timeout: 3000 }).catch(() => {});
    await sleep(200);
    row = await p.evaluate(() => window.__mockAuth.tables.profiles[0]);
    paths = await storagePaths(p);
    check(row.avatar_url === social && row.avatar_mode === 'photo', '기본 사진으로 저장: avatar_url = 소셜 사진');
    check(paths.length === 0, '기본 사진으로 저장: 이전에 올린 사진 파일 삭제', JSON.stringify(paths));
    check((await imgSrc(p, '#me-avatar img')) === social, '방 단계: 요약 카드에 소셜 사진');
    // 새로고침(확정 후) → 방 단계 바로 (auth_state=out 없이 = 세션이 남아 있는 새로고침. 모크 DB 는 초기값으로 돌아간다: 닉네임 모크유저 · 소셜 사진)
    await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 }).catch(() => {});
    await p.waitForFunction(() => (document.getElementById('me-status').textContent || '').trim() === 'Google 계정', null, { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'room', '새로고침(로그인 · 확정한 적 있음): 방 단계 바로', await visibleStep(p));
    await p.waitForFunction(() => (document.getElementById('me-name').textContent || '').trim() === '모크유저', null, { timeout: 3000 }).catch(() => {});
    check((await txt(p, '#me-name')) === '모크유저' && (await imgSrc(p, '#me-avatar img')) === social, '새로고침: 요약 카드에 프로필 닉네임 · 사진', await txt(p, '#me-name'));
    check(pathOf(p) === '/', '로그인 메인: 주소 /', p.url());
    // 로그인 사용자가 /login 으로 직접 오면 메인으로(주소도 /)
    await p.goto(`${URL}/login?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 }).catch(() => {});
    await p.waitForFunction(() => location.pathname === '/', null, { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'room' && pathOf(p) === '/', '로그인 상태로 /login 직접 방문 → 메인(/)', `${await visibleStep(p)} ${p.url()}`);
    // 로그인: 메인 → 프로필 수정(/profile) → 저장 → 메인, 뒤로가기로도 메인
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check(pathOf(p) === '/profile', '로그인: 프로필 수정 → /profile', p.url());
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await sleep(300);
    check(pathOf(p) === '/' && await p.evaluate(() => !!(history.state && history.state.landing === 'room')), '로그인: 프로필 수정 → 저장 → 메인(/)', p.url());
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    await p.goBack();
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'room' && pathOf(p) === '/', '로그인: 프로필 수정 → 뒤로가기 → 메인', p.url());
    // /profile 새로고침(로그인): 프로필 화면 유지
    await p.goto(`${URL}/profile?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 }).catch(() => {});
    check((await visibleStep(p)) === 'profile' && pathOf(p) === '/profile', '로그인: /profile 직접 방문 → 프로필 설정', p.url());
    await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    // 모크 방: 사진 모드 → 플레이어 목록에 <img>
    await p.click('#btn-create');
    await p.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#player-list li.me', { timeout: 5000 });
    const meImg = p.locator('#player-list li.me .avatar img.avatar-img');
    check((await meImg.count()) === 1 && (await meImg.getAttribute('src')) === social, '방(사진 모드): 내 플레이어 행 아바타 = <img>', await meImg.getAttribute('src').catch(() => 'none'));
    const imgGeo = await p.evaluate(() => {
      const a = document.querySelector('#player-list li.me .avatar'), i = a.querySelector('img'), o = document.querySelector('#player-list li:not(.me) .avatar');
      const ar = a.getBoundingClientRect(), ir = i.getBoundingClientRect(), or = o.getBoundingClientRect();
      return { a: Math.round(ar.width), i: Math.round(ir.width), o: Math.round(or.width), fit: getComputedStyle(i).objectFit, radius: getComputedStyle(i).borderRadius, lazy: i.loading };
    });
    check(imgGeo.a === imgGeo.o && imgGeo.i === imgGeo.a && imgGeo.fit === 'cover' && imgGeo.radius === '50%', '방: 사진 아바타 크기 = 이모지 아바타 크기, 원형 cover', JSON.stringify(imgGeo));
    check((await p.locator('#player-list li:not(.me) .avatar img').count()) === 0, '방: 다른 플레이어(이모지)는 이모지 그대로');
    check(await p.evaluate(() => { const me = window.__dg.state.players.find((x) => x.id === window.__dg.myId()); return !!(me && me.avatar && me.avatar.img); }), '방: room:create 아바타에 img 포함(로그인 · 사진 모드)');
    await p.fill('#chat-input', '안녕');
    await p.press('#chat-input', 'Enter');
    await p.waitForSelector('#chat-list .msg-mine .avatar img', { timeout: 3000 }).catch(() => {});
    check((await p.locator('#chat-list .msg-mine .avatar img').count()) === 1, '채팅: 내 메시지 아바타도 사진');
    await p.click('#btn-leave');
    await p.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    // 이모지 모드로 저장 → 방에서 이모지
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    await p.click('#btn-mode-emoji');
    await p.locator('#emoji-strip .emoji-btn').nth(10).click();
    const emojiPicked = (await p.locator('#emoji-strip .emoji-btn').nth(10).textContent()).trim();
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await p.waitForFunction(() => window.__mockAuth.tables.profiles[0].avatar_mode === 'emoji', null, { timeout: 3000 }).catch(() => {});
    row = await p.evaluate(() => window.__mockAuth.tables.profiles[0]);
    check(row.avatar_mode === 'emoji' && row.avatar_url === social && row.avatar_emoji === emojiPicked, '이모지 모드 저장: avatar_mode=emoji (사진 주소는 보존)', `${row.avatar_mode} ${row.avatar_emoji}`);
    check((await p.locator('#me-avatar img').count()) === 0 && (await txt(p, '#me-avatar')) === emojiPicked, '방 단계: 요약 카드 = 이모지');
    await p.click('#btn-create');
    await p.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#player-list li.me', { timeout: 5000 });
    await sleep(200);
    check((await p.locator('#player-list li.me .avatar img').count()) === 0 && (await txt(p, '#player-list li.me .avatar')).startsWith(emojiPicked), '방(이모지 모드): 내 플레이어 행 = 이모지', await txt(p, '#player-list li.me .avatar'));
    check(await p.evaluate(() => { const me = window.__dg.state.players.find((x) => x.id === window.__dg.myId()); return !!(me && me.avatar && !me.avatar.img); }), '방(이모지 모드): room:create 아바타에 img 없음');
    await p.click('#btn-leave');
    await p.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    // 다시 사진 모드로(이후 내 정보 검증용)
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    await p.click('#btn-mode-photo');
    await p.fill('#nick', '모크유저');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await p.waitForFunction(() => window.__mockAuth.tables.profiles[0].avatar_mode === 'photo' && window.__mockAuth.tables.profiles[0].nickname === '모크유저', null, { timeout: 3000 }).catch(() => {});

    // ---------- 2-c. 내 정보(/me) · 단어 세트 ----------
    console.log('\n== 내 정보(/me) · 단어 세트 (가짜 Supabase, 데스크톱) ==');
    await p.click('#btn-account-open');
    await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
    check(pathOf(p) === '/me' && (await visibleStep(p)) === 'me', '메인 "내 정보" → /me', p.url());
    check(await p.evaluate(() => document.querySelector('.landing-card').classList.contains('is-wide')), '/me: 넓은 카드');
    check((await txt(p, '#mp-provider')).includes('Google') && (await txt(p, '#mp-provider')).includes('mock@example.com'), '내 정보: 제공자 · 이메일', await txt(p, '#mp-provider'));
    check((await txt(p, '#mp-name')) === '모크유저' && (await imgSrc(p, '#mp-avatar img')) === social, '내 정보: 닉네임 · 프로필 사진');
    check((await p.getAttribute('#tab-sets', 'aria-selected')) === 'true' && await p.locator('#me-panel-sets').isVisible() && await p.locator('#me-panel-gallery').isHidden(), '내 정보: 기본 탭 = 단어 세트');
    check(await p.locator('#btn-mp-logout').isVisible() && await p.locator('#btn-mp-delete').isVisible(), '내 정보: 로그아웃 · 회원 탈퇴');
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
    check((await p.locator('#wordset-list .ws-apply').count()) === 0, '내 정보: "이 세트로 방 설정" 버튼 없음(방 밖 화면)');
    check(await p.evaluate(() => window.__mockAuth.tables.word_sets.length === 1 && window.__mockAuth.tables.word_sets[0].owner_id === 'mock-user-1'), '새 세트: DB 행에 owner_id 포함');

    // 빈 폼 검증
    await p.click('#btn-wordset-new');
    await p.fill('#ws-name', '');
    await p.fill('#ws-words', '');
    await p.click('#btn-ws-submit');
    check((await txt(p, '#ws-error')).includes('이름'), '검증: 이름 없이 저장 → 오류 문구', await txt(p, '#ws-error'));
    await p.click('#btn-ws-cancel');
    check(await p.locator('#wordset-form').isHidden(), '검증: 취소로 폼 닫힘');

    // 탭: 그림 → ?tab=gallery · 빈 안내 → 단어 세트로 돌아오면 tab 제거
    await p.click('#tab-gallery');
    check(await p.locator('#me-panel-gallery').isVisible() && await p.locator('#me-panel-sets').isHidden() && p.url().includes('tab=gallery'), '그림 탭: 패널 전환 · 주소 ?tab=gallery', p.url());
    check((await txt(p, '#me-panel-gallery')).includes('그림'), '그림 탭: 빈 안내');
    await p.click('#tab-sets');
    check(await p.locator('#me-panel-sets').isVisible() && !p.url().includes('tab='), '단어 세트 탭: 주소에서 tab 제거', p.url());

    // 프로필 수정: /me → /profile → 저장 → /me
    await p.click('#btn-mp-profile');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    check(pathOf(p) === '/profile', '내 정보 → 프로필 수정(/profile)', p.url());
    await p.fill('#nick', '모크짱');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
    await sleep(300);
    check(pathOf(p) === '/me' && (await txt(p, '#mp-name')) === '모크짱', '프로필 저장 → 내 정보로 돌아옴(닉네임 갱신)', `${p.url()} ${await txt(p, '#mp-name')}`);
    await p.waitForFunction(() => window.__mockAuth.tables.profiles[0].nickname === '모크짱', null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname === '모크짱'), '프로필 저장: DB 반영');
    // 프로필 수정 → 뒤로가기 → /me
    await p.click('#btn-mp-profile');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    await p.goBack();
    await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'me' && pathOf(p) === '/me', '내 정보 → 프로필 수정 → 뒤로가기: 내 정보', p.url());
    // ‹ 메인 → 메인, 다시 들어가서 기기 뒤로가기 → 메인
    await p.click('#btn-me-back');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await sleep(300);
    check(pathOf(p) === '/' && await p.evaluate(() => !document.querySelector('.landing-card').classList.contains('is-wide')), '‹ 메인 → 메인(/)', p.url());
    await p.click('#btn-account-open');
    await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
    await p.goBack();
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'room' && pathOf(p) === '/', '메인 → 내 정보 → 뒤로가기: 메인', p.url());

    // 프로필 설정에서 닉네임을 바꾸고 "저장" → 프로필에 저장, 그 뒤 방 만들기(모크 대기실, 호스트)
    await p.click('#btn-profile-edit');
    await p.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 3000 });
    await p.fill('#nick', '방장모크');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await p.waitForFunction(() => window.__mockAuth.tables.profiles[0].nickname === '방장모크', null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname === '방장모크'), '저장: 바꾼 닉네임이 프로필에 저장', await p.evaluate(() => window.__mockAuth.tables.profiles[0].nickname));
    check((await txt(p, '#me-name')) === '방장모크', '저장: 요약 카드에 바꾼 닉네임');
    await p.click('#btn-create');
    await p.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#settings-panel:not([hidden])', { timeout: 5000 });
    check(await p.locator('.topbar #btn-account-top').isVisible() && await p.locator('.topbar #btn-room-profile').isVisible(), '방 안(데스크톱): 상단바 "프로필" · "내 정보" 버튼');
    check(await p.locator('#wordset-tools').isVisible() && await p.locator('#btn-wordset-save').isVisible(), '설정: "현재 단어를 세트로 저장" 표시');
    check(await p.locator('#wordset-load').isVisible() && (await p.locator('#wordset-load option').count()) === 2, '설정: "내 세트 불러오기" 셀렉트(세트 1개)', await p.locator('#wordset-load option').count());
    await p.waitForFunction(() => window.__dg.state.players.some((pl) => pl.loggedIn), null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => window.__dg.state.players.some((pl) => pl.id === window.__dg.myId() && pl.loggedIn)), '데이터: players[].loggedIn 은 그대로 받음');
    check((await p.locator('.login-badge').count()) === 0, '플레이어 목록: 로그인해도 ✔ 배지를 그리지 않음');

    // 셀렉트로 불러오기 (텍스트 영역만 채움)
    await p.fill('#set-customWords', '임시');
    await p.locator('#set-customWords').blur();
    await p.selectOption('#wordset-load', { index: 1 });
    await sleep(300);
    check((await val(p, '#set-customWords')) === '사과, 바나나, 포도', '셀렉트 불러오기: 텍스트 영역 채움', await val(p, '#set-customWords'));
    check((await val(p, '#wordset-load')) === '', '셀렉트 불러오기: 셀렉트는 기본값으로 복귀');
    await p.waitForFunction(() => /사과/.test(window.__dg.state.settings.customWords), null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => /사과/.test(window.__dg.state.settings.customWords)), '셀렉트 불러오기: room:settings 전송 → state 반영');

    // 현재 단어를 세트로 저장 → 그 자리에서 이름만 받는다
    await p.fill('#set-customWords', '고양이, 강아지');
    await p.locator('#set-customWords').blur();
    await p.click('#btn-wordset-save');
    check(await p.locator('#wordset-quick').isVisible() && await p.locator('#btn-wordset-save').isHidden(), '현재 단어 저장: 이름 입력칸 표시');
    await p.click('#btn-ws-quick-save');
    check((await p.locator('#toasts .toast').filter({ hasText: '세트 이름' }).count()) >= 1 && await p.locator('#wordset-quick').isVisible(), '현재 단어 저장: 이름 없으면 안내');
    await p.fill('#ws-quick-name', '동물');
    await p.press('#ws-quick-name', 'Enter');
    await p.waitForFunction(() => document.querySelectorAll('#wordset-load option').length === 3, null, { timeout: 3000 }).catch(() => {});
    check((await p.locator('#wordset-load option').count()) === 3 && await p.locator('#wordset-quick').isHidden(), '현재 단어 저장: 세트 2개 · 입력칸 닫힘', await p.locator('#wordset-load option').count());
    check(await p.evaluate(() => { const r = window.__mockAuth.tables.word_sets.find((x) => x.name === '동물'); return !!r && JSON.stringify(r.words) === JSON.stringify(['고양이', '강아지']); }), '현재 단어 저장: DB 에 단어 그대로');

    // 방 안 프로필 수정(대기실) — 데스크톱 모달
    console.log('\n== 방 안 프로필 수정 (가짜 Supabase, 데스크톱) ==');
    await p.click('#btn-room-profile');
    await p.waitForSelector('#overlay-profile:not([hidden])', { timeout: 3000 });
    check((await p.locator('#room-profile-modal-body #landing-step-profile').count()) === 1 && await p.locator('#landing-step-profile').isVisible(), '방 프로필: 모달 안에 프로필 폼', await p.locator('#room-profile-modal-body #landing-step-profile').count());
    check((await val(p, '#nick')) === '방장모크' && await p.locator('#avatar-mode').isVisible(), '방 프로필: 지금 이름 · 사진|이모지 선택', await val(p, '#nick'));
    await p.click('#btn-mode-emoji');
    await p.locator('#emoji-strip .emoji-btn').nth(3).click();
    const roomEmoji = (await p.locator('#emoji-strip .emoji-btn').nth(3).textContent()).trim();
    await p.fill('#nick', '방안모크');
    await p.click('#btn-profile-next');
    await p.waitForSelector('#overlay-profile', { state: 'hidden', timeout: 3000 });
    await p.waitForFunction(() => { const me = window.__dg.state.players.find((pl) => pl.id === window.__dg.myId()); return me && me.name === '방안모크'; }, null, { timeout: 3000 }).catch(() => {});
    const meNow = await p.evaluate(() => window.__dg.state.players.find((pl) => pl.id === window.__dg.myId()));
    check(meNow && meNow.name === '방안모크' && meNow.avatar.emoji === roomEmoji && !meNow.avatar.img, '방 프로필 저장: player:update → 방 목록 이름·이모지', JSON.stringify(meNow && { n: meNow.name, a: meNow.avatar }));
    await p.waitForFunction(() => window.__mockAuth.tables.profiles[0].nickname === '방안모크', null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => { const r = window.__mockAuth.tables.profiles[0]; return r.nickname === '방안모크' && r.avatar_mode === 'emoji'; }), '방 프로필 저장: 계정 프로필에도 저장');
    check((await p.locator('#toasts .toast').filter({ hasText: '프로필을 바꿨어요' }).count()) >= 1, '방 프로필 저장: 토스트');
    check(await p.evaluate(() => { const n = document.getElementById('landing-step-profile'); return n.parentElement.classList.contains('landing-card') && n.hidden; }), '방 프로필: 닫으면 폼이 랜딩 자리로 돌아감');
    // 저장하지 않고 닫으면 되돌림
    await p.click('#btn-room-profile');
    await p.waitForSelector('#overlay-profile:not([hidden])', { timeout: 3000 });
    await p.fill('#nick', '임시이름');
    await p.click('#btn-mode-photo');
    await p.click('#btn-room-profile-close');
    check(await p.locator('#overlay-profile').isHidden(), '방 프로필: 닫기');
    await p.click('#btn-room-profile');
    await p.waitForSelector('#overlay-profile:not([hidden])', { timeout: 3000 });
    check((await val(p, '#nick')) === '방안모크' && (await p.getAttribute('#btn-mode-emoji', 'aria-checked')) === 'true', '방 프로필: 저장 안 하고 닫으면 되돌림', await val(p, '#nick'));
    await p.keyboard.press('Escape');
    check(await p.locator('#overlay-profile').isHidden(), '방 프로필: ESC 로 닫힘');

    // 방 안 "내 정보" → 나가고 이동할지 묻기
    await p.click('#btn-account-top');
    await p.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 });
    check((await txt(p, '#leave-title')) === '내 정보로 이동할까요?' && (await txt(p, '#btn-leave-confirm')) === '나가고 이동', '방 "내 정보": 나가고 이동할지 묻기', await txt(p, '#leave-title'));
    await p.click('#btn-leave-cancel');
    check(await p.locator('#view-room').isVisible() && await p.locator('#overlay-leave').isHidden(), '방 "내 정보": 계속 있기 → 방 유지');
    await p.click('#btn-account-top');
    await p.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 });
    await p.click('#btn-leave-confirm');
    await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
    await sleep(400);
    check(await p.locator('#view-room').isHidden() && pathOf(p) === '/me' && !p.url().includes('room='), '방 "내 정보": 나가고 이동 → /me', p.url());
    check((await p.locator('#wordset-list .wordset-item').count()) === 2, '/me: 방에서 저장한 세트도 목록에', await p.locator('#wordset-list .wordset-item').count());
    await p.goBack();
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 }).catch(() => {});
    check((await visibleStep(p)) === 'room' && pathOf(p) === '/' && await p.locator('#view-room').isHidden(), '방 → 내 정보 → 뒤로가기: 메인(방에 다시 들어가지 않음)', p.url());

    // 로그아웃이 다른 곳에서 일어나도(방 안, 새로고침 없이) → 게스트 UI
    await p.click('#btn-create');
    await p.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await p.evaluate(() => window.Account.signOut());
    await p.waitForSelector('#btn-account-top', { state: 'hidden', timeout: 3000 });
    check(await p.locator('#btn-account-top').isHidden() && await p.locator('#wordset-tools').isHidden(), '로그아웃: 방 안 계정 UI 숨김');
    check(await p.locator('#view-room').isVisible(), '로그아웃: 방은 그대로(새로고침 없음)');
    await p.waitForFunction(() => !window.__dg.state.players.some((pl) => pl.loggedIn), null, { timeout: 3000 }).catch(() => {});
    check(await p.evaluate(() => !window.__dg.state.players.some((pl) => pl.loggedIn)), '로그아웃: auth:token null → loggedIn 해제');
    await p.click('#btn-leave');
    await p.waitForSelector('#view-landing:not([hidden])', { timeout: 3000 });
    check(await p.locator('#landing-step-room').isVisible() && (await txt(p, '#me-status')) === '게스트', '로그아웃 후 방 나가기: 방 단계(게스트)', await txt(p, '#me-status'));
    check(await p.locator('#btn-me-login').isVisible() && await p.locator('#me-account').isHidden(), '방 단계(게스트, 로그인 가능): "로그인" 링크 · 내 정보 없음');
    check((await p.locator('#me-avatar img').count()) === 0, '로그아웃: 요약 카드에 사진 없음(게스트는 이모지)');
    await p.click('#btn-me-login');
    await p.waitForSelector('#landing-step-start:not([hidden])', { timeout: 3000 });
    check(await p.locator('#btn-login-google').isVisible() && await p.locator('#btn-login-kakao').isVisible() && await p.locator('#btn-start-guest').isVisible(), '"로그인" 링크 → 시작 단계(Google/카카오/게스트)');

    // 초대 링크로 와서(로그아웃 상태) 로그인(모크는 즉시) → 확정한 적 있으니 방 단계 + 초대 카드 유지
    // (같은 탭 = 이미 게스트로 시작함 → 메인 초대 카드. 새 탭이면 /login 부터)
    await p.goto(`${URL}/?mock=1&auth=1&stay=1&auth_state=out&room=ABCD`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    check(await p.locator('#invite-card').isVisible() && (await txt(p, '#invite-code')) === 'ABCD', '초대 링크(같은 탭, 로그아웃): 메인 초대 카드');
    const pNew = await p.context().newPage();
    await pNew.goto(`${URL}/?mock=1&auth=1&stay=1&auth_state=out&room=ABCD`);
    await pNew.waitForSelector('#landing-step-start:not([hidden])', { timeout: 5000 });
    check((await visibleStep(pNew)) === 'start' && pathOf(pNew) === '/login' && pNew.url().includes('room=ABCD'), '초대 링크(새 탭, 게스트): 시작(/login?room=ABCD)부터', pNew.url());
    await pNew.close();
    await p.click('#btn-me-login');
    await p.waitForSelector('#btn-login-kakao:visible', { timeout: 5000 });
    await p.click('#btn-login-kakao');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    await p.waitForFunction(() => (document.getElementById('me-status').textContent || '').trim() === '카카오 계정', null, { timeout: 3000 }).catch(() => {});
    check((await txt(p, '#me-status')) === '카카오 계정' && await p.locator('#me-account').isVisible(), '재로그인(카카오, 확정한 적 있음): 방 단계로 · "카카오 계정"', await txt(p, '#me-status'));
    check(await p.locator('#invite-card').isVisible() && (await txt(p, '#invite-code')) === 'ABCD', '재로그인: 초대 카드 유지');
    await p.click('#btn-account-open');
    await p.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
    check((await txt(p, '#mp-provider')).includes('카카오'), '재로그인: 내 정보 제공자 라벨(카카오)', await txt(p, '#mp-provider'));
    await p.click('#btn-me-back');
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    // 로그인 버튼을 누르기 전의 초대 코드는 OAuth 리다이렉트 뒤 복원하도록 임시 저장된다(모크는 실제로 이동하지 않으므로 남아 있음) → 다시 열면 초대 카드로 복원되고 소비된다
    check(await p.evaluate(() => sessionStorage.getItem('drawguess.pendingRoom') === 'ABCD'), '로그인 시도 전 방 코드 임시 저장(리다이렉트 복원용)');
    await p.goto(`${URL}/?mock=1&auth=1&stay=1`);
    await p.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    await p.waitForSelector('#me-account:not([hidden])', { timeout: 5000 });
    check(await p.locator('#invite-card').isVisible() && (await txt(p, '#invite-code')) === 'ABCD' && (await val(p, '#room-code-input')) === 'ABCD', '리다이렉트 복귀(로그인): 방 단계 초대 카드로 방 코드 복원', await val(p, '#room-code-input'));
    check(await p.evaluate(() => sessionStorage.getItem('drawguess.pendingRoom') === null), '리다이렉트 복귀: 임시 저장 소비됨');
    // 방 단계에서 로그아웃 → 시작
    await p.evaluate(() => { window.__samePage = 9; });
    await p.click('#btn-logout');
    await p.waitForSelector('#landing-step-start:not([hidden])', { timeout: 3000 }).catch(() => {});
    await sleep(400);
    check((await visibleStep(p)) === 'start' && await p.locator('#btn-login-google').isVisible() && await p.evaluate(() => window.__samePage === 9), '로그아웃(방 단계) → 시작 단계, 페이지 유지', await visibleStep(p));
    check(pathOf(p) === '/login' && await p.evaluate(() => !!(history.state && history.state.landing === 'start')), '로그아웃: 지금 항목을 시작(/login)으로', `${p.url()} ${await p.evaluate(() => JSON.stringify(history.state))}`);

    // ---------- 2-d. 회원 탈퇴 ----------
    console.log('\n== 회원 탈퇴 (가짜 Supabase) ==');
    const del = await newPage(browser, '탈퇴');
    await del.goto(`${URL}/me?mock=1&auth=1&stay=1&delete_fail=1`);
    await del.waitForSelector('#landing-step-profile:not([hidden])', { timeout: 5000 }); // 이 브라우저에서 처음 → 프로필부터
    check(pathOf(del) === '/profile', '/me 직접 방문(처음 로그인): 프로필 설정부터', del.url());
    await del.click('#btn-profile-next');
    await del.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await del.click('#btn-account-open');
    await del.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
    await del.click('#btn-mp-delete');
    await del.waitForSelector('#overlay-delete:not([hidden])', { timeout: 2000 });
    check((await txt(del, '#delete-desc')).includes('되돌릴 수 없어요'), '탈퇴 확인: 되돌릴 수 없다는 안내');
    await del.click('#btn-delete-cancel');
    check(await del.locator('#overlay-delete').isHidden() && await del.locator('#landing-step-me').isVisible(), '탈퇴 확인: 취소');
    // 서버 실패 → 로그인 그대로, 안내
    await del.click('#btn-mp-delete');
    await del.click('#btn-delete-confirm');
    await del.waitForFunction(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /실패/.test(t.textContent)), null, { timeout: 3000 }).catch(() => {});
    check((await del.locator('#toasts .toast').filter({ hasText: '실패' }).count()) >= 1 && await del.locator('#landing-step-me').isVisible() && !(await del.locator('#btn-delete-confirm').isDisabled()), '탈퇴 실패: 안내 · 로그인 유지 · 다시 시도 가능');
    await del.click('#btn-delete-cancel');
    // 성공
    await del.goto(`${URL}/me?mock=1&auth=1&stay=1`);
    await del.waitForSelector('#landing-step-me:not([hidden])', { timeout: 5000 });
    check(pathOf(del) === '/me', '/me 직접 방문(확정한 적 있음): 내 정보', del.url());
    await del.click('#btn-mp-delete');
    await del.click('#btn-delete-confirm');
    await del.waitForSelector('#landing-step-start:not([hidden])', { timeout: 5000 });
    await sleep(300);
    check(pathOf(del) === '/login' && await del.locator('#overlay-delete').isHidden(), '탈퇴: 시작(/login)으로 · 확인 창 닫힘', del.url());
    check(await del.evaluate(() => window.__mockAuth.deleted === true && window.__mockAuth.tables.profiles.length === 0 && window.__mockAuth.session() === null), '탈퇴: 서버 요청(토큰) · 프로필 삭제 · 로그아웃');
    check(await del.evaluate(() => { try { return !JSON.parse(localStorage.getItem('drawguess.profileConfirmed') || '{}')['mock-user-1']; } catch (e) { return false; } }), '탈퇴: 이 브라우저의 확정 표시도 지움');
    check((await del.locator('#toasts .toast').filter({ hasText: '탈퇴했어요' }).count()) >= 1, '탈퇴: 안내 토스트');
    await del.context().close();

    // ---------- 2-e. OAuth 복귀 뒤 뒤로가기 ----------
    console.log('\n== OAuth 복귀 뒤 뒤로가기 (가짜 Supabase) ==');
    const o = await newPage(browser, 'OAuth복귀');
    await o.goto(`${URL}/privacy?before=1`);                                       // 로그인 화면으로 오기 전 페이지
    await o.goto(`${URL}/login?mock=1&auth=1&stay=1&auth_state=out`);            // 시작 화면
    await o.waitForSelector('#landing-step-start:not([hidden])', { timeout: 5000 });
    // 로그인 버튼이 적는 기록을 그대로 흉내(모크 로그인은 리다이렉트하지 않으므로)
    await o.evaluate(() => sessionStorage.setItem('drawguess.oauthHist', JSON.stringify({ len: history.length, fwd: 0, ts: Date.now() })));
    await o.goto(`${URL}/privacy?kakao=login`);                                    // 카카오 로그인 화면 대용
    await o.goto(`${URL}/privacy?kakao=consent`);                                  // 카카오 동의 화면 대용
    await o.goto(`${URL}/login?mock=1&auth=1&stay=1&code=mock-code`);             // 복귀(?code=)
    await o.waitForSelector('#landing-step-profile:not([hidden]), #landing-step-room:not([hidden])', { timeout: 5000 });
    await sleep(300);
    check(await o.evaluate(() => sessionStorage.getItem('drawguess.oauthHist') === null), 'OAuth 복귀: 기록 소비');
    await o.mouse.click(5, 5);
    await o.goBack();
    await o.waitForURL(/before=1/, { timeout: 5000 }).catch(() => {});
    check(o.url().includes('/privacy?before=1'), 'OAuth 복귀 뒤 뒤로가기: 카카오 화면을 건너뛰고 로그인 전 페이지로', o.url());
    await o.context().close();

    // ---------- 3. 모바일 ----------
    console.log('\n== 로그인 UI (가짜 Supabase, 모바일) ==');
    const m = await newPage(browser, '모바일', { ...devices['iPhone 13'] });
    await m.goto(`${URL}/?mock=1&auth=1&stay=1&auth_state=out`);
    await m.waitForSelector('#landing-step-start:not([hidden])', { timeout: 5000 });
    let sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 시작 단계: 가로 스크롤 없음', sw);
    for (const sel of ['#btn-login-google', '#btn-login-kakao', '#btn-start-guest']) {
      const b = await m.locator(sel).boundingBox();
      check(!!b && b.height >= 44 && b.x >= 0 && b.x + b.width <= 390, `모바일 시작: ${sel} 화면 안 · 높이 ≥ 44px`, b && Math.round(b.height));
    }
    await privacyChecks(m, '모바일 시작');
    await m.click('#btn-login-google');
    await m.waitForSelector('#avatar-mode:not([hidden])', { timeout: 5000 });
    check((await visibleStep(m)) === 'profile' && (await m.getAttribute('#btn-mode-photo', 'aria-checked')) === 'true' && (await m.locator('#photo-preview img').count()) === 1, '모바일: 첫 로그인 → 프로필 설정(사진 모드 · 소셜 사진)');
    sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 프로필 설정(사진): 가로 스크롤 없음', sw);
    for (const sel of ['#btn-mode-photo', '#btn-mode-emoji', '#btn-photo-upload', '#btn-profile-next']) {
      const b = await m.locator(sel).boundingBox();
      check(!!b && b.height >= 38 && b.x >= 0 && b.x + b.width <= 390, `모바일 프로필: ${sel} 화면 안 · 높이 ≥ 38px`, b && Math.round(b.height));
    }
    await m.click('#btn-profile-next');
    await m.waitForSelector('#landing-step-room:not([hidden])', { timeout: 5000 });
    await m.waitForSelector('#me-account:not([hidden])', { timeout: 5000 });
    sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 랜딩(로그인, 방 단계): 가로 스크롤 없음', sw);
    check((await txt(m, '#me-status')) === 'Google 계정' && (await m.locator('#me-avatar img').count()) === 1, '모바일: 방 단계 + 제공자 라벨 + 사진');
    await m.click('#btn-account-open');
    await m.waitForSelector('#landing-step-me:not([hidden])', { timeout: 3000 });
    sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 내 정보: 가로 스크롤 없음', sw);
    const bb = await m.locator('#btn-wordset-new').boundingBox();
    check(!!bb && bb.x >= 0 && bb.x + bb.width <= 390, '모바일 내 정보: "새 세트" 버튼이 화면 안', bb && Math.round(bb.x + bb.width));
    for (const sel of ['#btn-me-back', '#btn-mp-profile', '#tab-sets', '#tab-gallery']) {
      const b = await m.locator(sel).boundingBox();
      check(!!b && b.x >= 0 && b.x + b.width <= 390, `모바일 내 정보: ${sel} 화면 안`, b && Math.round(b.x + b.width));
    }
    await m.click('#btn-me-back');
    await m.waitForSelector('#landing-step-room:not([hidden])', { timeout: 3000 });
    await m.click('#btn-create');
    await m.waitForSelector('#view-room:not([hidden])', { timeout: 5000 });
    await m.waitForSelector('#settings-panel:not([hidden])', { timeout: 5000 });
    check((await m.locator('.topbar #btn-account-top').count()) === 0 && (await m.locator('#sheet-menu #btn-account-top').count()) === 1, '모바일 방: "내 정보" 버튼은 헤더가 아니라 메뉴 시트에');
    check((await m.locator('.topbar #btn-room-profile').count()) === 0 && (await m.locator('#sheet-menu #btn-room-profile').count()) === 1, '모바일 방: "프로필" 버튼도 메뉴 시트에');
    check((await m.locator('#player-list li.me .avatar img').count()) === 1, '모바일 방: 내 플레이어 칩에 사진');
    await m.click('#btn-menu');
    await m.waitForSelector('#sheet-menu.open', { timeout: 3000 });
    check(await m.locator('#sheet-menu #btn-account-top').isVisible() && await m.locator('#sheet-menu #btn-room-profile').isVisible(), '모바일 메뉴 시트: "프로필" · "내 정보" 행');
    await m.click('#sheet-menu #btn-room-profile');
    await m.waitForSelector('#sheet-profile.open', { timeout: 3000 });
    check(await m.locator('#sheet-menu').isHidden() && (await m.locator('#sheet-profile-body #landing-step-profile').count()) === 1, '모바일: 메뉴 → 프로필 시트(메뉴 닫힘, 폼이 시트 안)');
    sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 프로필 시트: 가로 스크롤 없음', sw);
    await sleep(400); // 시트가 올라오는 애니메이션이 끝난 뒤
    const sb = await m.locator('#sheet-profile #btn-profile-next').boundingBox();
    check(!!sb && sb.x >= 0 && sb.x + sb.width <= 390 && sb.y + sb.height <= m.viewportSize().height, '모바일 프로필 시트: "저장" 버튼이 화면 안', sb && `${Math.round(sb.y + sb.height)}`);
    // 기기 뒤로가기 = 시트 닫기(방은 그대로)
    await m.goBack();
    await m.waitForSelector('#sheet-profile', { state: 'hidden', timeout: 3000 });
    check(await m.locator('#view-room').isVisible() && await m.locator('#overlay-leave').isHidden(), '모바일: 뒤로가기로 프로필 시트만 닫힘');
    await sleep(400);
    check(await m.evaluate(() => document.getElementById('landing-step-profile').parentElement.classList.contains('landing-card')), '모바일: 시트가 닫히면 폼이 랜딩 자리로');
    // 메뉴 → 내 정보 → 나가고 이동할지 묻기
    await m.click('#btn-menu');
    await m.waitForSelector('#sheet-menu.open', { timeout: 3000 });
    await m.click('#sheet-menu #btn-account-top');
    await m.waitForSelector('#overlay-leave:not([hidden])', { timeout: 3000 });
    check(await m.locator('#sheet-menu').isHidden() && (await txt(m, '#leave-title')) === '내 정보로 이동할까요?', '모바일: 메뉴 → 내 정보 → 나가고 이동할지 묻기');
    await m.click('#btn-leave-cancel');
    check(await m.locator('#wordset-tools').isVisible(), '모바일 설정: 세트 도구 표시');
    check((await m.locator('.login-badge').count()) === 0, '모바일: ✔ 로그인 배지 없음');
    sw = await m.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, '모바일 대기실(로그인): 가로 스크롤 없음', sw);
    // 사진이 깨지면 이모지로 (한 번 실패한 주소는 이 페이지에서 다시 쓰지 않으므로 맨 마지막에)
    await m.evaluate(() => { const i = document.querySelector('#player-list li.me .avatar img'); i.dispatchEvent(new Event('error')); });
    check((await m.locator('#player-list li.me .avatar img').count()) === 0 && ((await txt(m, '#player-list li.me .avatar')) || '').length > 0, '사진 로드 실패: 이모지로 대체', await txt(m, '#player-list li.me .avatar'));
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
