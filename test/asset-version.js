/**
 * 배포 검증용: 서버가 /healthz 에 내는 ASSET_VERSION 을 git 트리 기준으로 계산한다.
 *   node test/asset-version.js            # HEAD
 *   node test/asset-version.js origin/main
 * 워킹 카피가 아니라 git 객체를 읽는 이유: Windows 에서는 체크아웃 시 CRLF 로 바뀌어 해시가 달라지지만,
 * Render(Linux)는 저장소에 든 LF 그대로 배포하므로 트리 기준이 실제 서버 값과 일치한다.
 */
const crypto = require('crypto');
const { execSync } = require('child_process');
const ref = process.argv[2] || 'HEAD';
const files = execSync(`git ls-tree --name-only ${ref} public/`).toString().split(/\r?\n/)
  .filter((n) => /\.(js|css|html)$/.test(n)).map((n) => n.replace(/^public\//, '')).sort();
const h = crypto.createHash('md5');
for (const n of files) { h.update(n); h.update(execSync(`git show ${ref}:public/${n}`)); }
console.log(h.digest('hex').slice(0, 8));
