---
name: dev-session
description: 이뭔그(draw-guess) 큰 작업 개발 세션. 기획 세션에서 설계가 승인된 큰 기능·신규 모드 하나를 전용 워크트리와 feature 브랜치에서 며칠에 걸쳐 만든다. 설계 문서가 쪼갠 항목을 순서대로 builder·qa-reviewer·fixer 서브에이전트로 소화하고 진행률을 갱신하며, 완성되면 develop에 머지한다. 일상 사이클(/ops-cycle)과 병행해도 된다. 사용자가 "/dev-session <기능 이름>", "큰 작업 이어서 개발해줘"라고 할 때 사용.
---

# 개발 세션 (큰 작업 하나)

이 세션은 **조율자**다. 직접 코드를 쓰지 않고 서브에이전트(`builder`·`qa-reviewer`·`fixer`)를 시킨다. 운영자는 큰 작업을 **동시에 하나만** 검토하므로 한 번에 기능 하나만 맡는다. 답변은 한국어. 인자는 기능 이름(slug). 없으면 ROADMAP에서 "설계 승인" 또는 "진행" 상태인 기능을 찾아 하나를 제안한다.

## 0. 시작 점검 (여기서 멈출 수 있다)
1. `date "+%F %a %H:%M"`으로 오늘을 구한다. 모든 서브에이전트 프롬프트 첫 줄에 `오늘은 YYYY-MM-DD(요일)`을 넣는다.
2. **승인 확인**: `docs/product/`에 그 기능의 설계 문서가 있고 ROADMAP 상태가 "설계 승인" 또는 "진행"인지 본다. 아니면 멈추고 "기획 세션에서 설계 승인이 필요하다"고 알린다. 설계에 없는 범위는 만들지 않는다.
3. **동시에 하나**: `git fetch origin` 뒤 `git ls-remote --heads origin "feature/*"`로 이미 다른 기능 브랜치가 있는지 본다. 이 기능의 브랜치가 아닌 것이 있으면 멈추고 보고한다.
4. **사이클과의 관계**: 이 세션은 메인 체크아웃을 쓰지 않는다. 일상 사이클이 도는 중이어도 된다.

## 1. 워크트리 준비 (없을 때만)
```
git fetch origin
git worktree add "E:/claude pj/개인/draw-guess-work/feature-<slug>" -b feature/<slug> origin/develop   # 브랜치가 이미 있으면 -b 없이 기존 브랜치로
cd "E:/claude pj/개인/draw-guess-work/feature-<slug>" && npm ci
```
- `npm ci`는 세션이 직접 한다(운영자가 설치할 필요 없다). node_modules를 메인과 연결(junction)하지 않는다. 워크트리를 지울 때 원본이 지워질 수 있다.
- **테스트 포트**: 테스트 파일들의 포트가 고정이라, 일상 사이클이 테스트를 돌리는 동시에 이 세션이 테스트를 돌리면 충돌한다. BACKLOG의 "테스트 포트 오프셋" 항목이 완료되기 전에는 사이클과 시간이 겹치지 않게 테스트를 돌린다(포트 사용 중 오류가 나면 잠시 뒤 재시도). 완료된 뒤에는 `TEST_PORT_OFFSET=1000`을 붙여 돌린다.

## 2. 항목 반복 (설계 문서 5번 "쪼갠 목록" 순서대로, 한 번 실행에 최대 3항목)
1. **모델 표를 먼저 출력한다.** 서브에이전트마다 `.claude/skills/ops-cycle/SKILL.md` 0-1의 규칙으로 고르되, 이 세션에서는 크기 큼 성격의 builder에 Opus나 Fable을 쓴다.
2. 항목 시작 전에 `git fetch origin && git rebase origin/develop`. 충돌하면 양쪽 변경을 살려 풀고, 못 풀면 멈추고 보고한다(강제 push 금지).
3. `builder`에게 이 워크트리 경로를 알려 주고 그 항목만 구현하게 한다. 프롬프트에 넣을 것: 워크트리 경로, 설계 문서 경로, 항목 번호, "메인 체크아웃 경로에서 작업하지 말 것", "`git add`는 경로 명시, `-A` 금지", "PROTOCOL.md가 바뀌면 같이 고칠 것".
4. `qa-reviewer`에게 **로컬 검증만** 시킨다(스테이징 확인은 생략. feature 브랜치는 스테이징에 배포되지 않는다). 결함은 `docs/ops/TEST-LOG.md`에 남기게 하고, 열림 결함이 있으면 `fixer`를 부른다.
5. 항목이 끝나면 설계 문서의 해당 항목에 완료 표시(`✅ 날짜 커밋해시`)를 하고 커밋한 뒤 `git push origin feature/<slug>`(백업, 배포 안 됨).

## 3. 세션 끝 (항목을 다 했거나 3항목이 끝났을 때)
- 진행률 갱신: ROADMAP의 해당 항목 상태를 `진행 (feature/<slug>, n/m)`으로 바꾸는 **한 줄 변경만** develop에 반영한다. 이 세션의 워크트리는 feature 브랜치이므로 문서용 임시 워크트리(CLAUDE.md "동시 작업 규칙")를 따로 만들어 rebase 후 push하고 지운다.
- **기능이 완성되면**(모든 항목 ✅): 전체 테스트(`npm test`·`npm run test:browser`·`npm run test:mobile`) 통과 → `git fetch && git rebase origin/develop` → 다시 전체 테스트 → `git push origin HEAD:develop`(스테이징 배포). 이어서 ROADMAP 상태를 "스테이징(QA 대기)"로 바꾸는 문서 변경을 push하고, feature 브랜치·워크트리를 지운다(`git worktree remove` 후 `git push origin --delete feature/<slug>`). main 머지는 하지 않는다. 다음 `/ops-cycle`이 스테이징 QA를 하고 머지 GO를 묻는다.
- 마지막 메시지: ① 이번에 끝낸 항목과 커밋 ② 남은 항목 수 ③ 운영자가 폰·실기기로 확인할 것 ④ 막힌 것·운영자 결정이 필요한 것.

## 하지 않는 것
- main 체크아웃·머지·push. 설계에 없는 범위 추가. 신규 기능 두 개 동시 진행. 개인정보 처리방침 변경. `docs/marketing/` 수정. 비밀 값 커밋.
- 설계 문서의 "운영자가 정할 것"이 미결이면 해당 항목 앞에서 멈추고 보고한다.
