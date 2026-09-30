# 이뭔그 (draw-guess) — Claude Code 작업 규칙

한국어 실시간 그림 맞히기 웹게임. Node 24 + express + socket.io, 클라이언트는 순수 HTML/CSS/JS. 프로덕션 https://draw-guess-i927.onrender.com · 스테이징 https://draw-guess-staging.onrender.com

## 항상 지킬 것
- **답변은 한국어로.** 긴 세션·요약 뒤에도 마찬가지.
- **날짜는 시계로 확인한다.** 세션은 하루가 지나도 모르니 날짜가 걸린 일(일정, D-day, 로드맵)은 먼저 `date`를 실행해 오늘을 구한다. 문서에는 "내일"·"다음 주" 대신 절대 날짜와 요일을 쓴다.
- 클라이언트·서버 계약은 `PROTOCOL.md`가 권위 문서다. 이벤트·필드를 바꾸면 먼저 문서를 고친다.
- 변경 뒤 `npm test`와 `npm run test:browser`를 둘 다 통과시킨다(모바일 화면을 건드리면 `npm run test:mobile`도).
- 배포 검증은 `node test/asset-version.js <ref>` 값과 `/healthz`의 `version`을 비교한다(Windows CRLF 때문에 워킹 카피 해시는 서버 값과 다르다).

## 브랜치와 배포
- `develop` = 스테이징(혼자서도 게임 시작 가능), `main` = 프로덕션 자동 배포.
- **main 머지는 운영자 GO 뒤에만.** 게시·방송(BOARD "예정 일정") 1시간 전부터는 머지하지 않는다.
- 다른 세션이 워킹 트리를 쓰고 있을 수 있다. 남의 커밋 안 된 변경은 건드리지 않는다. 동시에 작업해야 하면 `git worktree`로 분리한다.

## 운영 구조 (운영자는 GO / STOP / 보류와 방향 조정만 한다)
- 조율: `docs/ops/BOARD.md` (결정 필요 · 방향 메모 · 예정 일정 · 역할 상태 · 사이클 로그). 실행은 `/ops-cycle`.
- 개발 목록: `docs/BACKLOG.md`(승인된 것만 "다음" 표) · 결함: `docs/ops/TEST-LOG.md` · 큰 그림: `docs/ROADMAP.md`
- 역할(`.claude/agents/`): marketing-strategist · product-planner · builder · qa-reviewer · fixer. 이 세션이 draw-guess 폴더에서 열려야 역할 이름이 잡힌다.
- **GO 없이 하지 않는 것**: main 머지, 외부 게시·DM·메일, 돈 쓰는 결정, 신규 기능·모드(설계 문서 승인 전), 개인정보 처리방침 변경, 데이터 삭제.

## 마케팅 원칙
- 운영자 명의 인스타·틱톡·쇼츠 계정 홍보는 하지 않는다. 확산은 참가자·스트리머가 스스로 올리게 만든다(`docs/marketing/2026-10-growth-plan.md` 0-1).
- 신분을 숨긴 바이럴·지인 댓글 부탁·다중 계정·가짜 후기는 하지 않는다.
- 지표(`/admin/stats`)에는 닉네임·IP·채팅 내용을 남기지 않는다.

## 비밀 값
`secret/`(Google OAuth JSON, `admin-key.txt`)는 gitignore 대상이다. 커밋하지 않고, 서브에이전트에는 조회 결과만 넘기며 키는 넘기지 않는다.
