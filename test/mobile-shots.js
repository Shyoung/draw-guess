/**
 * iPhone 13 뷰포트(390x664) 스크린샷 10장을 test/shots/mobile/ 에 남긴다.
 * fullPage 가 아니라 "사용자가 실제로 보는 화면"(뷰포트)만 찍는다.
 *   node test/mobile-shots.js
 */
const path = require('path');
const fs = require('fs');
const { runMobileFlow } = require('./mobile-lib');

const SHOTS = path.join(__dirname, 'shots', 'mobile');
fs.mkdirSync(SHOTS, { recursive: true });

const FILES = {
  'landing': '01-landing.png',
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

(async () => {
  let failed = false;
  try {
    await runMobileFlow(async (stage, ctx) => {
      const file = FILES[stage]; if (!file) return;
      await ctx.mobile.screenshot({ path: path.join(SHOTS, file), fullPage: false, scale: 'css' });
      console.log('shot ', file);
    });
  } catch (e) {
    failed = true;
    console.log('FAIL  예외:', e.message);
  }
  console.log(failed ? '\nSHOTS INCOMPLETE' : `\nDONE  ${Object.keys(FILES).length} shots -> ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})();
