# Daybreak Wire

매일 새벽 크립토·경제 영문 기사를 B1–B2 영어로 가공해 "오늘의 추천"으로 띄우고,
**읽기 → 모르는 단어 수집 → 본문 맥락 뜻 → 문법 드릴 → 영작 3문항 → AI 첨삭 →
단어장·오답노트 누적**을 한 곳에서 하는 영어 학습 웹앱.
빌드 도구 없는 정적 페이지 + 크론(Actions) + 서버리스 함수 구조.

## 화면

| 탭 | 하는 일 |
| --- | --- |
| **오늘** | 그날의 추천 6편(크립토 3 + 경제 3). 칩으로 분야 필터. |
| **보관함** | 완독한 기사 목록. 다시 열어 복습하거나 개별 삭제. |
| **단어장** | 모은 단어를 **진도별** 또는 **주차별**로 학습. 연속 학습일 캘린더. |
| **오답노트** | AI 첨삭에서 뽑아낸 문법 오답의 간격 반복. 4지선다로 복습. |

기사를 열면 **맨 아래까지 스크롤 후 1.5초 유지**해야 완독으로 판정되고(위로 올라가면 초기화),
그때부터 단어 뜻 확인·문법 드릴·영작이 열립니다.

### 단어장의 두 가지 구성

같은 단어를 어떤 단위로 외울지 고를 수 있습니다. 선택은 기기에 저장돼 다음에도 유지됩니다.

| 구성 | 단위 | 학습 |
| --- | --- | --- |
| **진도별** | 간격 반복 단계 | 미암기 → 복습중 → 완료. `단어 외우기`(미암기)와 `복습하기`(오늘 복습 가능). |
| **주차별** | 한국 시간 기준 한 주 | 월–금에 모은 단어를 `10월 1주차` 단어장으로 묶고, **토·일에 그 주를 몰아서 복습**. |

주차별에서는 주차를 고르면 단어 목록·단계 칩·삭제 범위가 모두 그 주 기준으로 좁혀지고,
`10월 1주차 N개 몰아서 외우기` 버튼이 그 주 단어를 **진도와 상관없이 전부** 한 덱으로 묶습니다.
토·일에는 맨 위에 그 주의 복습 카드가 뜹니다(구성 전환 버튼에도 점으로 표시).

**주차 계산** — 주는 월요일에 시작해 일요일에 끝나고, 그 주의 **목요일이 속한 달**에 붙습니다
(ISO-8601 규칙). 목요일은 월–금 수집 구간 한가운데라 라벨이 늘 그 주가 실제로 속한 달을 가리키고,
매달 4~5주차가 중복·누락 없이 떨어집니다. 예를 들어 2026-10-01이 목요일이므로
`9/28(월)~10/4(일)`이 **10월 1주차** — 10월 1일이 든 주입니다. 토·일에 추가한 단어는 마침 그때
복습하는 주에 함께 들어갑니다. 수집일이 기록되기 전에 모은 옛 단어는 `날짜 미상` 묶음으로 모여
그대로 학습할 수 있습니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `index.html` | 앱 전체 (React 18 + Babel standalone, CDN). 상태는 `localStorage`(`dbw:` prefix). |
| `lib/state.js` | 순수 로직 — 스트릭·SRS·주차 계산·기기 간 병합 규칙. 브라우저와 테스트가 **같은 코드**를 씁니다. |
| `packs.json` | 최근 14일치 기사 팩. 앱이 로드할 때 받는 유일한 데이터 파일. |
| `archive/index.json` | 전체 기사 목록(메타데이터만). **보관함을 처음 열 때만** 받습니다. |
| `archive/YYYY-MM.json` | 지난 달치 기사 본문. **옛 기사를 실제로 열 때만** 받습니다. |
| `build_packs.js` | RSS 수집 → Gemini 가공 → 팩 생성 → 피드 재분할. |
| `scripts/check_feed.js` | 배포된 피드가 위 규칙을 지키는지 검사(CI). |
| `test/` | `node --test` 유닛 테스트, `test/browser/`는 Playwright 시나리오. |
| `config.js` | 클라이언트 설정(Supabase URL/anon key, API 엔드포인트). 비워두면 로컬 전용. |
| `api/*.js` | Vercel 서버리스 함수 5종(아래). Gemini 키는 서버 env에만 둡니다. |
| `supabase/schema.sql` | Supabase 테이블 + RLS(기기 간 동기화용). |
| `.github/workflows/daily.yml` | cron `0 21 * * *`(=06:00 KST) + `workflow_dispatch`. |
| `.github/workflows/test.yml` | push/PR마다 테스트 + 피드 검사. |

### 서버리스 함수

| 엔드포인트 | 하는 일 |
| --- | --- |
| `POST /api/grade` | 영작 답안 채점 + 문장별 첨삭(오답노트의 원천). |
| `POST /api/overall` | 3문항 전체 총평 + 영작 실력 향상 아이디어. |
| `POST /api/define` | 기사 용어집에 없는 단어를 탭했을 때 즉석 뜻풀이. |
| `POST /api/drill` | 기사 기반 빈칸 문법 드릴(동사형·관사·복수·전치사). |
| `POST /api/errmc` | 오답노트 4지선다용 오답 선택지 생성. |

전부 같은 `GEMINI_API_KEY`(Vercel env)를 씁니다. 함수가 없으면 해당 버튼만 안내 메시지를 띄우고,
읽기·단어장 등 나머지 기능은 그대로 동작합니다.

## 데이터 흐름

```
Actions (매일 06:00 KST)
  └ CoinDesk Most Read (실패 시 RSS) + CNBC / BBC / Guardian / Bloomberg RSS
      └ 이미 쓴 기사 URL 제외 → Gemini가 분야별 3편 선정·가공
          └ packs.json(최근 14일) + archive/ 재분할 → 커밋 → 재배포
```

앱은 `packs.json`의 **가장 최신 date 그룹**을 "오늘의 추천"으로 노출합니다.

### 피드를 나눠 두는 이유

기사는 매일 6편씩 영구히 쌓입니다. 전부 한 파일에 두면 앱을 열 때마다 그 전체를 내려받게 되어,
1년이면 첫 화면이 15MB를 넘습니다. 그래서 `build_packs.js`가 매 실행마다 피드를 셋으로 나눕니다.

- `packs.json` — 최근 `RECENT_DAYS`(기본 14)일치 **본문 포함**. 첫 로드에 받는 유일한 파일.
- `archive/index.json` — 전체 기사의 **메타데이터만**(본문·용어집·문항 제외). 보관함 첫 진입 시.
- `archive/YYYY-MM.json` — 그보다 오래된 기사의 본문. 해당 기사를 열 때만.

덕분에 첫 로드는 기사가 몇 년치 쌓여도 일정한 크기로 유지됩니다(도입 시점 2.8MB → 683KB).
내용이 바뀌지 않은 월별 파일은 다시 쓰지 않으므로 저장소도 매일 부풀지 않습니다.

`RECENT_DAYS`를 바꾸거나 옛 평면 `packs.json`을 옮겨야 하면 API 호출 없이 재분할할 수 있습니다.

```bash
node build_packs.js --repack
```

## 백엔드(선택) — 기기 동기화 + AI 채점

정적 배포만으로도 앱은 동작합니다(모든 진도가 기기별 `localStorage`). 아래를 설정하면
**폰↔PC 동기화**와 **영작 AI 채점·첨삭**이 켜집니다.

동기화 대상은 단어장 · 완독 기록 · 연속 학습일 · **오답노트** · **영작 답안과 채점 결과**입니다.
(단어장 구성이 진도별인지 주차별인지는 화면 취향이라 기기마다 따로 기억합니다.)
충돌은 항목별 last-write-wins로 정리하고, 삭제는 tombstone(삭제 표시 + 갱신 시각)으로 남겨
다른 기기의 오래된 사본이 되살리지 못하게 합니다. 규칙은 전부 `lib/state.js`에 있고 테스트로 고정돼 있습니다.

### A. Supabase (동기화)
1. supabase.com에서 프로젝트 생성.
2. SQL Editor → `supabase/schema.sql` 붙여넣고 Run.
   (이미 쓰던 프로젝트도 그대로 다시 실행하면 됩니다 — 전부 idempotent라
   `errors` / `writing` 컬럼만 추가됩니다.)
3. Authentication → Providers → **Email**(매직링크) / **Google** 활성화. URL Configuration의
   Site URL에 배포 도메인(예: `https://language-learning-vert.vercel.app`) 추가.
4. Project Settings → API 에서 **Project URL**과 **anon public key** 복사 → `config.js`에 붙여넣기.
   (anon key는 공개돼도 안전 — RLS가 보호. 그래서 이 저장소에도 커밋돼 있습니다.)

### B. AI 채점 (Vercel 함수)
1. Vercel 프로젝트 → Settings → Environment Variables 에 **`GEMINI_API_KEY`** 추가
   (GitHub Actions secret과는 별개입니다). 선택: `GEMINI_MODEL`.
2. 재배포하면 위 5개 엔드포인트가 활성화됩니다.

> `config.js`의 `SUPABASE_URL`이 비어 있으면 로그인 바가 숨겨지고 로컬 전용으로 동작합니다.

## 1회 설정

1. **Secret 등록** — Settings → Secrets and variables → Actions → New repository secret
   - `GEMINI_API_KEY` (필수)
   - (선택) Variables 탭에 `GEMINI_MODEL` (기본값 `gemini-2.5-flash`)
2. **배포** — Vercel(권장, 서버리스 함수 필요) 또는 Pages(정적 기능만).
3. **첫 실행** — Actions 탭 → "Daily packs (crypto + economy)" → Run workflow
4. 배포 URL을 폰 홈 화면에 추가

## 개발

```bash
npm test          # lib/state.js + build_packs.js 유닛 테스트
npm run check     # 문법 체크 + 배포된 피드 무결성 검사
npm run test:browser  # 실제 브라우저에서 단어장·학습 세션 검증 (Playwright 필요)
npm run repack    # API 호출 없이 packs.json / archive 재분할
npm run build     # 오늘치 팩 생성 (GEMINI_API_KEY 필요)
```

앱에는 빌드 단계가 없습니다. `index.html`을 정적으로 서빙하면 그대로 동작합니다.

```bash
npx http-server -p 8080 -c-1
```

유닛 테스트는 스트릭 감쇠, 단어 stage 전이, 주차 계산, 기기 간 병합, 피드 분할처럼
**실제로 회귀가 났던 규칙**을 덮습니다. `lib/state.js`나 `build_packs.js`의 순수 로직을 고칠 때는
테스트를 함께 갱신하세요.

`test/browser/`는 순수 함수로는 볼 수 없는 것 — 포인터 이벤트·CSS 트랜지션·React 커밋 타이밍이
얽힌 플래시카드 스와이프, 그리고 "오늘이 무슨 요일인가"에 달린 주차별 단어장 — 을 실제 크로미움에서
확인합니다(시계를 특정 날짜에 고정해 실행). CDN에서 React를 받으므로 CI에서는 게이트 없이
리포트만 합니다.
