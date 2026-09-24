# Supabase 설정 가이드 (계정 기반 P0)

코드는 준비되어 있고, 아래 값이 서버 환경 변수로 들어가는 순간 로그인 기능이 켜집니다. 값이 없으면 지금처럼 게스트 전용으로 동작합니다.

## 1. Supabase 프로젝트 만들기
1. https://supabase.com → New project. 이름 `draw-guess`, 리전은 **Northeast Asia (Tokyo)** 권장(한국과 가장 가깝습니다). Free 플랜.
2. 프로젝트가 뜨면 **Project Settings → API** 에서 세 값을 복사합니다.
   - `Project URL` → `SUPABASE_URL`
   - `anon public` 키 → `SUPABASE_ANON_KEY` (클라이언트에 공개되는 키, 괜찮습니다)
   - `service_role` 키 → `SUPABASE_SERVICE_ROLE_KEY` (**서버 전용 비밀**. 절대 코드나 클라이언트에 넣지 않습니다)

## 2. 테이블 만들기
**SQL Editor → New query** 에 [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql) 내용을 붙여 넣고 Run.
프로필(`profiles`)과 사용자 단어 세트(`word_sets`) 테이블, 가입 시 프로필 자동 생성 트리거, 본인 데이터만 읽고 쓰는 RLS 정책이 만들어집니다.

### 2-1. 프로필 사진 (0002)
같은 방법으로 [`supabase/migrations/0002_avatars.sql`](../supabase/migrations/0002_avatars.sql) 도 실행합니다.
프로필에 사진 표시 방식(`avatar_mode`)과 소셜 원본 사진(`social_avatar_url`) 칸이 생기고, 업로드용 공개 저장소 버킷 `avatars`(1MB, jpeg/png/webp, 본인 폴더만 쓰기)가 만들어집니다.

### 2-2. 목록 공개 범위 좁히기 (0003)
[`supabase/migrations/0003_avatars_select_own.sql`](../supabase/migrations/0003_avatars_select_own.sql) — avatars 버킷 목록을 본인 폴더로만 좁힙니다.

### 2-3. 그림 보관 (0004)
[`supabase/migrations/0004_drawings.sql`](../supabase/migrations/0004_drawings.sql) 도 같은 방법으로 실행합니다.
그림 메타데이터 테이블(`drawings`, 사용자당 100장 제한 트리거, 본인 것만 읽기·만들기·지우기 RLS)과 **비공개** 저장소 버킷 `drawings`(한 장 512KB, webp/png, 본인 폴더만)가 만들어집니다.
실행 전에는 게임이 끝나도 그림을 저장하지 않고, 내 정보 › 그림 탭에 "준비 중"이 보입니다.

## 3. 로그인 제공자 켜기
**Authentication → Providers**

### Google
1. https://console.cloud.google.com → 프로젝트 생성 → **APIs & Services → OAuth consent screen**: External, 앱 이름, 지원 이메일, **개인정보처리방침 URL**에 `https://draw-guess-i927.onrender.com/privacy` 입력. 테스트 단계에서는 테스트 사용자만 로그인되고, "앱 게시"를 누르면 누구나 가능합니다(민감 범위를 안 쓰므로 별도 검수 없음).
2. **Credentials → Create credentials → OAuth client ID** → Web application.
   - Authorized redirect URIs: Supabase Providers 화면의 Google 항목에 표시된 **Callback URL** (`https://<프로젝트>.supabase.co/auth/v1/callback`) 을 그대로 붙여 넣습니다.
3. 발급된 Client ID / Client secret 을 Supabase Google provider 에 입력하고 Enable.

### Kakao
1. https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가.
2. **앱 설정 → 플랫폼 → Web**: 사이트 도메인에 `https://draw-guess-i927.onrender.com`, `https://draw-guess-staging.onrender.com` 등록.
3. **제품 설정 → 카카오 로그인**: 활성화 ON. **Redirect URI** 에 Supabase 의 Callback URL 등록.
4. **동의 항목**: 닉네임(필수), 프로필 사진(선택), **카카오계정(이메일)(선택)**.
   - Supabase Auth 는 카카오에 `account_email` 권한을 **항상** 요청합니다(supabase/auth `provider/kakao.go` 기본 scope 고정, "Allow users without an email" 을 켜도 요청 자체는 빠지지 않음). 이메일 항목이 "권한 없음"이면 로그인 시 **KOE205** 오류가 납니다.
   - 해결: **개인 개발자 비즈 앱 전환**(사업자 등록 없이 가능) 후 이메일을 **선택 동의**로 설정. 사용자가 이메일을 거부해도 Supabase 의 "Allow users without an email" 이 켜져 있으면 로그인됩니다.
5. **앱 키 → REST API 키** 를 Supabase Kakao provider 의 Client ID 에, **보안 → Client Secret** 을 발급해 Client Secret 에 입력하고 Enable.

### 공통: 리다이렉트 허용 목록
**Authentication → URL Configuration**
- Site URL: `https://draw-guess-i927.onrender.com`
- Redirect URLs: `https://draw-guess-i927.onrender.com/**`, `https://draw-guess-staging.onrender.com/**`, `http://localhost:3000/**`

## 4. 서버 환경 변수 넣기
Render 대시보드 → 서비스(`draw-guess`, `draw-guess-staging` 각각) → **Environment** 에 세 값을 추가하고 저장하면 재배포됩니다.

| 키 | 값 |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon public 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 키 |

로컬에서 켜 보려면 PowerShell 에서:
```powershell
$env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_ANON_KEY="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."; npm start
```

## 5. 확인
- `https://…/healthz` 응답에 `"auth":true` 가 보이면 서버가 키를 읽은 것입니다.
- 랜딩 첫 화면에 "Google로 시작하기 / 카카오로 시작하기 / 게스트로 시작하기" 버튼이 나타납니다.
- 로그인 후 새로고침해도 유지되고, 메인의 **내 정보**(/me)에서 단어 세트·로그아웃·회원 탈퇴를 할 수 있어야 합니다.
- 회원 탈퇴는 게임 서버가 service_role 키로 처리합니다(업로드한 사진 삭제 → Auth 사용자 삭제 → profiles·word_sets cascade).

## 무료 한도 (2026 기준 Supabase Free)
- Postgres 500MB, Storage 1GB, 월 50,000 MAU, 이메일 로그인 시간당 30회. 이 게임 규모에 충분합니다.
- 프로젝트가 **7일간 요청이 없으면 일시 정지**됩니다(대시보드에서 Restore). 서버가 자기 핑을 하듯 주 1회 이상 로그인/조회가 있으면 유지됩니다.
