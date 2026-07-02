# Daybreak Wire

매일 새벽 CoinDesk 크립토 기사를 B1–B2 영어로 가공해 "추천 3편"으로 띄우고,
**읽기 → 모르는 단어 수집 → 본문 맥락 뜻 → 영작 3문항 → 단어장 누적**을
한 곳에서 하는 영어 학습 웹앱. 정적 호스팅(카페24) + 크론(Actions) 구조.

## 파일

| 파일 | 역할 |
| --- | --- |
| `index.html` | 앱 (React 18 + Babel standalone, CDN). `localStorage`(`dbw:` prefix) 사용, `packs.json` fetch. |
| `packs.json` | 기사 피드(배열, 누적). Actions가 매일 갱신. |
| `build_packs.js` | CoinDesk RSS → Gemini → 팩 3편 생성 → `packs.json` 앞에 prepend. |
| `.github/workflows/daily.yml` | cron `0 21 * * *`(=06:00 KST) + `workflow_dispatch`. |
| `.github/workflows/deploy.yml` | `main` 푸시 시 카페24 호스팅 `/www/`로 FTP 자동 배포(FileZilla 수동 업로드 대체). |

## 1회 설정

1. **Secret 등록** — Settings → Secrets and variables → Actions → New repository secret
   - `GEMINI_API_KEY` (필수, 팩 생성용)
   - `FTP_HOST` / `FTP_USERNAME` / `FTP_PASSWORD` (필수, 카페24 배포용) — 카페24 FTP 접속 정보
   - (선택) Variables 탭에 `GEMINI_MODEL` (기본값 `gemini-2.5-flash`, 예: `gemini-3-flash`)
2. **카페24 배포** — `main`에 푸시하면 `deploy.yml`이 `/www/`로 자동 업로드.
   - Actions 탭 → "Deploy to Cafe24 (FTP)" → Run workflow 로 수동 실행도 가능.
   - 업로드 폴더가 다르면 `deploy.yml`의 `server-dir`을 수정(예: `/`, `/public_html/`).
3. **첫 실행** — Actions 탭 → "Daily CoinDesk packs" → Run workflow
4. 카페24 도메인 URL을 폰 홈 화면에 추가

## 동작

- Actions(매일 06:00 KST) → RSS 수집 → Gemini가 3편 선정·가공 → `packs.json` 커밋 →
  `deploy.yml`이 카페24로 재배포 → 앱이 열릴 때 **가장 최신 date 그룹**을 "오늘 추천"으로 노출.
- 완독 판정: **맨 아래까지 스크롤 후 1.5초 유지**(위로 올라가면 초기화). 완독해야 단어 뜻 확인 가능.
- 현재 `packs.json`에는 동작 확인용 샘플 팩 3편이 들어 있습니다. 첫 Actions 실행 후 실제 기사로 채워집니다.

## 검증

```bash
node -c build_packs.js          # 문법 체크
node -e "JSON.parse(require('fs').readFileSync('packs.json','utf8'))"
```
