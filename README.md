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

## 배포 (무료 상시 서버)

이 게임은 Socket.IO 웹소켓 서버가 계속 떠 있어야 하므로 **Vercel 같은 서버리스 플랫폼에는 올릴 수 없습니다**
(Vercel Functions는 웹소켓 연결을 유지하지 못하고, 방 상태를 메모리에 두는 구조와도 맞지 않습니다).
웹소켓을 지원하는 무료 Node 호스팅을 쓰세요.

### Render (권장, 무료)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/shyoung-lee/draw-guess)

1. 위 버튼을 누르고 GitHub 계정으로 Render에 로그인합니다.
2. 저장소의 `render.yaml`이 자동으로 읽혀 무료 Web Service가 만들어집니다. Apply를 누르면 2~3분 뒤 `https://draw-guess-xxxx.onrender.com` 주소가 나옵니다.
3. 이후 `main` 브랜치에 push하면 자동으로 재배포됩니다.

무료 플랜은 15분간 아무도 접속하지 않으면 잠들고, 다음 사람이 링크를 열 때 30~60초 정도 기다렸다가 깨어납니다.
게임을 시작하기 전에 방장이 먼저 링크를 한 번 열어 두면 친구들은 기다리지 않습니다.

### 그 외 선택지

- **Koyeb / Fly.io**: 같은 방식(Node 웹 서비스)으로 배포 가능. 무료 범위와 잠듦 정책은 각 사이트에서 확인.
- **내 PC + Cloudflare Tunnel**: 플레이할 때만 `npm start` 후 `cloudflared tunnel --url http://localhost:3000`을 실행하면 가입 없이 임시 공개 주소가 생깁니다. PC를 꺼두면 접속이 안 됩니다.
- **Oracle Cloud Always Free VM**: 진짜 24시간 무료 서버. 대신 리눅스 서버 세팅(pm2, HTTPS)을 직접 해야 합니다.
