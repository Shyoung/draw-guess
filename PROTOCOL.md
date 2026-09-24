# draw-guess — Socket.IO Protocol & Game Rules (v1)

이 문서는 서버(`server/`)와 클라이언트(`public/`)가 **반드시 동일하게 따라야 하는 계약**이다.
이벤트 이름·페이로드 필드명·값을 임의로 바꾸지 않는다. 필요하면 이 문서를 먼저 고치고 양쪽을 맞춘다.

## Stack
- Server: Node 24, `express@4` + `socket.io@4`. 진입점 `server/index.js` (PORT env, 기본 3000). `public/`을 정적 서빙.
- Client: 순수 HTML/CSS/JS (프레임워크 없음). `public/index.html`, `public/style.css`, `public/client.js`.
  Socket.IO 클라이언트는 서버가 제공하는 `/socket.io/socket.io.js`를 `<script>`로 로드.
- UI 언어: 한국어. 코드 주석은 한국어/영어 무관.

## Canvas
- 논리 좌표계는 **800 x 600** 고정 (정수 px). CSS로 반응형 축소만 한다. 모든 좌표는 이 논리 공간 기준.
- 배경은 흰색(`#ffffff`). 지우개(`eraser`)는 흰색으로 그린다.

## 로그인 (선택, Supabase)
- 서버는 `/config.js` 로 `window.APP_CONFIG = { supabaseUrl, supabaseAnonKey }` 를 내려준다(로그인이 꺼져 있으면 `{}`). 클라이언트는 supabase-js 로 Google/Kakao OAuth 를 직접 수행하고, 소켓 연결 시 `io({ auth: { token: <access_token> } })` 로 토큰을 보낸다.
- 서버는 토큰을 검증해 플레이어에 `userId` 를 붙인다. `room:state.players[].loggedIn` 으로 노출(id 자체는 노출하지 않음). 접속 중 로그인/로그아웃은 `auth:token { token|null }`.
- 프로필·단어 세트·보관한 그림(drawings, 비공개 Storage 버킷)은 클라이언트가 supabase-js 로 직접 읽고 쓴다(RLS 로 본인 것만). 게임 서버는 관여하지 않는다.
  그림 보관: `game:over.gallery` 중 `drawerId === 내 id` 이고 ops 가 있는 턴을 클라이언트가 800×600 webp 로 그려 저장한다(사용자당 100장).

### HTTP (로그인 켜짐일 때만)
- `POST /api/account/delete` — 헤더 `Authorization: Bearer <Supabase access token>`. 업로드한 프로필 사진(`avatars/<uid>/*`)을 지우고 Auth 사용자를 삭제(profiles·word_sets 는 cascade). 응답 `{ ok:true }` · 401 토큰 무효 · 500 실패. 방 안에 있던 그 계정 플레이어는 `loggedIn:false` 로.
- 서버는 하루 한 번 Supabase 에 가벼운 조회를 보내 무료 프로젝트 일시 정지(7일 무활동)를 막는다.

## Identity
- 플레이어 id = 최초 접속 시의 `socket.id`. 재접속(`room:rejoin`)해도 바뀌지 않는다(서버가 playerId→socketId를 매핑).
- `avatar` = `{ emoji: string, color: string, img?: string }` (color는 `#rrggbb`). `img`(프로필 사진 URL)는 **로그인 사용자만** 허용되며 서버가 https + 허용 호스트(우리 Supabase Storage `avatars` 버킷, `*.googleusercontent.com`, `*.kakaocdn.net`)만 통과시킨다. 클라이언트는 `img` 가 있으면 사진을, 로드 실패 시 emoji+color 로 대체해 그린다.
- 이름은 1~12자, trim 후 빈 문자열이면 서버가 거절.

## Phases
`'lobby' | 'choosing' | 'drawing' | 'turnEnd' | 'gameOver'`

## Settings (호스트만 변경, lobby 단계에서만)
```js
{
  rounds: 3,          // 1..10
  drawTime: 80,       // 초, 15..180
  wordCount: 3,       // 출제자에게 제시할 단어 후보 수, 2..5
  hints: 2,           // 턴당 자동 힌트(초성 공개) 횟수, 0..5 (단어의 공개 가능 글자 수가 더 적으면 그만큼만)
  hintEndAt: 15,      // 마지막 힌트가 뜨는 시점(종료 N초 전), 5..60
  customWords: '',    // 쉼표 구분 사용자 단어, 각 단어 1..20자
  customWordsOnly: false,
  mode: 'classic',    // 'classic' 돌아가며 그리기(기본) | 'fixed' 한 명이 계속 그리기(지정 출제자) | 'blitz' 속도전
  fixedDrawerId: null // fixed 모드 출제자 id. 방에 없는 id/null 이면 호스트가 출제자
}
```
서버는 범위를 벗어나면 clamp 한다.

---

## Client → Server

| event | payload | ack / 비고 |
|---|---|---|
| `room:create` | `{ name, avatar, token? }` | ack `{ ok:true, roomCode, playerId, token }` 또는 `{ ok:false, error }`. `token`(영숫자·`_-` 8~64자)은 재접속용이며 없으면 서버가 발급 |
| `room:rejoin` | `{ roomCode, token }` | 같은 `token`을 가진 플레이어가 방에 있으면(연결 상태 무관) 그 자리로 복귀: 같은 `playerId`·점수·순서 유지. 옛 소켓이 아직 살아 있으면 그쪽에 `session:replaced`를 보내고 떼어낸다(새로고침 경합·다른 탭). 유예 시간(기본 60초, `RECONNECT_GRACE_MS`)이 지나 퇴장된 뒤에는 실패. ack 형식은 create와 동일. 성공 시 `room:state`와 진행 상황(catch-up)이 개별 전송된다 |
| `react:send` | `{ kind:'up'\|'down' }` | drawing 중 비출제자. 기록되지 않고 방 전체에 `react:show`로 중계. 플레이어당 초당 8회 제한 |
| `room:join` | `{ roomCode, name, avatar, token? }` | 같은 `token`이 이미 그 방에 있으면 새 자리를 만들지 않고 그 자리로 복귀(이름·아바타는 새 값으로 갱신, ack의 `playerId`는 기존 id). ack 동일. 방 없음/게임 중 아님이면 join 허용(진행 중 참가 가능, 관전 후 다음 턴부터 참여). 최대 12명. roomCode는 대문자 정규화 |
| `room:leave` | – | 방 나가기 |
| `room:settings` | `{ settings }` | 호스트, lobby에서만. 성공 시 모두에게 `room:state` |
| `results:done` | – | 게임 종료 결과 화면을 닫음(본인). `players[].atResults` 가 false 로 바뀜 |
| `lobby:step` | `{ step:'mode'\|'settings' }` | 호스트, lobby. 대기실 화면 단계 전환. 방을 만들면 `mode`, 게임이 끝나 돌아오면 `settings`(모드 유지) |
| `game:start` | – | 호스트, lobby, 접속 플레이어 ≥ 2. fixed 모드는 출제자가 접속 중이어야 함 |
| `game:end` | – | 호스트, 게임 중(choosing / drawing / turnEnd). 즉시 끝내고 모두 lobby 로 — 결과 화면·갤러리 없음(점수는 다음 `game:start` 까지 표시만). 방 전체에 `game:aborted` → `room:state` → 시스템 메시지 |
| `word:choose` | `{ word }` | 출제자, choosing 단계, 제시된 후보 중 하나여야 함 |
| `draw:start` | `{ tool:'pen'\|'eraser', color:'#rrggbb', size:number, x, y }` | 출제자, drawing 단계 |
| `draw:move` | `{ pts: [[x,y], ...] }` | 배치(≈16~30ms 단위) |
| `draw:end` | – | |
| `draw:fill` | `{ x, y, color }` | 채우기 도구 |
| `draw:clear` | – | |
| `draw:undo` | – | 마지막 op 제거 |
| `chat:message` | `{ text }` | 1..100자. 정답 판정은 서버가 함 |
| `player:kick` | `{ playerId }` | 호스트 |
| `player:update` | `{ name, avatar }` | 내 닉네임·아바타 바꾸기. **lobby 단계에서만**(게임 중이면 ack `{ ok:false, error }`). 검증은 `room:join` 과 같음(이름 1..12자, 게스트 `img` 제거). ack `{ ok:true }`, 이후 `room:state` 갱신 · 이름이 바뀌면 시스템 메시지 |

## Server → Client

### `room:state` — 방/플레이어 스냅샷. 변화가 있을 때마다 방 전체에 전송
```js
{
  roomCode, hostId, phase, round, totalRounds,
  drawerId,                 // 현재 출제자 (lobby면 null)
  settings,
  players: [{ id, name, avatar, score, isDrawing, hasGuessed, connected, atResults, loggedIn }],  // 참가 순서. connected=false 는 유예 중(재접속 대기). atResults=true 는 게임 종료 결과 화면을 아직 닫지 않음
  nextDrawerId,             // 다음 턴에 출제할 사람. lobby/gameOver거나 이번이 마지막 턴이면 null
  lobbyStep,                // 'mode' | 'settings' — 대기실 화면 단계
  fixedDrawerId,            // fixed 모드의 실제 출제자(지정 없으면 호스트). classic 이면 null
  allowSolo                 // 서버가 ALLOW_SOLO=1(스테이징)로 떠 있으면 true: 최소 인원 1명. 프로덕션은 false(2명)
}
```

### 게임 진행
| event | payload | 비고 |
|---|---|---|
| `game:choosing` | `{ drawerId, drawerName, timeLeft, wordOptions? }` | `wordOptions`(string[])는 **출제자에게만** 포함. 나머지는 없음(undefined) |
| `game:drawing` | `{ drawerId, round, totalRounds, timeLeft, wordMask, wordLength, word?, category? }` | `word`·`category`는 출제자에게만(catch-up 시 이미 공개된 카테고리는 비출제자에게도). `wordMask` 형식은 아래 참고 |
| `game:hint` | `{ wordMask, category? }` | 초성 공개 갱신 (출제자·이미 정답을 맞힌 사람 제외). 누군가 정답을 맞히면 그 사람에게만 별도로 `wordMask`가 실제 글자로 전체 공개된 `game:hint`가 온다(초성이 아님) |
| `game:timer` | `{ timeLeft }` | 매 1초 (choosing / drawing 단계) |
| `game:turnEnd` | `{ word, reason:'time'\|'allGuessed'\|'drawerLeft'\|'notEnoughPlayers', deltas:[{ id, delta }], timeLeft }` | 5초간 표시. `deltas`에는 이번 턴 획득 점수(0 포함 전원) |
| `game:aborted` | `{ by }` | 방장(`by` = 이름)이 `game:end` 로 게임을 끝냄. 클라이언트는 턴/단어/오버레이를 지우고 대기실을 그린다(결과 화면 없음) |
| `game:over` | `{ ranking:[{ id, name, avatar, score }], mode, drawer?:{ id, name, avatar }, gallery:[{ round, word, category, drawerId, drawerName, guessed, ops, trimmed? }] }` | 점수 내림차순. 이후 방은 **즉시** lobby 로 돌아가지만 모든 플레이어의 `atResults` 가 true 로 설정되어 각자 `results:done` 을 보낼 때까지 결과 화면을 유지한다. 접속 중인 누군가가 `atResults` 이면 `game:start` 는 거부된다. `gallery`는 이 게임에서 실제로 그린 턴들의 (제시어, 그림 ops) 기록 — 클라이언트가 갤러리로 렌더링하고 PNG로 저장. 전체가 약 1.5MB를 넘으면 오래된 턴의 `ops`를 비우고 `trimmed:true`. 10초 후 서버가 lobby로 복귀시키고 `room:state` 전송 |

### 드로잉 (출제자를 제외한 방 전체에 그대로 중계)
`draw:start`, `draw:move`, `draw:end`, `draw:fill`, `draw:clear`, `draw:undo` — 페이로드는 C→S와 동일.

`draw:sync` `{ ops }` — 중간 참가자 및 `game:drawing` 시작 시(빈 배열) 전송. 클라이언트는 캔버스를 지우고 ops를 순서대로 재생.
```js
// op 형식
{ type:'stroke', tool:'pen'|'eraser', color, size, points:[[x,y],...] }
{ type:'fill',   x, y, color }
```
서버는 현재 턴의 `ops[]`를 유지한다: `draw:start`로 새 stroke op 생성, `draw:move`로 points 추가, `draw:end`로 확정.
`draw:fill`은 즉시 op 추가. `draw:undo`는 마지막 op pop. `draw:clear`는 ops 비움.
클라이언트도 동일한 ops 배열을 로컬에 유지해 `draw:undo` 수신 시 pop 후 전체 재그리기 한다.

### 채팅
`chat:message` `{ id?, name?, avatar?, text, kind }`
- `kind`: `'chat'` (일반) | `'system'` (입장/퇴장/턴 안내) | `'correct'` ("○○님이 정답을 맞혔습니다!") | `'close'` (정답에 근접, **보낸 사람에게만**) | `'guessed-chat'` (정답자 전용 채팅)
- 정답을 맞힌 사람과 출제자가 drawing 중에 보내는 메시지는 `'guessed-chat'`으로 **출제자 + 이미 맞힌 사람들에게만** 전달.
- 정답 텍스트 자체는 절대 브로드캐스트하지 않는다.

`player:guessed` `{ id }` — 누가 맞혔는지 (플레이어 목록 하이라이트용). 이후 `room:state`도 갱신됨.

`session:replaced` `{ message }` — 이 소켓의 자리를 같은 토큰의 다른 소켓이 넘겨받았다. 클라이언트는 재접속을 시도하지 말고 랜딩으로 돌아간다.

`react:show` `{ id, kind:'up'|'down' }` — 누군가 👍/👎 반응. 클라이언트는 그 사람 아바타 위에 1초간 표시만 한다(기록 없음).

`error:msg` `{ message }` — 개별 소켓에 오류 안내 (토스트).

`server:version` `{ version }` — 소켓 접속(재접속 포함) 직후 1회. 서버가 서빙 중인 자산 버전(public/ 내용 해시 8자리). 클라이언트는 `<meta name="asset-version">`의 값과 다르면 토스트 후 `location.reload()` 한다(배포 직후 자동 갱신). HTML은 `no-store`, css/js는 `?v=버전` 쿼리 + 1년 캐시로 서빙된다.

---

## Word mask 규칙
- 각 글자를 `_`로, 공백은 그대로, 글자 사이는 공백 1개로 구분한다. 예: `사과` → `_ _`, `ice cream` → `_ _ _   _ _ _ _ _`
  (단어 사이 공백은 3개로 표시해 단어 경계가 보이게 함).
- 힌트는 아직 공개되지 않은 글자 위치 중 무작위로 1개씩 고르고, 한글 음절은 **초성만** 공개한다 (예: `사과` → `ㅅ _`). 한글이 아닌 글자(영문·숫자)는 그 글자를 그대로 공개한다.
- 카테고리 힌트: 마지막(k번째) 초성 힌트 `game:hint`에 `category`(예: "동물", "탈것")가 함께 실린다. 사전에 없는 사용자 단어는 "방장이 낸 단어". hints=0 이면 카테고리 힌트도 없다.
- 후보 반복 방지: 한 게임 안에서 정답으로 쓰인 단어뿐 아니라 후보로 한 번 제시된 단어도 다시 후보로 내지 않는다(풀이 부족할 때만 재사용).
- 힌트 시점: 종료 `hintEndAt`초 전을 기준으로 역산한다. 실제 힌트 개수 k = min(`hints`, 단어의 공개 가능 글자 수). 마지막(k번째) 힌트는 항상 잔여 `hintEndAt`초에 뜨고, 그 앞 힌트들은 시작~마지막 힌트 사이에 균등 배치된다. 그래서 1글자 단어와 3글자 단어 모두 "힌트가 전부 공개되는 시점"이 같다. 예) hints=2, drawTime=80, hintEndAt=15 → 잔여 37초, 15초. 한글만으로 된 단어는 모든 글자의 초성까지 공개될 수 있고, 영문·숫자가 섞인 단어는 전체 글자 수 - 1 까지만 공개한다.

## 정답 판정
- 정규화: trim, 소문자화, 연속 공백 1개로. 한글은 그대로 비교(NFC).
- 완전 일치 → 정답. Levenshtein 거리 ≤ 1 (길이 ≥ 3인 경우) → `'close'` 를 보낸 사람에게만.
- 출제자 및 이미 맞힌 사람의 채팅은 판정하지 않는다.

## 점수
- 정답자: `Math.round(100 + 300 * timeLeft / drawTime)` (최소 100), 먼저 맞힐수록 높음. 
- 출제자: 턴 종료 시 `Math.round(300 * guessedCount / (playerCount - 1))` (모두 맞히면 300). 아무도 못 맞히면 0.
- `game:turnEnd.deltas` 에 위 값을 담는다.

## 게임 모드
- **classic (돌아가며 그리기)**: 아래 턴/라운드 흐름 그대로. 라운드마다 모든 플레이어가 한 번씩 출제.
- **blitz (속도전)**: 출제 순서는 classic 과 같지만 `choosing` 단계가 없다 — 서버가 단어 1개를 자동 선택해 곧바로 `game:drawing`. 힌트는 설정과 무관하게 없다. 정답 점수는 맞힌 순서로 1등 400 · 2등 300 · 3등 200 · 이후 100(시간 무관). 출제자 점수는 classic 과 동일. 클라이언트는 카드 선택 시 프리셋(drawTime 25, hints 0, rounds 5)을 함께 보낸다.
- **fixed (한 명이 그리기)**: `fixedDrawerId`(없으면 호스트)가 모든 턴을 출제. 라운드 순서는 `[fixedDrawerId]` 하나이므로 `rounds` = 그릴 단어 수. 출제자는 점수를 받지 않고 `game:over.ranking`에서 제외되며 `drawer`로 따로 전달된다. 출제자가 끊기면 유예 동안 기다리고(`turnEnd` 유지), 유예가 끝나 나가면 지정이 해제되어 호스트가 이어서 그린다. 중간 참가자는 바로 맞히기에 참여한다.

## 턴/라운드 흐름
1. `game:start` → phase `choosing`. 출제 순서는 참가 순서 (players 배열 순). 각 라운드마다 모든 플레이어가 1회씩 출제.
2. choosing: 15초. 시간 초과 시 첫 후보를 자동 선택. 단어 후보는 한국어 기본 사전 + customWords에서 중복 없이 선택. 한 게임 내 이미 나온 단어는 피한다(가능하면).
3. drawing: `drawTime`초. 모두 맞히면 즉시 종료(`allGuessed`). 출제자가 나가면 `drawerLeft`. 인원이 2명 미만이 되면 `notEnoughPlayers` 후 game over 처리(lobby 복귀).
4. turnEnd: 5초. 다음 출제자로. 마지막 라운드의 마지막 턴 후 `game:over` → 방은 바로 lobby(자동 복귀 10초 없음). 결과 화면은 각자 `results:done` 으로 닫는다.
5. 중간 참가자는 현재 턴에는 정답 맞히기 참여 가능, 출제는 다음 라운드부터(현재 라운드 출제 순서에 끼워 넣지 않는다).
6. 게임 종료 후 lobby로 돌아가도 점수는 다음 `game:start` 때까지 유지 표시, `game:start` 시 0으로 초기화.

## 상태 저장/복원
- 서버는 방 상태를 `STORE_URL`/`REDIS_URL` 저장소에 300ms 스로틀로 저장한다(`room:state` 브로드캐스트·드로잉 변경 시). 종료 신호(SIGTERM)에는 즉시 저장 후 내려간다.
- 재시작 후 방은 첫 `room:rejoin`/`room:join` 이 그 코드로 들어오는 순간 저장소에서 복원된다(부팅 시 일괄 복원 아님 — 새 서버가 먼저 떠 있는 동안 0명으로 진행되는 것을 막기 위해). 모든 플레이어는 `connected:false`(유예 중)로 시작하고 `room:rejoin`으로 같은 자리에 복귀한다. 저장 시점의 잔여 시간이 복원 시점부터 다시 흐른다(다운타임은 게임 시간에서 빼지 않음).
- 접속자가 2명 미만이지만 유예 중인 사람이 있어 전체 인원이 2명 이상이면, 턴을 넘길 때 게임을 끝내지 않고 2초 간격으로 재접속을 기다린다. 유예가 끝나 실제 퇴장으로 인원이 줄면 그때 게임 종료.
- 스냅샷은 3시간이 지나면 버린다. 방이 비면 저장소에서도 삭제한다.

## 방 관리
- roomCode: 대문자 A-Z 4글자, 충돌 없게 생성. 
- 호스트가 나가면 참가 순서상 다음 사람이 호스트. 마지막 사람이 나가면 방 삭제.
- 연결 끊김 = 유예 시간(`RECONNECT_GRACE_MS`, 기본 60초) 동안 자리·점수 유지(`connected:false`). 그 안에 `room:rejoin` 하면 복귀, 지나면 퇴장 처리. 끊긴 사람이 출제자였으면 턴은 즉시 `drawerLeft`로 끝나고, 호스트였으면 접속 중인 다음 사람이 호스트가 된다(복귀해도 돌려받지 않음). 끊긴 사람은 정답 대기 인원·다음 출제자 계산에서 제외된다. 명시적 `room:leave`/강퇴는 즉시 퇴장.
- URL `?room=CODE` 로 접속하면 클라이언트는 방 코드 입력란을 자동으로 채운다.

## 서버 검증 원칙
- 모든 C→S 이벤트는 phase/역할(호스트·출제자)을 검사하고, 위반 시 조용히 무시하거나 `error:msg`.
- 좌표는 0..800 / 0..600 로 clamp, size는 1..60 clamp, color는 `#rrggbb` 형식만 허용.
