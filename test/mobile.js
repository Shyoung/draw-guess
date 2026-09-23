/**
 * 모바일(iPhone 13, 390x664) 레이아웃 어설션.
 *   node test/mobile.js        → PASS/FAIL 줄 출력, 실패가 있으면 exit 1
 *
 * 확인 항목
 *  - drawing(관전자): #canvas 와 #chat-input 이 스크롤 없이 뷰포트 안에 모두 보인다, 가로 스크롤 없음
 *  - drawing(출제자): #canvas 와 #toolbar 가 뷰포트 안에 보인다
 *  - choosing/turnEnd: 오버레이 카드가 뷰포트 안에 다 들어간다
 *  - gameOver: #ranking-list 와 #btn-gallery-open 이 뷰포트 안에 보인다
 *  - lobby: 페이지 스크롤은 허용, #btn-start 존재, 채팅 입력 font-size ≥ 16px
 */
const { runMobileFlow } = require('./mobile-lib');

const VW = 390, VH = 664;
let failures = 0;
function check(cond, label, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra !== undefined ? '  -> ' + extra : ''}`);
  if (!cond) failures++;
}
const fmt = (b) => b ? `x${Math.round(b.x)} y${Math.round(b.y)} w${Math.round(b.width)} h${Math.round(b.height)}` : 'null';
function inside(b) { return !!b && b.width > 0 && b.height > 0 && b.x >= -0.5 && b.y >= -0.5 && b.x + b.width <= VW + 0.5 && b.y + b.height <= VH + 0.5; }

async function box(page, sel) { return page.locator(sel).first().boundingBox().catch(() => null); }
async function metrics(page) {
  return page.evaluate(() => ({
    sh: document.documentElement.scrollHeight, sw: document.documentElement.scrollWidth,
    ih: window.innerHeight, iw: window.innerWidth, sy: window.scrollY,
    chatFont: parseFloat(getComputedStyle(document.getElementById('chat-input')).fontSize),
    phase: document.getElementById('view-room').getAttribute('data-phase'),
    role: document.getElementById('view-room').getAttribute('data-role'),
  }));
}
async function noPageScroll(page, label) {
  const m = await metrics(page);
  check(m.iw === VW && m.ih === VH, `${label}: 뷰포트 390x664`, `${m.iw}x${m.ih}`);
  check(m.sh <= m.ih + 1, `${label}: 세로 페이지 스크롤 없음`, `scrollHeight=${m.sh} innerHeight=${m.ih}`);
  check(m.sw <= VW, `${label}: 가로 스크롤 없음`, `scrollWidth=${m.sw}`);
  return m;
}

(async () => {
  try {
    await runMobileFlow(async (stage, ctx) => {
      const m = ctx.mobile;
      if (stage === 'landing') {
        const mm = await metrics(m);
        check(mm.sw <= VW, '랜딩: 가로 스크롤 없음', mm.sw);
        check(parseFloat(await m.locator('#nick').evaluate((e) => getComputedStyle(e).fontSize)) >= 16, '랜딩: 닉네임 입력 font-size ≥ 16px');
      }
      if (stage === 'lobby-mode') {
        const mm = await metrics(m);
        check(mm.phase === 'lobby', '로비: data-phase=lobby', mm.phase);
        check(mm.sw <= VW, '로비(모드): 가로 스크롤 없음', mm.sw);
        check(await m.locator('#timer').isHidden(), '로비: 타이머 원 숨김');
        check((await m.locator('#player-list li').count()) === 2, '로비: 플레이어 2명 표시');
      }
      if (stage === 'lobby-settings') {
        const mm = await metrics(m);
        check((await m.locator('#btn-start').count()) === 1, '로비(설정): #btn-start 존재');
        check(mm.chatFont >= 16, '채팅 입력 font-size ≥ 16px', mm.chatFont);
        check(mm.sw <= VW, '로비(설정): 가로 스크롤 없음', mm.sw);
        const chat = await m.locator('#chat-list').evaluate((e) => e.getBoundingClientRect().height);
        check(chat <= 170, '로비: 채팅 목록 높이 ≤ 170px', Math.round(chat));
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
      }
      if (stage === 'drawing-drawer') {
        const mm = await noPageScroll(m, 'drawing(출제자)');
        check(mm.role === 'drawer', 'drawing(출제자): data-role=drawer', mm.role);
        const c = await box(m, '#canvas'), t = await box(m, '#toolbar'), ci = await box(m, '#chat-input');
        check(inside(c), 'drawing(출제자): #canvas 뷰포트 안', fmt(c));
        check(inside(t), 'drawing(출제자): #toolbar 뷰포트 안', fmt(t));
        check(inside(ci), 'drawing(출제자): #chat-input 도 뷰포트 안', fmt(ci));
        check(t && t.height <= 100, 'drawing(출제자): 툴바 높이 ≤ 100px', t && Math.round(t.height));
        const pal = await m.locator('#palette').evaluate((e) => [Math.round(e.getBoundingClientRect().height), e.scrollWidth > e.clientWidth]);
        check(pal[0] <= 40 && pal[1], 'drawing(출제자): 팔레트 한 줄 + 가로 스크롤', pal.join(' '));
        const cw = await m.locator('#custom-color-input').count();
        check(cw === 1, 'drawing(출제자): 커스텀 색상 피커 존재');
        const px = await m.evaluate(() => { const c = document.getElementById('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 250) n++; return n; });
        check(px > 300, 'drawing(출제자): 터치/마우스로 그린 획이 캔버스에', px);
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
        const c = await box(m, '#canvas'), ci = await box(m, '#chat-input'), ds = await box(m, '#draw-status');
        check(inside(c), 'drawing(관전자): #canvas 뷰포트 안', fmt(c));
        check(inside(ci), 'drawing(관전자): #chat-input 뷰포트 안', fmt(ci));
        check(inside(ds), 'drawing(관전자): 👍👎 상태 띠 뷰포트 안', fmt(ds));
        check(c && Math.abs(c.width / c.height - 4 / 3) < 0.02, 'drawing(관전자): 캔버스 4:3', c && (c.width / c.height).toFixed(3));
        check(await m.locator('#toolbar').isHidden(), 'drawing(관전자): 툴바 숨김');
        const list = await m.locator('#chat-list').evaluate((e) => ({ h: Math.round(e.getBoundingClientRect().height), ov: getComputedStyle(e).overflowY }));
        check(list.h >= 56 && list.ov === 'auto', 'drawing(관전자): 채팅 목록 내부 스크롤(≥2줄)', JSON.stringify(list));
        check(mm.chatFont >= 16, 'drawing(관전자): 채팅 입력 font-size ≥ 16px', mm.chatFont);
        const players = await m.locator('.players-panel').evaluate((e) => Math.round(e.getBoundingClientRect().height));
        check(players <= 48, 'drawing(관전자): 플레이어 띠 높이 ≤ 48px', players);
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
  } catch (e) {
    console.log('FAIL  예외:', e.message);
    failures++;
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
