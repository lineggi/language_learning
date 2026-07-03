# Daybreak Wire

매일 새벽 CoinDesk 크립토 기사를 B1–B2 영어로 가공해 "추천 3편"으로 띄우고,
**읽기 → 모르는 단어 수집 → 본문 맥락 뜻 → 영작 3문항 → 단어장 누적**을
한 곳에서 하는 영어 학습 웹앱. 정적 호스팅(GitHub Pages) + 크론(Actions) 구조.

## 파일

| 파일 | 역할 |
| --- | --- |
| `index.html` | 앱 (React 18 + Babel standalone, CDN). `localStorage`(`dbw:` prefix) 사용, `packs.json` fetch. |
| `packs.json` | 기사 피드(배열, 누적). Actions가 매일 갱신. |
| `build_packs.js` | CoinDesk RSS → Gemini → 팩 3편 생성 → `packs.json` 앞에 prepend. |
| `.github/workflows/daily.yml` | cron `0 21 * * *`(=06:00 KST) + `workflow_dispatch`. |
| `config.js` | 클라이언트 설정(Supabase URL/anon key, 채점 엔드포인트). 비워두면 로컬 전용. |
| `api/grade.js` | Vercel 서버리스 함수 — 영작 AI 채점·첨삭(Gemini). 키는 서버 env에만. |
| `supabase/schema.sql` | Supabase 테이블 + RLS(기기 간 동기화용). |

## 백엔드(선택) — 기기 동기화 + AI 채점

정적 배포만으로도 앱은 동작합니다(단어장/진도는 기기별 localStorage). 아래를 설정하면
**폰↔PC 동기화**와 **영작 AI 채점·첨삭**이 켜집니다.

### A. Supabase (동기화)
1. supabase.com에서 프로젝트 생성.
2. SQL Editor → `supabase/schema.sql` 붙여넣고 Run.
3. Authentication → Providers → **Email**(매직링크) 활성화. URL Configuration의 Site URL에
   배포 도메인(예: `https://language-learning-vert.vercel.app`) 추가.
4. Project Settings → API 에서 **Project URL**과 **anon public key** 복사 → `config.js`에 붙여넣기.
   (anon key는 공개돼도 안전 — RLS가 보호)

### B. AI 채점 (Vercel 함수)
1. Vercel 프로젝트 → Settings → Environment Variables 에 **`GEMINI_API_KEY`** 추가
   (GitHub Actions secret과는 별개입니다). 선택: `GEMINI_MODEL`.
2. 재배포하면 `POST /api/grade`가 활성화됩니다. 앱의 영작 화면에서 **"AI 채점·첨삭"** 버튼이 동작.

> `config.js`의 `SUPABASE_URL`이 비어 있으면 로그인 바가 숨겨지고 로컬 전용으로 동작합니다.
> `GRADE_ENDPOINT`는 기본 `/api/grade` — Vercel 함수가 없으면 버튼이 오류 메시지를 표시합니다.

## 1회 설정

1. **Secret 등록** — Settings → Secrets and variables → Actions → New repository secret
   - `GEMINI_API_KEY` (필수)
   - (선택) Variables 탭에 `GEMINI_MODEL` (기본값 `gemini-2.5-flash`, 예: `gemini-3-flash`)
2. **Pages** — Settings → Pages → Deploy from branch → `main` `/(root)`
3. **첫 실행** — Actions 탭 → "Daily CoinDesk packs" → Run workflow
4. 생성된 Pages URL을 폰 홈 화면에 추가

## 동작

- Actions(매일 06:00 KST) → RSS 수집 → Gemini가 3편 선정·가공 → `packs.json` 커밋 →
  Pages 재배포 → 앱이 열릴 때 **가장 최신 date 그룹**을 "오늘 추천"으로 노출.
- 완독 판정: **맨 아래까지 스크롤 후 1.5초 유지**(위로 올라가면 초기화). 완독해야 단어 뜻 확인 가능.
- 현재 `packs.json`에는 동작 확인용 샘플 팩 3편이 들어 있습니다. 첫 Actions 실행 후 실제 기사로 채워집니다.

## 검증

```bash
node -c build_packs.js          # 문법 체크
node -e "JSON.parse(require('fs').readFileSync('packs.json','utf8'))"
```
