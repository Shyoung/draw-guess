# 그림 맞추기 (draw-guess)

skribbl.io 스타일의 실시간 멀티플레이 그림 맞추기 웹 게임. 한 사람이 제시어를 그리고, 나머지가 채팅으로 정답을 맞힙니다.

## 실행

```bash
npm install
npm start          # http://localhost:3000
# 개발 중 자동 재시작
npm run dev
```

다른 포트로 띄우려면 `PORT=4000 npm start` (PowerShell: `$env:PORT=4000; npm start`).

## 같은 네트워크의 친구와 플레이

1. 서버를 띄운 PC의 IP를 확인합니다 (`ipconfig` → IPv4).
2. 친구가 `http://<IP>:3000` 으로 접속해 방 코드를 입력하거나, 방 안의 **초대 링크 복사** 버튼으로 받은 링크를 열면 됩니다.
3. 인터넷 너머 친구와 하려면 [ngrok](https://ngrok.com) / [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 같은 터널로 3000 포트를 공개하세요.

## 게임 규칙

- 방장이 라운드 수, 그리기 시간, 단어 후보 수, 힌트 횟수, 사용자 단어를 설정합니다.
- 2명 이상이면 시작. 참가 순서대로 한 라운드에 한 번씩 출제자가 됩니다.
- 출제자는 15초 안에 단어 후보 중 하나를 고르고, 제한 시간 안에 그립니다.
- 시간이 지나면 글자가 하나씩 힌트로 공개됩니다.
- 빨리 맞힐수록 높은 점수. 출제자는 맞힌 사람 비율에 따라 점수를 받습니다.
- 정답을 맞힌 사람의 채팅은 출제자와 다른 정답자에게만 보입니다.

## 구조

```
server/index.js   Express 정적 서빙 + Socket.IO 핸들러, 방 레지스트리
server/game.js    방/게임 상태 머신 (턴, 타이머, 힌트, 점수, 드로잉 op 기록)
server/words.js   한국어 단어 사전(7개 분류, 2음절 이상)과 후보 선택
public/           클라이언트 (index.html, style.css, client.js)
test/smoke.js     socket.io-client 기반 E2E 스모크 테스트 (npm test)
PROTOCOL.md       서버-클라이언트 이벤트 계약
```

## 테스트

```bash
npm test                 # socket.io-client 3~4명 시뮬레이션 (약 1분, 브라우저 불필요)
node test/browser.js     # 시스템 Chrome 4탭으로 실제 UI까지 검증 (약 2분, playwright + Chrome 필요)
HEADFUL=1 node test/browser.js   # 창을 띄워서 진행 과정 보기
```

브라우저 테스트는 `test/shots/e2e-*.png` 에 각 단계 스크린샷을 남깁니다.
`public/index.html?mock=1` 로 열면 서버 없이 가짜 소켓으로 화면 흐름만 볼 수 있습니다.
