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

## Identity
- 플레이어 id = `socket.id`.
- `avatar` = `{ emoji: string, color: string }` (color는 `#rrggbb`).
- 이름은 1~12자, trim 후 빈 문자열이면 서버가 거절.

## Phases
`'lobby' | 'choosing' | 'drawing' | 'turnEnd' | 'gameOver'`

## Settings (호스트만 변경, lobby 단계에서만)
```js
{
  rounds: 3,          // 1..10
  drawTime: 80,       // 초, 30..180
  wordCount: 3,       // 출제자에게 제시할 단어 후보 수, 2..5
  hints: 2,           // 턴당 자동 힌트(글자 공개) 횟수, 0..5
  customWords: '',    // 쉼표 구분 사용자 단어, 각 단어 1..20자
  customWordsOnly: false
}
```
서버는 범위를 벗어나면 clamp 한다.

---

## Client → Server

| event | payload | ack / 비고 |
|---|---|---|
| `room:create` | `{ name, avatar }` | ack `{ ok:true, roomCode, playerId }` 또는 `{ ok:false, error }` |
| `room:join` | `{ roomCode, name, avatar }` | ack 동일. 방 없음/게임 중 아님이면 join 허용(진행 중 참가 가능, 관전 후 다음 턴부터 참여). 최대 12명. roomCode는 대문자 정규화 |
| `room:leave` | – | 방 나가기 |
| `room:settings` | `{ settings }` | 호스트, lobby에서만. 성공 시 모두에게 `room:state` |
| `game:start` | – | 호스트, lobby, 플레이어 ≥ 2 |
| `word:choose` | `{ word }` | 출제자, choosing 단계, 제시된 후보 중 하나여야 함 |
| `draw:start` | `{ tool:'pen'\|'eraser', color:'#rrggbb', size:number, x, y }` | 출제자, drawing 단계 |
| `draw:move` | `{ pts: [[x,y], ...] }` | 배치(≈16~30ms 단위) |
| `draw:end` | – | |
| `draw:fill` | `{ x, y, color }` | 채우기 도구 |
| `draw:clear` | – | |
| `draw:undo` | – | 마지막 op 제거 |
| `chat:message` | `{ text }` | 1..100자. 정답 판정은 서버가 함 |
| `player:kick` | `{ playerId }` | 호스트 |

## Server → Client

### `room:state` — 방/플레이어 스냅샷. 변화가 있을 때마다 방 전체에 전송
```js
{
  roomCode, hostId, phase, round, totalRounds,
  drawerId,                 // 현재 출제자 (lobby면 null)
  settings,
  players: [{ id, name, avatar, score, isDrawing, hasGuessed }],  // 참가 순서
  nextDrawerId              // 다음 턴에 출제할 사람. lobby/gameOver거나 이번이 마지막 턴이면 null
}
```

### 게임 진행
| event | payload | 비고 |
|---|---|---|
| `game:choosing` | `{ drawerId, drawerName, timeLeft, wordOptions? }` | `wordOptions`(string[])는 **출제자에게만** 포함. 나머지는 없음(undefined) |
| `game:drawing` | `{ drawerId, round, totalRounds, timeLeft, wordMask, wordLength, word? }` | `word`는 출제자에게만. `wordMask` 형식은 아래 참고 |
| `game:hint` | `{ wordMask }` | 초성 공개 갱신 (출제자·이미 정답을 맞힌 사람 제외). 누군가 정답을 맞히면 그 사람에게만 별도로 `wordMask`가 실제 글자로 전체 공개된 `game:hint`가 온다(초성이 아님) |
| `game:timer` | `{ timeLeft }` | 매 1초 (choosing / drawing 단계) |
| `game:turnEnd` | `{ word, reason:'time'\|'allGuessed'\|'drawerLeft'\|'notEnoughPlayers', deltas:[{ id, delta }], timeLeft }` | 5초간 표시. `deltas`에는 이번 턴 획득 점수(0 포함 전원) |
| `game:over` | `{ ranking:[{ id, name, avatar, score }] }` | 점수 내림차순. 10초 후 서버가 lobby로 복귀시키고 `room:state` 전송 |

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

`error:msg` `{ message }` — 개별 소켓에 오류 안내 (토스트).

`server:version` `{ version }` — 소켓 접속(재접속 포함) 직후 1회. 서버가 서빙 중인 자산 버전(public/ 내용 해시 8자리). 클라이언트는 `<meta name="asset-version">`의 값과 다르면 토스트 후 `location.reload()` 한다(배포 직후 자동 갱신). HTML은 `no-store`, css/js는 `?v=버전` 쿼리 + 1년 캐시로 서빙된다.

---

## Word mask 규칙
- 각 글자를 `_`로, 공백은 그대로, 글자 사이는 공백 1개로 구분한다. 예: `사과` → `_ _`, `ice cream` → `_ _ _   _ _ _ _ _`
  (단어 사이 공백은 3개로 표시해 단어 경계가 보이게 함).
- 힌트는 아직 공개되지 않은 글자 위치 중 무작위로 1개씩 고르고, 한글 음절은 **초성만** 공개한다 (예: `사과` → `ㅅ _`). 한글이 아닌 글자(영문·숫자)는 그 글자를 그대로 공개한다.
- 힌트 시점: 총 `hints`회를 drawTime의 균등 분할 시점에 준다. 예) hints=2, drawTime=80 → 잔여 53초, 27초쯤. 한글만으로 된 단어는 모든 글자의 초성까지 공개될 수 있고, 영문·숫자가 섞인 단어는 전체 글자 수 - 1 까지만 공개한다.

## 정답 판정
- 정규화: trim, 소문자화, 연속 공백 1개로. 한글은 그대로 비교(NFC).
- 완전 일치 → 정답. Levenshtein 거리 ≤ 1 (길이 ≥ 3인 경우) → `'close'` 를 보낸 사람에게만.
- 출제자 및 이미 맞힌 사람의 채팅은 판정하지 않는다.

## 점수
- 정답자: `Math.round(100 + 300 * timeLeft / drawTime)` (최소 100), 먼저 맞힐수록 높음. 
- 출제자: 턴 종료 시 `Math.round(300 * guessedCount / (playerCount - 1))` (모두 맞히면 300). 아무도 못 맞히면 0.
- `game:turnEnd.deltas` 에 위 값을 담는다.

## 턴/라운드 흐름
1. `game:start` → phase `choosing`. 출제 순서는 참가 순서 (players 배열 순). 각 라운드마다 모든 플레이어가 1회씩 출제.
2. choosing: 15초. 시간 초과 시 첫 후보를 자동 선택. 단어 후보는 한국어 기본 사전 + customWords에서 중복 없이 선택. 한 게임 내 이미 나온 단어는 피한다(가능하면).
3. drawing: `drawTime`초. 모두 맞히면 즉시 종료(`allGuessed`). 출제자가 나가면 `drawerLeft`. 인원이 2명 미만이 되면 `notEnoughPlayers` 후 game over 처리(lobby 복귀).
4. turnEnd: 5초. 다음 출제자로. 마지막 라운드의 마지막 턴 후 `game:over`.
5. 중간 참가자는 현재 턴에는 정답 맞히기 참여 가능, 출제는 다음 라운드부터(현재 라운드 출제 순서에 끼워 넣지 않는다).
6. 게임 종료 후 lobby로 돌아가도 점수는 다음 `game:start` 때까지 유지 표시, `game:start` 시 0으로 초기화.

## 방 관리
- roomCode: 대문자 A-Z 4글자, 충돌 없게 생성. 
- 호스트가 나가면 참가 순서상 다음 사람이 호스트. 마지막 사람이 나가면 방 삭제.
- 연결 끊김 = 즉시 퇴장 처리(재접속 없음).
- URL `?room=CODE` 로 접속하면 클라이언트는 방 코드 입력란을 자동으로 채운다.

## 서버 검증 원칙
- 모든 C→S 이벤트는 phase/역할(호스트·출제자)을 검사하고, 위반 시 조용히 무시하거나 `error:msg`.
- 좌표는 0..800 / 0..600 로 clamp, size는 1..60 clamp, color는 `#rrggbb` 형식만 허용.
