/**
 * EADDRINUSE 짧은 재시도 회귀 테스트
 *  - T-20260930-5: npm test 를 곧바로 다시 돌리면 이전 실행이 막 닫은 포트가
 *    (Windows 에선 TIME_WAIT 로) 아직 안 풀려 자식 서버가 EADDRINUSE 로 죽을 수 있었다.
 *  - test/*.js 의 startServer() 는 이제 EADDRINUSE 를 만나면 300ms 뒤 짧게 재시도한다(최대 3회).
 *  - 이 테스트는 test/modes.js 가 쓰는 포트를 더미 리스너로 붙잡아 EADDRINUSE 를 결정적으로 재현한 뒤,
 *    자식이 실제로 EADDRINUSE 를 뱉는 순간(고정 시간 대기 아님, T-20260930-6) 더미를 풀어
 *    test/modes.js 전체가 그래도 통과하는지 검증한다.
 *  node test/retry-eaddrinuse.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// modes.js 와 같은 포트 계산식을 그대로 따른다(다른 test/*.js 도 동일한 재시도 로직을 쓰므로 대표로 검증).
const PORT = 3129 + Number(process.env.TEST_PORT_OFFSET ?? 0);

let passes = 0, failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (ok) passes += 1; else failures += 1;
  const suffix = !ok && detail !== undefined ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${suffix}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const overallTimer = setTimeout(() => {
  console.log('FAIL - overall timeout');
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(2);
}, 60000);

(async () => {
  // 포트를 더미 서버로 미리 점유해 자식 프로세스가 EADDRINUSE 로 죽도록 만든다.
  const dummy = http.createServer();
  await new Promise((resolve, reject) => {
    dummy.once('error', reject);
    dummy.listen(PORT, resolve);
  });

  const child = spawn(process.execPath, ['test/modes.js'], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  let sawAddrInUse = false;
  let dummyClosed = false;
  // 고정 시간(예: 800ms) 뒤에 더미를 내리면 느린 기동 환경(부하가 큰 CPU, 동시 테스트 실행 등)에서
  // 자식이 아직 첫 listen 시도조차 안 했는데 더미가 먼저 풀려 EADDRINUSE 를 영영 못 만나는
  // 간헐적 실패(T-20260930-6)가 있었다. 시간 대신 자식이 실제로 EADDRINUSE 를 뱉는 순간에
  // 반응해서 더미를 풀어주면 기동 속도와 무관하게 항상 재현된다.
  const releaseDummy = () => {
    if (dummyClosed) return;
    dummyClosed = true;
    dummy.close();
  };
  child.stdout.on('data', (d) => { out += String(d); });
  child.stderr.on('data', (d) => {
    const text = String(d);
    err += text;
    if (!sawAddrInUse && /EADDRINUSE/.test(text)) {
      sawAddrInUse = true;
      releaseDummy();
    }
  });
  const exitCode = await new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  releaseDummy(); // 안전망: EADDRINUSE 를 못 만난 이상 상황이어도 더미는 항상 정리한다.

  check('더미가 포트를 점유한 동안 EADDRINUSE 가 실제로 발생했다(재시도 경로를 탔다는 증거)', sawAddrInUse, err.slice(0, 300));
  check('재시도 끝에 test/modes.js 전체가 통과했다(exit 0)', exitCode === 0, { exitCode, tail: out.slice(-300) });
  check('test/modes.js 결과 요약에 실패 0', /\b0 failed\b/.test(out), out.slice(-200));

  console.log(`\n${passes} passed, ${failures} failed`);
  clearTimeout(overallTimer);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  check(`unexpected error: ${err && err.message}`, false, err && err.stack);
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(1);
});
