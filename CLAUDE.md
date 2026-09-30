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
- 세션이 여럿 열릴 수 있다. **아래 "동시 작업 규칙"을 따른다.**

## 동시 작업 규칙 (세션이 겹쳐도 충돌하지 않게)
- **메인 체크아웃(`draw-guess` 폴더)은 사이클 전용이다.** 코드 수정·테스트·서버 실행은 여기서 `/ops-cycle`만 한다(builder·fixer·qa는 한 번에 하나씩 순서대로).
- **큰 작업(신규 모드·큰 기능)은 개발 세션(`/dev-session <기능>`)이 전용 워크트리 `draw-guess-work/feature-<이름>`과 브랜치 `feature/<이름>`에서 맡는다.** 이 워크트리에서는 코드 수정과 로컬 테스트(`npm ci`로 node_modules 설치)가 허용된다. 큰 작업은 **동시에 하나만** 진행하고, 완성되면 develop에 머지해 스테이징으로 넘긴다(main 머지는 GO 뒤). 일상 사이클과 병행한다.
- **그 밖의 세션(기획 세션·관리자 세션·수동 작업)은 메인 체크아웃을 쓰지 않고 자기 워크트리에서 문서만 고친다.**
  ```
  git fetch origin
  git worktree add "E:/claude pj/개인/draw-guess-work/<역할>" -b work/<역할>-<YYYYMMDD> origin/develop
  # 그 폴더에서 작업 → 필요한 경로만 git add → 커밋
  git fetch origin && git rebase origin/develop && git push origin HEAD:develop
  # 끝나면 메인 체크아웃에서: git worktree remove "<폴더>" && git branch -d work/<역할>-<YYYYMMDD>
  ```
  워크트리에는 node_modules가 없으므로 테스트·서버 실행은 하지 않는다. 코드를 건드려야 하면 BACKLOG에 올려 사이클에 맡긴다.
- **커밋은 자기 파일만 명시해서 `git add <경로>`.** `git add -A`는 남의 미커밋 변경이 섞일 수 있어 쓰지 않는다. push 직전에는 트리를 깨끗하게 한 뒤 `git pull --rebase origin develop`(또는 워크트리에서는 위의 rebase)를 한다. 충돌하면 강제로 밀지 말고 양쪽 변경을 살려 풀고, 못 풀면 멈추고 운영자에게 알린다.
- **파일 주인** (겹치는 파일이 없으면 충돌도 없다)

  | 파일 | 쓰는 쪽 |
  |---|---|
  | `server/` `public/` `test/` `PROTOCOL.md` `README.md` | 사이클의 builder·fixer(develop, 작은 항목) · 개발 세션의 builder·fixer(feature 브랜치, 큰 기능). 서로 다른 항목을 맡고 같은 파일은 rebase로 합친다 |
  | `docs/ops/BOARD.md` | 사이클 조율자. 다른 세션은 "방향 메모"에 한 줄 추가만 |
  | `docs/ops/TEST-LOG.md` | qa(추가) · fixer(상태). feature 브랜치 기간에는 쓰지 않는다(설계 문서 "진행 중 결함" 표를 쓴다) |
  | `docs/BACKLOG.md` | 제안됨: 사이클·제품 / 다음: 제품(승인분 추가)·builder(완료로 이동) / 완료: builder |
  | `docs/GAME-MODES.md` `docs/PRD-PLATFORM.md` `docs/product/` `docs/ROADMAP.md` 제품 줄 | product-planner·기획 세션. **예외: 설계 문서의 ✅ 완료 표시와 "진행 중 결함" 표, ROADMAP 진행률 한 줄(`진행 (feature/…, n/m)`)은 dev-session이 쓴다** |
  | `docs/marketing/` | marketing-strategist |
  | `docs/ROADMAP.md` 마케팅·개발 줄 | 사이클 조율자 |
  | `.claude/` `CLAUDE.md` | 관리자 세션 |

## 운영 구조 (운영자는 GO / STOP / 보류와 방향 조정만 한다)
- 조율: `docs/ops/BOARD.md` (결정 필요 · 방향 메모 · 예정 일정 · 역할 상태 · 사이클 로그). 실행은 `/ops-cycle`.
- 개발 목록: `docs/BACKLOG.md`(승인된 것만 "다음" 표) · 결함: `docs/ops/TEST-LOG.md` · 큰 그림: `docs/ROADMAP.md`
- 역할(`.claude/agents/`): marketing-strategist · product-planner · builder · qa-reviewer · fixer. 이 세션이 draw-guess 폴더에서 열려야 역할 이름이 잡힌다.
- **개발 세션**: 기획 세션에서 설계가 승인된 큰 기능은 `/dev-session <기능>`. 사이클의 builder는 크기 작음·중간 항목만 고른다.
- **기획 세션**: 새 모드·기능 아이디어를 운영자와 대화로 뽑을 때는 `/product-session`. 제품 문서(`docs/GAME-MODES.md`, `docs/PRD-PLATFORM.md`, `docs/product/`, 로드맵 제품 줄)의 주인은 product-planner다. 대화에서 나온 아이디어는 세션이 끝나기 전에 문서에 남긴다.
- **GO 없이 하지 않는 것**: main 머지, 외부 게시·DM·메일, 돈 쓰는 결정, 신규 기능·모드(설계 문서 승인 전), 개인정보 처리방침 변경, 데이터 삭제.

## 마케팅 원칙
- 운영자 명의 인스타·틱톡·쇼츠 계정 홍보는 하지 않는다. 확산은 참가자·스트리머가 스스로 올리게 만든다(`docs/marketing/2026-10-growth-plan.md` 0-1).
- 신분을 숨긴 바이럴·지인 댓글 부탁·다중 계정·가짜 후기는 하지 않는다.
- 지표(`/admin/stats`)에는 닉네임·IP·채팅 내용을 남기지 않는다.

## 비밀 값
`secret/`(Google OAuth JSON, `admin-key.txt`)는 gitignore 대상이다. 커밋하지 않고, 서브에이전트에는 조회 결과만 넘기며 키는 넘기지 않는다.
