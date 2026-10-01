#!/usr/bin/env node
// 로컬 서버를 폰·다른 기기에서도 열 수 있게 접속 주소를 출력한다. 사용: node scripts/local-urls.js [포트=3200]
const os = require('os');
const port = process.argv[2] || '3200';
const ips = [];
for (const [name, list] of Object.entries(os.networkInterfaces())) {
  for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) ips.push({ name, ip: a.address });
  }
}
console.log(`이 PC에서:      http://localhost:${port}`);
if (!ips.length) console.log('다른 기기에서:  (사설 IP를 못 찾음 — 같은 Wi-Fi/LAN인지 확인)');
for (const { name, ip } of ips) console.log(`다른 기기에서:  http://${ip}:${port}   (${name})`);
console.log('※ 폰과 이 PC가 같은 Wi-Fi여야 한다. 안 열리면 Windows 방화벽의 Node.js 허용(사설 네트워크)을 확인한다.');
