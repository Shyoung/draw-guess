# 서버가 터져서 도망친 곳에 낙원은 있나? (draw-guess)

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

- 방장이 먼저 게임 모드를 고릅니다. **돌아가며 그리기**(기본, 모두 한 번씩 출제), **한 명이 그리기**(지정 출제자가 계속 그리고 나머지가 맞힘, 출제자는 순위 제외), **속도전**(단어 자동 선택, 25초, 힌트 없음, 맞힌 순서로 400·300·200점)이 있습니다. 게임이 끝나고 대기실로 돌아오면 모드는 유지되고 설정 화면이 바로 열립니다.
- 방장이 라운드 수(한 명이 그리기 모드에서는 단어 수), 그리기 시간, 단어 후보 수, 힌트 횟수, 사용자 단어를 설정합니다.
- 2명 이상이면 시작. 참가 순서대로 한 라운드에 한 번씩 출제자가 됩니다.
- 출제자는 15초 안에 단어 후보 중 하나를 고르고, 제한 시간 안에 그립니다.
- 시간이 지나면 초성이 하나씩 힌트로 공개됩니다. 예) 사과 → ㅅ _. 마지막 힌트는 항상 설정한 "종료 N초 전"에 뜨고, 앞의 힌트들은 그 앞에 균등하게 배치되어 단어 길이와 상관없이 힌트가 다 열리는 시점이 같습니다. 마지막 초성 힌트에는 카테고리(동물, 음식, 탈것 등)도 함께 공개됩니다.
- 빨리 맞힐수록 높은 점수. 출제자는 맞힌 사람 비율에 따라 점수를 받습니다.
- 정답을 맞힌 사람의 채팅은 출제자와 다른 정답자에게만 보입니다.
- 그림을 보는 사람은 👍/👎 버튼으로 반응할 수 있고, 반응은 그 사람 아바타 위에 1초간 떠오릅니다.
- 게임이 끝나면 결과 화면이 뜨고 각자 "대기실로 돌아가기"를 눌러 닫습니다. 아직 결과를 보고 있는 사람이 있으면 방장은 새 게임을 시작할 수 없습니다.
- 결과 화면에서 턴별 제시어와 그림을 모은 갤러리를 열 수 있고, 그림마다 또는 전체를 한 장으로 PNG 저장할 수 있습니다. 대기실로 돌아온 뒤에도 "지난 게임 그림 갤러리" 버튼으로 다시 볼 수 있습니다.
- 새로고침이나 잠깐의 연결 끊김은 60초 안에 자동으로 같은 자리(점수 유지)로 돌아옵니다.
- 방 상태는 Redis(Render Key Value)에 계속 저장되어, 배포로 서버가 재시작돼도 몇 초 뒤 같은 방·점수·턴으로 이어집니다.

## 로그인(선택)

Supabase 무료 티어로 Google·카카오 로그인, 프로필, 사용자 단어 세트 저장을 지원합니다. 설정 방법은 [docs/SUPABASE-SETUP.md](docs/SUPABASE-SETUP.md). 환경 변수가 없으면 게스트 전용으로 동작합니다. 개인정보 처리방침은 `/privacy` 에 있으며 운영자 정보를 채워야 합니다.

## 구조

```
server/index.js   Express 정적 서빙 + Socket.IO 핸들러, 방 레지스트리
server/game.js    방/게임 상태 머신 (턴, 타이머, 힌트, 점수, 드로잉 op 기록)
server/words.js   한국어 단어 사전(동물·음식·탈것·옷·악기·스포츠·사물·장소·나라·직업·행동·신체·브랜드 13개 분류)과 후보 선택
public/           클라이언트 (index.html, style.css, client.js)
test/smoke.js     socket.io-client 기반 E2E 스모크 테스트 (npm test)
PROTOCOL.md       서버-클라이언트 이벤트 계약
```

## 테스트

```bash
npm test                 # socket.io-client 시뮬레이션: smoke(약 1분) + reconnect(약 20초) + persist(서버 재시작 복원, 약 20초)
node test/browser.js     # 시스템 Chrome 4탭으로 실제 UI까지 검증 (약 2분, playwright + Chrome 필요)
HEADFUL=1 node test/browser.js   # 창을 띄워서 진행 과정 보기
npm run test:mobile      # iPhone 13 크기에서 게임 중 캔버스·채팅 입력이 한 화면에 들어오는지 등 64개 검사
npm run shots:mobile     # 모바일 화면 스크린샷 10장 → test/shots/mobile/
```

브라우저 테스트는 `test/shots/e2e-*.png` 에 각 단계 스크린샷을 남깁니다.
`public/index.html?mock=1` 로 열면 서버 없이 가짜 소켓으로 화면 흐름만 볼 수 있습니다.

## 배포 (무료 상시 서버)

이 게임은 Socket.IO 웹소켓 서버가 계속 떠 있어야 하므로 **Vercel 같은 서버리스 플랫폼에는 올릴 수 없습니다**
(Vercel Functions는 웹소켓 연결을 유지하지 못하고, 방 상태를 메모리에 두는 구조와도 맞지 않습니다).
웹소켓을 지원하는 무료 Node 호스팅을 쓰세요.

### Render (권장, 무료)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Shyoung/draw-guess)

1. 위 버튼을 누르고 GitHub 계정으로 Render에 로그인합니다.
2. 저장소의 `render.yaml`이 자동으로 읽혀 무료 Web Service가 만들어집니다. Apply를 누르면 2~3분 뒤 `https://draw-guess-xxxx.onrender.com` 주소가 나옵니다.
3. 이후 `main` 브랜치에 push하면 자동으로 재배포됩니다. render.yaml의 Key Value 인스턴스(`draw-guess-kv`)에 방 상태가 저장되므로 배포 중이던 게임도 이어집니다. 배포되면 접속 중인 브라우저는 서버 버전이 달라진 것을 감지해 자동으로 새로고침합니다(진행 중이던 게임은 서버 재시작으로 초기화됩니다). HTML은 캐시하지 않고 js/css에는 버전 쿼리가 붙으므로 "새로고침해도 예전 화면"이 나오지 않습니다.

무료 플랜은 15분간 요청이 없으면 잠들지만, 이 서버는 Render가 넣어 주는 `RENDER_EXTERNAL_URL`로 10분마다 자기 자신의 `/healthz`를 호출해 계속 깨어 있습니다.
따라서 평소에는 대기 없이 바로 접속됩니다. 재배포나 재시작 직후 첫 방문자만 30~60초 기다릴 수 있습니다.
다른 호스팅에서는 `KEEP_ALIVE_URL` 환경 변수에 공개 주소를 넣으면 같은 동작을 합니다. 무료 인스턴스 시간은 월 750시간이라 이 서비스 하나는 한 달 내내 켜 둘 수 있습니다.

### 스테이징(테스트) 서버와 브랜치 운영

레포는 하나, 브랜치 두 개로 운영합니다. render.yaml에 서비스가 둘 있어 같은 코드가 두 곳에 배포됩니다.

| 서비스 | 브랜치 | 용도 | 특징 |
|---|---|---|---|
| `draw-guess` | `main` | 프로덕션 | 자기 핑으로 항상 켜짐, Key Value에 방 상태 저장 |
| `draw-guess-staging` | `develop` | 테스트 | `ALLOW_SOLO=1` 혼자서도 게임 시작 가능, 안 쓰면 잠듦, 방 상태 저장 없음 |

작업 흐름: 기능은 `develop`에 push → 스테이징 주소에서 폰·브라우저로 확인 → `main`에 머지하면 프로덕션 배포.
`/healthz`의 `env` 값으로 어느 서버인지 구분할 수 있습니다.

### 저장소 바꾸기 (다른 호스팅으로 옮길 때)

서버는 `STORE_URL` 또는 `REDIS_URL` 환경 변수 하나로 저장소를 고릅니다. 값만 바꾸면 코드 수정 없이 옮길 수 있습니다.

| 값 | 동작 |
|---|---|
| `redis://…` / `rediss://…` | Redis 호환 서버 (Render Key Value, Upstash, Railway, 자체 호스팅) |
| `file:./data/rooms.json` | JSON 파일 (디스크가 있는 서버, 로컬 개발) |
| 없음 | 저장 안 함 (재시작하면 방이 사라짐) |

### 그 외 선택지

- **Koyeb / Fly.io**: 같은 방식(Node 웹 서비스)으로 배포 가능. 무료 범위와 잠듦 정책은 각 사이트에서 확인.
- **내 PC + Cloudflare Tunnel**: 플레이할 때만 `npm start` 후 `cloudflared tunnel --url http://localhost:3000`을 실행하면 가입 없이 임시 공개 주소가 생깁니다. PC를 꺼두면 접속이 안 됩니다.
- **Oracle Cloud Always Free VM**: 진짜 24시간 무료 서버. 대신 리눅스 서버 세팅(pm2, HTTPS)을 직접 해야 합니다.
