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
  그림 보관: `game:over.gallery` 중 **내가 그린 턴**(relay 는 `drawerIds` 에 내 id 가 있는 문제 — 공동 작품이라 주자 전원이 각자 보관, 그 밖의 모드는 `drawerId === 내 id`)이고 ops 가 있는 턴을 클라이언트가 800×600 webp 로 그려 저장한다(사용자당 100장).

### HTTP (로그인 켜짐일 때만)
- `POST /api/account/delete` — 헤더 `Authorization: Bearer <Supabase access token>`. 업로드한 프로필 사진(`avatars/<uid>/*`)을 지우고 Auth 사용자를 삭제(profiles·word_sets 는 cascade). 응답 `{ ok:true }` · 401 토큰 무효 · 500 실패. 방 안에 있던 그 계정 플레이어는 `loggedIn:false` 로.
- 서버는 하루 한 번 Supabase 에 가벼운 조회를 보내 무료 프로젝트 일시 정지(7일 무활동)를 막는다.

## Identity
- 플레이어 id = 최초 접속 시의 `socket.id`. 재접속(`room:rejoin`)해도 바뀌지 않는다(서버가 playerId→socketId를 매핑).
- `avatar` = `{ emoji: string, color: string, img?: string }` (color는 `#rrggbb`). `img`(프로필 사진 URL)는 **로그인 사용자만** 허용되며 서버가 https + 허용 호스트(우리 Supabase Storage `avatars` 버킷, `*.googleusercontent.com`, `*.kakaocdn.net`)만 통과시킨다. 클라이언트는 `img` 가 있으면 사진을, 로드 실패 시 emoji+color 로 대체해 그린다.
- 이름은 1~12자, trim 후 빈 문자열이면 서버가 거절. 욕설·비하어가 들어 있으면 `{ ok:false, error:'닉네임에 쓸 수 없는 말이 있어요.' }` (create · join · player:update 모두, 방 설정과 무관). 목록·규칙은 `server/profanity.js`.

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
  categories: [],     // 기본 단어 카테고리 이름 배열(server/words.js CATEGORIES 의 키, 예: ['동물','음식']). 빈 배열 = 전체. 모르는 이름은 버리고, 전부 고르면 [] 로 정규화. customWordsOnly 이고 사용자 단어가 wordCount개 이상이면 영향 없음(사용자 단어만 출제). 사용자 단어가 모자라면 이 카테고리 풀에서 채움
  mode: 'classic',    // 'classic' 돌아가며 그리기(기본) | 'fixed' 한 명이 계속 그리기(지정 출제자) | 'blitz' 속도전 | 'relay' 이어 그리기
  fixedDrawerId: null // fixed 모드 출제자 id. 방에 없는 id/null 이면 호스트가 출제자
}
```
서버는 범위를 벗어나면 clamp 한다.

**relay(이어 그리기)에서 달라지는 뜻**: `drawTime` = 한 명당 구간 시간(초) · `hints` = 맞히는 사람이 누를 수 있는 최대 힌트 횟수(자동 힌트 없음) · `rounds`·`hintEndAt` = 무시(`totalRounds` = 게임 시작 때 접속 인원 n) · `wordCount`·`categories`·`customWords`·`customWordsOnly` = 조합 제시어 후보에 그대로 적용(요소는 두 글자 이상 단어만).

---

## Client → Server

| event | payload | ack / 비고 |
|---|---|---|
| `room:create` | `{ name, avatar, token?, ref?, fromWordSetLink? }` | ack `{ ok:true, roomCode, playerId, token }` 또는 `{ ok:false, error }`. `token`(영숫자·`_-` 8~64자)은 재접속용이며 없으면 서버가 발급. `ref`(선택, 영숫자·`_-` 1~24자)는 유입 경로 코드 — 클라이언트가 `?ref=` 로 받아 sessionStorage 에 두었다가 보낸다. 지표에만 쓰고 방 상태에는 들어가지 않는다. `fromWordSetLink`(선택, 불린)는 이 탭에서 받은 공개 단어 세트 링크(`#ws=`)로 방을 만들면 `true` — 지표(`room_created`)에만 쓰고, `true` 가 아닌 값은 모두 `false` 로 본다. 단어·세트 이름은 보내지 않는다 |
| `room:rejoin` | `{ roomCode, token }` | 같은 `token`을 가진 플레이어가 방에 있으면(연결 상태 무관) 그 자리로 복귀: 같은 `playerId`·점수·순서 유지. 옛 소켓이 아직 살아 있으면 그쪽에 `session:replaced`를 보내고 떼어낸다(새로고침 경합·다른 탭). 유예 시간(기본 60초, `RECONNECT_GRACE_MS`)이 지나 퇴장된 뒤에는 실패. ack 형식은 create와 동일. 성공 시 `room:state`와 진행 상황(catch-up)이 개별 전송된다 |
| `react:send` | `{ kind:'up'\|'down' }` | drawing 중 비출제자. 기록되지 않고 방 전체에 `react:show`로 중계. 플레이어당 초당 8회 제한 |
| `room:join` | `{ roomCode, name, avatar, token?, ref?, via? }` | `via`(선택) `'link'`(초대 링크 `?room=` 로 들어옴) \| `'code'`(코드 직접 입력, 기본). `ref` 는 create 와 같음. 둘 다 지표용. 같은 `token`이 이미 그 방에 있으면 새 자리를 만들지 않고 그 자리로 복귀(이름·아바타는 새 값으로 갱신, ack의 `playerId`는 기존 id). ack 동일. 방 없음/게임 중 아님이면 join 허용(진행 중 참가 가능, 관전 후 다음 턴부터 참여). 최대 12명(가득 차면 `{ ok:false, error:'방이 가득 찼어요 (최대 12명). 자리가 나면 다시 참가하기를 눌러 주세요.' }`, 초대 링크로 온 클라이언트는 초대 카드 안에 이 안내를 남긴다). roomCode는 대문자 정규화 |
| `room:leave` | – | 방 나가기 |
| `room:settings` | `{ settings }` | 호스트, lobby에서만. 성공 시 모두에게 `room:state` |
| `results:done` | – | 게임 종료 결과 화면을 닫음(본인). `players[].atResults` 가 false 로 바뀜 |
| `lobby:step` | `{ step:'mode'\|'settings' }` | 호스트, lobby. 대기실 화면 단계 전환. 방을 만들면 `mode`, 게임이 끝나 돌아오면 `settings`(모드 유지) |
| `game:start` | – | 호스트, lobby, 접속 플레이어 ≥ 2. fixed 모드는 출제자가 접속 중이어야 함. relay 는 접속 3명 이상 6명 이하(`ALLOW_SOLO` 서버는 2명 이상 — 1명은 주자가 없어 불가). 벗어나면 `error:msg` `'이어 그리기는 3명부터 6명까지 할 수 있어요.'`(`ALLOW_SOLO` 면 "2명부터") |
| `game:end` | – | 호스트, 게임 중(choosing / drawing / turnEnd). 즉시 끝내고 모두 lobby 로 — 결과 화면·갤러리 없음(점수는 다음 `game:start` 까지 표시만). 방 전체에 `game:aborted` → `room:state` → 시스템 메시지 |
| `word:choose` | `{ word }` | 출제자, choosing 단계, 제시된 후보 중 하나여야 함 |
| `hint:request` | – | relay 전용. **맞히는 사람(`relay.guesserId`)만**, drawing 중, `hintsUsed < hintsMax` 일 때. 위반은 조용히 무시. 아직 맞히지 못한 요소들의 미공개 글자 중 무작위 1개의 초성을 공개한다(요소마다 기존 힌트 규칙: 한글만이면 모든 글자, 영문·숫자가 섞이면 글자 수−1까지). 공개할 글자가 하나도 없으면 `hintsUsed` 를 올리지 않고 무시. 응답은 `game:hint { wordMask, hintsUsed }` 를 **마스크를 보는 사람 전원**(맞히는 사람 + 아직 제시어를 못 받은 주자 + 관전자)에게 — 맞히는 사람의 `wordMask` 는 이미 맞힌 요소가 글자로 보이는 판. 힌트 1회마다 정답 점수 −25%(점수 절) |
| `draw:start` | `{ tool:'pen'\|'eraser', color:'#rrggbb', size:number, x, y }` | 출제자, drawing 단계 |
| `draw:move` | `{ pts: [[x,y], ...] }` | 배치(≈16~30ms 단위) |
| `draw:end` | – | |
| `draw:fill` | `{ x, y, color }` | 채우기 도구 |
| `draw:clear` | – | relay 는 자기 구간 op 만 지운다(아래 드로잉 절) |
| `draw:undo` | – | 마지막 op 제거. relay 는 자기 구간 op 가 있을 때만 |
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
  allowSolo,                // 서버가 ALLOW_SOLO=1(스테이징)로 떠 있으면 true: 최소 인원 1명. 프로덕션은 false(2명)
  relay                     // relay 가 아니거나 lobby/gameOver 면 null. 게임 중(choosing·drawing·turnEnd)이면 { order, guesserId, legIndex, legCount }
}
```
relay 에서: `round` = 문제 번호(1..n), `totalRounds` = n. `relay.order` = **이번 문제의 주자 순서**(맞히는 사람 제외, 구간 순서), `guesserId` = 이번 문제의 맞히는 사람, `legIndex` = 현재 구간(0부터), `legCount` = 구간 수. `drawerId` = 현재 구간 주자이고 `players[].isDrawing` 은 현재 주자만 true. `nextDrawerId` = 이번 문제의 다음 주자(choosing·drawing 중에만, 마지막 구간이거나 turnEnd 면 null).

### 게임 진행
| event | payload | 비고 |
|---|---|---|
| `game:choosing` | `{ drawerId, drawerName, timeLeft, wordOptions? }` | `wordOptions`(string[])는 **출제자에게만** 포함. 나머지는 없음(undefined). relay 는 첫 주자가 출제자이고 후보는 조합 표시 문자열(예 `"고양이 · 축구"`) |
| `game:drawing` | `{ drawerId, round, totalRounds, timeLeft, wordMask, wordLength, word?, category?, relay? }` | `word`·`category`는 출제자에게만(catch-up 시 이미 공개된 카테고리는 비출제자에게도). `wordMask` 형식은 아래 참고. **relay**: `relay: { order, guesserId, legIndex, legCount, legTime, legTimeLeft, totalTime, hintsUsed, hintsMax }` 가 붙고, `timeLeft` = 문제 전체 남은 시간(시작 때 `legTime × legCount`). `word`(조합 표시 문자열)는 **현재 주자에게만**(catch-up 은 현재·지난 주자에게), 나머지는 `wordMask`(요소별 마스크를 ` · ` 로 이은 것, 예 `_ _ _ · _ _`, 힌트로 공개된 초성 포함 — catch-up 의 맞히는 사람에게는 이미 맞힌 요소가 글자로 보이는 판). `relay.hintsUsed` 는 지금까지 쓴 힌트 수(catch-up 포함). `category` 는 없다. `wordLength` = 표시 문자열 `word` 의 글자 수 |
| `game:baton` | `{ legIndex, legCount, drawerId, drawerName, legTimeLeft, hintsUsed, word? }` | relay 전용. 구간이 넘어갈 때 방 전체. `word` 는 새 주자에게만. `hintsUsed` = 지금까지 쓴 힌트 수. 서버는 앞 주자의 열린 획을 닫아 `draw:end` 를 중계한 뒤 `drawerId` 를 바꾸고 `game:baton` → `room:state` 순서로 보낸다 |
| `game:hint` | `{ wordMask, category?, hintsUsed? }` | 초성 공개 갱신 (출제자·이미 정답을 맞힌 사람 제외). 누군가 정답을 맞히면 그 사람에게만 별도로 `wordMask`가 실제 글자로 전체 공개된 `game:hint`가 온다(초성이 아님). **relay**: 자동 힌트는 없고 `hint:request` 응답으로만 온다(`hintsUsed` 포함, `category` 없음). 맞히는 사람에게는 부분 정답 때(본인만, 맞힌 요소가 글자로)와 정답 때(본인만, 전체 공개 — 요소 마스크와 같은 ` · ` 형식, 예 `고 양 이 · 축 구`)에도 온다 |
| `game:timer` | `{ timeLeft, legTimeLeft? }` | 매 1초 (choosing / drawing 단계). relay drawing 중이면 `legTimeLeft`(현재 구간 남은 시간)도 |
| `game:turnEnd` | `{ word, reason:'time'\|'allGuessed'\|'drawerLeft'\|'guesserLeft'\|'notEnoughPlayers', deltas:[{ id, delta }], timeLeft }` | 5초간 표시. `deltas`에는 이번 턴 획득 점수(0 포함 전원). turnEnd 중에 들어오거나 재접속하면 catch-up 으로 다시 오고(`timeLeft` = 남은 표시 시간), `deltas` 에 없는 사람(중간 참가)만 `{ id, delta:0 }` 이 덧붙는다(재접속한 사람은 자기 줄이 그대로 한 번). relay 의 `reason` 은 `'time'`(아무도 못 맞힘) · `'allGuessed'`(맞히는 사람이 정답) · `'guesserLeft'`(맞히는 사람이 방을 완전히 나감, 점수 없음) · `'notEnoughPlayers'`. relay 에는 `'drawerLeft'` 가 없다 |
| `game:aborted` | `{ by }` | 방장(`by` = 이름)이 `game:end` 로 게임을 끝냄. 클라이언트는 턴/단어/오버레이를 지우고 대기실을 그린다(결과 화면 없음) |
| `game:over` | `{ ranking:[{ id, name, avatar, score }], mode, drawer?:{ id, name, avatar }, gallery:[{ round, word, category, drawerId, drawerIds, drawerNames, drawerName, guesserId, guesserName, guessed, ops, trimmed? }] }` | 점수 내림차순. 갤러리 항목의 `drawerIds` = 그 그림을 그린 주자 순서(relay 가 아니면 `[drawerId]`), `drawerNames` = 같은 순서의 이름(그 문제가 끝날 때 기록 — 게임 도중 나간 사람 이름도 남는다), `guesserId`·`guesserName` = relay 의 맞히는 사람(아니면 null), `drawerId`·`drawerName` = 첫 주자(하위 호환). 클라이언트 캡션: relay 는 주자 이름을 `·` 로 이은 "🖍 A·B·C" + "🎯 D", 그 밖의 모드는 기존 "✏️ 출제자". `guessed` = 그 그림을 맞힌 사람 수(relay 는 맞히는 사람이 맞혔으면 1, 아니면 0). relay 의 `word` 는 조합 표시 문자열이고 `category` 는 null. 이후 방은 **즉시** lobby 로 돌아가지만 모든 플레이어의 `atResults` 가 true 로 설정되어 각자 `results:done` 을 보낼 때까지 결과 화면을 유지한다. 접속 중인 누군가가 `atResults` 이면 `game:start` 는 거부된다. `gallery`는 이 게임에서 실제로 그린 턴들의 (제시어, 그림 ops) 기록 — 클라이언트가 갤러리로 렌더링하고 PNG로 저장. 전체가 약 1.5MB를 넘으면 오래된 턴의 `ops`를 비우고 `trimmed:true`. 10초 후 서버가 lobby로 복귀시키고 `room:state` 전송 |

### 드로잉 (출제자를 제외한 방 전체에 그대로 중계)
`draw:start`, `draw:move`, `draw:end`, `draw:fill`, `draw:clear`, `draw:undo` — 페이로드는 C→S와 동일.

`draw:sync` `{ ops }` — 중간 참가자 및 `game:drawing` 시작 시(빈 배열) 전송. relay 에서 주자가 `draw:clear` 를 보냈을 때도(아래). 클라이언트는 캔버스를 지우고 ops를 순서대로 재생.
```js
// op 형식
{ type:'stroke', tool:'pen'|'eraser', color, size, points:[[x,y],...] }
{ type:'fill',   x, y, color }
```
서버는 현재 턴의 `ops[]`를 유지한다: `draw:start`로 새 stroke op 생성, `draw:move`로 points 추가, `draw:end`로 확정.
`draw:fill`은 즉시 op 추가. `draw:undo`는 마지막 op pop. `draw:clear`는 ops 비움.
클라이언트도 동일한 ops 배열을 로컬에 유지해 `draw:undo` 수신 시 pop 후 전체 재그리기 한다.

**relay 의 드로잉**: **현재 구간 주자(`drawerId`)만** `draw:*` 를 보낼 수 있다(다른 주자의 것은 조용히 무시). 중계는 위와 같이 주자를 뺀 방 전체라 맞히는 사람·다른 주자도 실시간으로 본다. **구간 보호** — 서버는 구간이 시작될 때의 `ops` 길이를 기억하고 그 앞(앞 주자 그림)은 지우지 못하게 한다:
- `draw:undo`: 자기 구간에 그린 op 가 있을 때만 pop 하고 기존대로 중계. 없으면 무시(중계 없음).
- `draw:clear`: 자기 구간 op 만 지우고 `draw:clear` 는 중계하지 않는다. 대신 서버가 **방 전체(주자 포함)**에 남은 ops 로 `draw:sync { ops }` 를 보낸다.

### 채팅
`chat:message` `{ id?, name?, avatar?, text, kind }`
- `kind`: `'chat'` (일반) | `'system'` (입장/퇴장/턴 안내) | `'correct'` ("○○님이 정답을 맞혔습니다!") | `'close'` (정답에 근접, **보낸 사람에게만**) | `'guessed-chat'` (정답자 전용 채팅)
- 정답을 맞힌 사람과 출제자가 drawing 중에 보내는 메시지는 `'guessed-chat'`으로 **출제자 + 이미 맞힌 사람들에게만** 전달.
- relay 의 choosing·drawing 중: **이번 문제의 주자(`relay.order` 에 든 사람 전원)** 의 메시지는 `'guessed-chat'` 으로 주자들에게만. 관전자(중간 참가자 등 order 에도 guesser 에도 없는 사람)의 메시지는 판정 없이 방 전체에 `'chat'`. 맞히는 사람의 메시지는 choosing 중엔 판정 없이 방 전체 `'chat'`, **drawing 중엔 요소 판정**(아래 "정답 판정" 절 relay):
  - 누적으로 **모든 요소**를 맞힘 → 정답. 전원에게 `'correct'`, `player:guessed`, 본인에게 전체 공개 `game:hint` → 즉시 `game:turnEnd { reason:'allGuessed' }`. 보낸 문장은 브로드캐스트하지 않는다.
  - **새로 맞힌 요소가 있지만 전부는 아님** → 보낸 사람에게만 `{ ...메시지, kind:'close', partial:{ solved, total } }`(`solved` = 지금까지 맞힌 요소 수, `total` = 요소 수. 클라이언트 문구 "3개 중 1개 맞았어요!") + 본인에게만 `game:hint { wordMask, hintsUsed }`(맞힌 요소는 글자로, 나머지는 초성 힌트 포함 마스크). 나머지 전원에게는 같은 `text` 의 `'chat'`.
  - 새로 맞힌 요소는 없고 못 맞힌 요소 중 하나가 근접 → 보낸 사람에게 `'close'`(`partial` 없음), 나머지에게 `'chat'`.
  - 그 밖 → 방 전체 `'chat'`.
- 정답 텍스트 자체는 절대 브로드캐스트하지 않는다.
- `'chat'`·`'close'`·`'guessed-chat'` 의 `text` 는 원문이고, 욕설이 들어 있으면 `textSafe`(욕설 부분을 `*` 로 바꾼 판)를 같이 보낸다(보낸 사람에게도). 클라이언트는 각자의 "욕설 가리기" 설정(기기별, 기본 켜짐)에 따라 둘 중 하나를 보여 주고, 설정을 바꾸면 이미 그려진 메시지도 바꿔 끼운다. 정답·근접 판정은 원문으로. 문장부호·숫자·이모지로 끊어 쓴 것("시.발")은 잡지만 띄어쓴 것("시 발")은 잡지 않는다.
- 방송 모드도 기기별 설정이다(서버 무관): 방 코드(••••, 누르면 4초)·주소의 `?room=` 을 가리고, 출제자 후보/단어는 별도 팝업 "단어 창"(`/word`, BroadcastChannel)에서만 보여 준다(팝업이 없거나 폰이면 흐림 + 눌러서 보기).

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
- **relay**: 맞히는 사람의 채팅을 요소별로 판정한다(`server/words.js` `matchParts`). 정규화한 채팅에 요소가 부분 문자열로 들어 있으면 그 요소를 맞힌 것(순서·조사 무관, 공백을 뺀 판끼리도 비교 — 예 "바다에서 고양이가 축구해" 는 `고양이 · 축구 · 바다` 정답). 맞힌 요소는 문제 안에서 **누적**되어 여러 번에 나눠 맞혀도 된다. 못 맞힌 요소 중 3글자 이상이고 채팅 전체나 공백으로 나눈 토큰 하나와 Levenshtein ≤ 1 이면 근접.

## 점수
- 정답자: `Math.round(100 + 300 * timeLeft / drawTime)` (최소 100), 먼저 맞힐수록 높음. 
- 출제자: 턴 종료 시 `Math.round(300 * guessedCount / (playerCount - 1))` (모두 맞히면 300). 아무도 못 맞히면 0.
- `game:turnEnd.deltas` 에 위 값을 담는다.
- **relay**: 맞히는 사람 `max(50, round((100 + 300 × timeLeft / totalTime) × (1 − 0.25 × hintsUsed)))`(`timeLeft` = 문제 전체 남은 시간, `totalTime` = `relay.totalTime`). 주자는 정답 시점까지 **구간을 가진 주자**(`order[0..legIndex]`, 현재 주자 포함) 각 200, 아직 안 그린 주자 0. 못 맞히면(`time`·`guesserLeft`) 전원 0. 출제자 공식은 쓰지 않는다.

## 게임 모드
- **classic (돌아가며 그리기)**: 아래 턴/라운드 흐름 그대로. 라운드마다 모든 플레이어가 한 번씩 출제.
- **blitz (속도전)**: 출제 순서는 classic 과 같지만 `choosing` 단계가 없다 — 서버가 단어 1개를 자동 선택해 곧바로 `game:drawing`. 힌트는 설정과 무관하게 없다. 정답 점수는 맞힌 순서로 1등 400 · 2등 300 · 3등 200 · 이후 100(시간 무관). 출제자 점수는 classic 과 동일. 클라이언트는 카드 선택 시 프리셋(drawTime 25, hints 0, rounds 5)을 함께 보낸다.
- **relay (이어 그리기)**: 게임 시작 때 접속한 사람들의 참가 순서가 고정된다(n명, 3~6명 · `ALLOW_SOLO` 서버는 2명부터). 문제는 n개(`totalRounds` = n)이고 `rounds` 는 쓰지 않는다. 문제 i(0부터)는 시작 순서를 i칸 회전한 뒤 앞 n−1명이 주자(구간 순서), 마지막 한 명이 맞히는 사람이다(예 A,B,C → A→B/C, B→C/A, C→A/B). 첫 주자만 조합 제시어를 고른다(choosing 15초, 시간 초과면 첫 후보). 요소 수 = `max(2, min(주자 수, 3))`(3명 방 2개, 4명 이상 3개, `ALLOW_SOLO` 2명 방도 2개). 구간 시간 = `drawTime`, 문제 전체 시간 = `drawTime × 구간 수`. 구간 경계는 고정이고 타이머는 끊기지 않는다(구간이 끝나면 `game:baton` 으로 다음 주자). 자동 힌트는 없고 맞히는 사람이 `hint:request` 로 최대 `hints` 번 초성을 연다. 맞히는 사람은 첫 구간부터 마지막 구간이 끝날 때까지 언제든 채팅으로 맞히고, 정답이면 남은 구간은 건너뛰고 문제가 끝난다. 주자가 끊겨도 문제는 끝나지 않는다(`DRAWER_GRACE_MS`·`drawerLeft` 없음) — 끊김·퇴장 규칙은 아래 "relay 끊김·이탈". 중간 참가자는 관전(판정 없음)하고 다음 게임부터 참여.
- **relay 끊김·이탈** (끊김 = 유예 `RECONNECT_GRACE_MS` 중, `connected:false`. 퇴장 = `room:leave`·강퇴·유예 만료)
  - **현재 주자가 끊김**: 구간 타이머는 계속 흐른다. 그리던 획은 서버가 닫아 `draw:end` 를 중계하고, 시스템 메시지 `○○님의 연결이 끊어졌습니다. 구간이 끝나기 전에 돌아오면 이어서 그려요.` 구간 안에 `room:rejoin` 하면 catch-up(`game:drawing` 의 `word`·`relay.legTimeLeft`(그 구간 남은 시간) + `draw:sync`)을 받고 `drawerId` 가 그대로 자기라 남은 시간만큼 이어 그린다(새 획부터). 돌아오지 않으면 경계에서 다음 주자로 `game:baton`.
  - **끊긴 채로 자기 구간이 시작됨**: 건너뛰지 않는다 — `game:baton` 은 그대로 그 사람으로 가고, 시스템 메시지 `○○님 연결을 기다리는 중… 구간이 끝나면 다음 사람이 그려요.`(평소의 `○○님이 이어서 그립니다.` 대신). 그 구간 안에 돌아오면 남은 시간만큼 그리고, 아니면 구간은 비워 둔 채 경계에서 다음 주자로(마지막 구간이면 `time`).
  - **구간이 끝난 뒤 돌아온 주자**(지난 주자): catch-up 에 `word` 는 오지만 `drawerId` 가 아니라 `draw:*` 는 무시된다. **차례 전 주자**가 돌아오면 `word` 없이 `wordMask`(힌트 반영)만 받고, 자기 구간이 오면 평소처럼 `game:baton`(`word` 포함).
  - **맞히는 사람이 끊김**: 문제는 계속된다. 돌아오면 catch-up `game:drawing` 에 맞힌 요소가 글자로 보이는 `wordMask`·`relay.hintsUsed`, `draw:sync`. 이미 맞힌 요소는 그대로 누적되어 나머지만 맞히면 정답(점수의 힌트 감점도 이어진다).
  - **퇴장**: 현재 주자면 그 자리에서 다음 구간으로(남은 구간 시간만큼 문제 시간이 줄고, 다음 구간이 없으면 `time`), 차례 전 주자면 order 에서 빠진다(문제 시간이 한 구간만큼 준다), 맞히는 사람이면 그 문제는 점수 없이 곧바로 `guesserLeft`(유예 만료로 나가도 같다). choosing 중 첫 주자가 나가면 다음 주자가 새 후보로 고른다.
  - **다음 문제를 시작할 때**: 나간 사람은 주자에서 빠진다(끊겨서 유예 중인 주자는 남는다 — 위 "끊긴 채로 자기 구간"). 맞히는 사람이 나간 문제는 시스템 메시지 `문제 i/n: ○○님이 나가서 이 문제는 건너뛰어요.`, 주자가 모두 나간 문제는 `문제 i/n: 그릴 사람이 모두 나가서 이 문제는 건너뛰어요.` 를 남기고 건너뛴다. 건너뛴 문제도 번호를 쓰므로 다음 문제의 `round` 는 그만큼 올라간다(`문제 i/n` 이 맞다). 마지막 문제까지 건너뛰면 `game:over`.
  - **인원 부족**: 문제 중에는 **퇴장으로 전체 인원(유예 중 포함)이 최소 인원(3, `ALLOW_SOLO` 2) 미만**이 되면 그 문제를 `notEnoughPlayers` 로 끝내고 게임 종료. 끊김만으로 접속 인원이 모자란 것은 문제를 계속한다. 다음 문제로 넘어갈 때 접속 인원이 최소 미만이면: 유예 중 포함 인원이 최소 이상이면 2초 간격으로 재접속을 기다리고(`다른 참가자의 재접속을 기다리고 있어요…`), 아니면 `notEnoughPlayers` 로 게임 종료.
- **fixed (한 명이 그리기)**: `fixedDrawerId`(없으면 호스트)가 모든 턴을 출제. 라운드 순서는 `[fixedDrawerId]` 하나이므로 `rounds` = 그릴 단어 수. 출제자는 점수를 받지 않고 `game:over.ranking`에서 제외되며 `drawer`로 따로 전달된다. 출제자가 끊기면 유예 동안 기다리고(`turnEnd` 유지), 유예가 끝나 나가면 지정이 해제되어 호스트가 이어서 그린다. 중간 참가자는 바로 맞히기에 참여한다.

## 턴/라운드 흐름
1. `game:start` → phase `choosing`. 출제 순서는 참가 순서 (players 배열 순). 각 라운드마다 모든 플레이어가 1회씩 출제.
2. choosing: 15초. 시간 초과 시 첫 후보를 자동 선택. 단어 후보는 한국어 기본 사전 + customWords에서 중복 없이 선택. 한 게임 내 이미 나온 단어는 피한다(가능하면).
3. drawing: `drawTime`초. 모두 맞히면 즉시 종료(`allGuessed`). 출제자가 나가면(끊김은 `DRAWER_GRACE_MS` 유예 뒤) `drawerLeft`. 인원이 2명 미만이 되면 `notEnoughPlayers` 후 game over 처리(lobby 복귀).
4. turnEnd: 5초. 다음 출제자로. 마지막 라운드의 마지막 턴 후 `game:over` → 방은 바로 lobby(자동 복귀 10초 없음). 결과 화면은 각자 `results:done` 으로 닫는다.
5. 중간 참가자는 현재 턴에는 정답 맞히기 참여 가능, 출제는 다음 라운드부터(현재 라운드 출제 순서에 끼워 넣지 않는다).
6. 게임 종료 후 lobby로 돌아가도 점수는 다음 `game:start` 때까지 유지 표시, `game:start` 시 0으로 초기화.

## 상태 저장/복원
- 서버는 방 상태를 `STORE_URL`/`REDIS_URL` 저장소에 300ms 스로틀로 저장한다(`room:state` 브로드캐스트·드로잉 변경 시). 종료 신호(SIGTERM)에는 즉시 저장 후 내려간다.
- 재시작 후 방은 첫 `room:rejoin`/`room:join` 이 그 코드로 들어오는 순간 저장소에서 복원된다(부팅 시 일괄 복원 아님 — 새 서버가 먼저 떠 있는 동안 0명으로 진행되는 것을 막기 위해). 모든 플레이어는 `connected:false`(유예 중)로 시작하고 `room:rejoin`으로 같은 자리에 복귀한다. 저장 시점의 잔여 시간이 복원 시점부터 다시 흐른다(다운타임은 게임 시간에서 빼지 않음).
- 접속자가 2명 미만이지만 유예 중인 사람이 있어 전체 인원이 2명 이상이면, 턴을 넘길 때 게임을 끝내지 않고 2초 간격으로 재접속을 기다린다. 유예가 끝나 실제 퇴장으로 인원이 줄면 그때 게임 종료. relay 는 기준이 3명(`ALLOW_SOLO` 2).
- 스냅샷은 3시간이 지나면 버린다. 방이 비면 저장소에서도 삭제한다.
- relay 는 스냅샷에 `relay`(order · guesserId · legIndex · legCount · legTime · legTimeLeft · totalTime · legStartOps · hintsUsed · hintsMax · `revealedByPart`(요소별 힌트 공개 글자 인덱스 배열의 배열) · `solvedIdx`(맞히는 사람이 맞힌 요소 인덱스 배열))와 `parts`(판정용 요소 배열)·조합 후보(`comboOptions`, [표시 문자열, 요소 배열] 쌍)·`turnOrder`(게임 시작 때의 참가 순서 — 문제 배정의 기준)·`relayLeft`(게임 중 나간 참가자 id → 이름, 건너뛰는 문제 안내용)를 함께 넣는다. 복원 때 문제 전체 남은 시간은 위 규칙대로 `phaseEndsAt` 기준으로 이어지고, 현재 구간 남은 시간은 거기서 다시 계산한다(`legTimeLeft = timeLeft − legTime × (legCount − 1 − legIndex)`, 0~`legTime`). 저장 시점이 구간 경계라 현재 구간이 0초면 복원하자마자 다음 주자로 `game:baton`. choosing 중 복원이면 첫 주자가 돌아올 때 같은 후보를 다시 받고, 시간이 다 됐으면 첫 후보로 drawing 을 시작한다. 복원 직후에는 전원이 끊긴 상태라 위 "relay 끊김·이탈" 규칙이 그대로 적용된다(돌아오는 대로 catch-up).

## 방 관리
- roomCode: 대문자 A-Z 4글자, 충돌 없게 생성. 
- 호스트가 나가면 참가 순서상 다음 사람이 호스트. 마지막 사람이 나가면 방 삭제.
- 연결 끊김 = 유예 시간(`RECONNECT_GRACE_MS`, 기본 60초) 동안 자리·점수 유지(`connected:false`). 그 안에 `room:rejoin` 하면 복귀, 지나면 퇴장 처리. 끊긴 사람이 choosing/drawing 중인 출제자였으면 `DRAWER_GRACE_MS`(기본 15초, `RECONNECT_GRACE_MS` 이하, 0이면 즉시) 동안 턴을 끝내지 않고 기다린다 — 턴 타이머·힌트는 계속 흐르고, 그리던 획은 서버가 닫아 관전자에게 `draw:end` 를 보낸다. 그 안에 돌아오면 catch-up(`game:choosing` 후보 또는 `game:drawing` 단어 + `draw:sync`)으로 이어서 하고, 안 돌아오면 시스템 메시지 후 `drawerLeft`로 끝난다. 관전자 화면은 `room:state` 의 출제자 `connected:false` 로 "연결을 기다리고 있어요"를 표시한다. 호스트였으면 `HOST_RETURN_MS`(기본 10초) 안에 돌아오지 않을 때 접속 중인 다음 사람이 호스트가 된다(넘어간 뒤에는 복귀해도 돌려받지 않음). 끊긴 사람은 정답 대기 인원·다음 출제자 계산에서 제외된다. 명시적 `room:leave`/강퇴는 즉시 퇴장. **relay 에는 `DRAWER_GRACE_MS`·`drawerLeft` 가 없다** — 주자가 끊겨도 구간 타이머만 흐르고 경계에서 넘어가며, 맞히는 사람은 유예가 끝나 퇴장될 때 `guesserLeft`(게임 모드 절 "relay 끊김·이탈").
- 호스트가 오프라인인데 접속 중인 사람이 있으면(끊김 · 새로고침 · 서버 재시작 복원 직후) `HOST_RETURN_MS`(기본 10초) 기다렸다가 접속 중인 첫 사람에게 호스트를 넘기고 시스템 메시지("방장이 돌아오지 않아 …")를 보낸다. 그 안에 돌아오면 그대로. `hostId` 가 목록에 없는 사람을 가리키면 즉시 바로잡는다.
- URL `?room=CODE` 로 접속하면 클라이언트는 방 코드 입력란을 자동으로 채운다.
- URL `?ref=코드` 는 유입 경로(홍보 채널) 표시. 클라이언트가 sessionStorage 에 기억하고 주소에서 지운 뒤 `room:create`/`room:join` 에 `ref` 로 실어 보낸다.
- URL `#ws=<base64url>` 은 공개 단어 세트 링크("이 단어 세트로 방 만들기", 클라이언트 전용 — 해시라 서버는 보지 않는다). 내용은 UTF-8 JSON `{ v:1, n?:세트 이름(1~30자), w:[단어…], o:0|1 }`(`o` = 우리 단어만 쓰기). 클라이언트는 읽자마자 sessionStorage 에 두고 주소에서 지운다. 단어는 `customWords` 규칙(각 1~20자, 중복 제거, 쉼표로 이은 원문 2000자 이하)으로 다시 거르고, 남는 단어가 없으면 버린다. 그 탭에서 방을 만들 때 `room:create` 에 `fromWordSetLink: true` 를 싣고(지표용), 성공하면 호스트 클라이언트가 곧바로 `room:settings { settings:{ customWords, customWordsOnly } }` 를 보낸다(새 이벤트 없음). 링크 만들기는 방장 설정의 우리만의 단어 · 방장이 아닌 사람의 설정 요약(우리만의 단어 목록이 보일 때만, 세트 이름 없이) · 내 정보의 단어 세트에서 한다.

## 이용 지표 (서버 전용, 닉네임·IP·채팅 내용 없음)
- 서버는 stdout 에 `[metric] {"ev","ts",...}` 한 줄씩 남기고 일별 누적을 저장소에 쌓는다(Redis 해시 `draw-guess:stats:YYYY-MM-DD`, 한국 시간 기준, 40일 보관). 필드 목록은 `server/metrics.js` 머리 주석.
- 이벤트: `room_created`(ref, loggedIn, fromWordSetLink — 일별 `rooms_from_wsl`) · `player_joined`(via link|code, midGame, size) · `game_started` · `game_completed`(turns, durationSec, bytesOut) · `game_aborted`(reason host|notEnoughPlayers) · `room_closed`(gamesPlayed, peakPlayers, lifetimeSec) · `room_full_rejected`.
- `bytesOut` 은 그 방에 보낸 socket.io 패킷 길이 × 받는 사람 수의 합(근사). 게임 시작 때 0 으로, 게임이 끝나면 기록하고 다시 0 으로.
- `GET /admin/stats?key=<ADMIN_KEY>&days=30` → `{ ok, today, rooms, store, days:[{ day, ...counters }] }`(최신순, 기록 있는 날만). `ADMIN_KEY` 가 없으면 404, 틀리면 403. 공개 `/healthz` 에는 통계를 넣지 않는다.

## 서버 검증 원칙
- 모든 C→S 이벤트는 phase/역할(호스트·출제자)을 검사하고, 위반 시 조용히 무시하거나 `error:msg`.
- 좌표는 0..800 / 0..600 로 clamp, size는 1..60 clamp, color는 `#rrggbb` 형식만 허용.
