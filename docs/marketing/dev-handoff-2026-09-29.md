# 개발 세션 전달 사항 — 2026-09-29 (D1)

작성: 마케팅 담당 에이전트 · 근거: [2026-10-growth-plan.md](2026-10-growth-plan.md) 3-3 · 6장

## 현재 상태 (확인한 사실)
- 리브랜딩 + OG 메타 + og-image.png(F1)는 `develop`에 커밋됨(dfdca0b). 스테이징에 배포돼 새 제목·og:image 절대 주소까지 확인.
- `main`에는 아직 없음 → 프로덕션은 옛 제목이 뜨고 OG 태그가 없다.
- 초대 링크(`/?room=CODE`)용 초대 문구 치환, manifest short_name "이뭔그"도 develop에 반영됨.
- F2(지표 로깅), F3(공유 버튼)는 아직 시작 안 함. 서버는 방 생성 시 닉네임을 로그에 남긴다(`server/index.js` 387줄).

## 오늘 요청 (우선순위 순)
1. **develop → main 머지(리브랜딩·OG 배포)**. 조건: 스테이징에서 방 만들기·참가·게임 1판·갤러리 저장이 정상인지 확인한 뒤. 배포 뒤 `/healthz`와 첫 화면 제목으로 검증.
   - 오늘·내일은 게시 일정이 없으니 배포 시각 제약 없음.
2. **F2 최소 지표 로깅** (크기: 작음) — 스펙은 성장 계획 6-2 그대로.
   - `[metric]` 한 줄 JSON 이벤트 7종(room_created / player_joined / game_started / game_completed / game_aborted / room_closed / room_full_rejected)
   - Key Value에 `stats:YYYY-MM-DD` 해시로 일별 누적, `/admin/stats?key=<비밀값>`로 최근 30일 조회(공개 `/healthz`에는 넣지 않음)
   - `?ref=` 유입 코드를 클라이언트가 sessionStorage에 두었다가 `room:create`/`room:join`에 선택 필드로 실어 보냄 → **PROTOCOL.md에 `ref` 선택 필드 추가**
   - `game_completed`에 `bytesOut`(게임 동안 서버 송신 바이트 합) 포함 — Render 5GB 대역폭 한도 판단용
   - 원칙: 닉네임·IP·채팅 내용은 남기지 않음. 387줄 `created by ${name}` 닉네임 로그 제거
   - 재방문 방장 해시 측정(6-2 6번)은 **하지 않음**(처리방침 수정 전)
3. **F3 공유 버튼** (크기: 작음)
   - 모바일: `navigator.share`로 초대 문구 + 링크 공유(카톡 선택 가능)
   - PC: 지금은 링크만 복사(`client.js` 2232줄) → 초대 문구 한 줄 + 링크를 같이 복사
   - 초대 문구는 성장 계획 5-1 #1 사용
4. **F5 갤러리 이미지에 브랜드·주소** (크기: 작음) — 운영자 결정(성장 계획 0-1)으로 앞당김
   - 운영자 명의 SNS 홍보를 하지 않기로 해서, 참가자가 저장해 올리는 갤러리 이미지가 사실상 유일한 시각 광고가 된다
   - 개별 PNG: 하단 구석에 작은 주소(draw-guess-i927.onrender.com). "한 장으로 모아 저장": 로고 워드마크 + 주소
   - 그림을 가리지 않게 여백에, 종이색 배경·연필색 글자로. 사용자가 끌 수 있는 옵션은 두지 않음

## 받고 나서 마케팅이 할 일
- 프로덕션 반영 확인 → 카카오 OG 캐시 초기화(developers.kakao.com/tool/clear/og) → **새 대화방**에서 메인 링크·초대 링크 미리보기 확인
- F2 배포 후 `/admin/stats` 값이 쌓이는지 확인하고 D14(10/12) 회고 표의 기준값으로 사용
