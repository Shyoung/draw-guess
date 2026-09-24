/**
 * iPhone 13 뷰포트(390x664) 스크린샷을 test/shots/mobile/ 에 남긴다.
 * fullPage 가 아니라 "사용자가 실제로 보는 화면"(뷰포트)만 찍는다.
 *   node test/mobile-shots.js
 *
 * 1회차(기본 단계): 01 랜딩 1단계(프로필) · 01b 랜딩 2단계(방) · 02~10 기본 단계 + 11 메뉴 시트 · 12 플레이어 시트 · 13 채팅 시트(출제자) · 14 키보드 컴팩트(390x360)
 * 2회차(긴 사용자 단어): 15 관전자 마스크 · 16 출제자 단어
 */
const path = require('path');
const fs = require('fs');
const { runMobileFlow, say, sleep } = require('./mobile-lib');

const SHOTS = path.join(__dirname, 'shots', 'mobile');
fs.mkdirSync(SHOTS, { recursive: true });

const FILES = {
  'landing': '01-landing.png',
  'landing-room': '01b-landing-room.png',
  'lobby-mode': '02-lobby-mode.png',
  'lobby-settings': '03-lobby-settings.png',
  'choosing-drawer': '04-choosing-drawer.png',
  'drawing-drawer': '05-drawing-drawer.png',
  'turnend': '06-turnend.png',
  'drawing-guesser': '07-drawing-guesser.png',
  'drawing-guesser-chat': '08-drawing-guesser-chat.png',
  'gameover': '09-gameover.png',
  'gallery': '10-gallery.png',
};
const EXTRA = ['11-menu-sheet.png', '12-players-sheet.png', '13-chat-sheet.png', '14-keyboard-compact.png', '15-long-word.png', '16-long-word-drawer.png'];
let taken = 0;

async function shot(page, file) {
  await page.screenshot({ path: path.join(SHOTS, file), fullPage: false, scale: 'css' });
  console.log('shot ', file); taken++;
}
async function openSheet(page, btnSel, sheetId) {
  await page.click(btnSel);
  await page.waitForSelector(`#${sheetId}.open`, { timeout: 3000 });
  await sleep(350);
}
async function closeSheet(page, sheetId) {
  await page.keyboard.press('Escape');
  await page.waitForSelector(`#${sheetId}`, { state: 'hidden', timeout: 3000 });
  await sleep(120);
}

(async () => {
  let failed = false;
  try {
    await runMobileFlow(async (stage, ctx) => {
      const m = ctx.mobile;
      const file = FILES[stage];
      if (file) await shot(m, file);
      if (stage === 'drawing-drawer') {
        await openSheet(m, '#drawer-chat', 'sheet-chat');
        await shot(m, '13-chat-sheet.png');
        await closeSheet(m, 'sheet-chat');
      }
      if (stage === 'drawing-guesser') {
        await openSheet(m, '#btn-menu', 'sheet-menu');
        await shot(m, '11-menu-sheet.png');
        await closeSheet(m, 'sheet-menu');
        await openSheet(m, '#turn-strip', 'sheet-players');
        await shot(m, '12-players-sheet.png');
        await closeSheet(m, 'sheet-players');
        // 키보드가 열린 것처럼 visualViewport 를 360px 로
        await m.setViewportSize({ width: 390, height: 360 });
        await m.waitForSelector('#view-room[data-compact="1"]', { timeout: 3000 });
        await say(m, '컴팩트 모드!');
        await m.waitForSelector('#chat-bubbles .chat-bubble', { timeout: 3000 });
        await sleep(300);
        await shot(m, '14-keyboard-compact.png');
        await m.setViewportSize({ width: 390, height: 664 });
        await m.waitForSelector('#view-room:not([data-compact])', { timeout: 3000 });
        await sleep(200);
      }
    });
    await runMobileFlow(async (stage, ctx) => {
      if (stage === 'drawing-guesser') await shot(ctx.mobile, '15-long-word.png');
      if (stage === 'drawing-drawer') await shot(ctx.mobile, '16-long-word-drawer.png');
    }, { customWords: '아이스아메리카노한잔, 딸기바나나초코스무디, 민트초코칩아이스크림콘', wordCount: 2 });
  } catch (e) {
    failed = true;
    console.log('FAIL  예외:', e.message);
  }
  const expected = Object.keys(FILES).length + EXTRA.length;
  console.log(failed ? '\nSHOTS INCOMPLETE' : `\nDONE  ${taken}/${expected} shots -> ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})();
