# Affinity 먼데이 매칭 뷰 (정적 / 매일 09:00 갱신)

먼데이 4개 화면을 **정적 HTML 보기뷰**로 생성해 매일 오전 9시에 갱신합니다. 읽기 전용(먼데이 데이터 수정 안 함), **의존성 없음(Node 20+)**.

- 수강생 리스트 — STUDENT DB(1879266175): 이름·상태(수강/비수강)·생년월일(빈칸)·시작일·마케터·지역·레코드·연락처·이메일
- 강사 스케줄 — CLASS INFO HUB(1888467610): **주간 + 월간**, 강사 필터(먼데이 강사명)
- 이탈 리스트 — 최근 한 달 종강 + 수강중 아님
- 종강 리스트 — CLASS INFO HUB **DONE 그룹**

## 권장: GitHub Actions 로 자동 발행 (토큰은 Secret)
1. GitHub 에 저장소 생성 후 이 폴더의 **추적 파일들**을 push
   (`generate.mjs`, `package.json`, `.github/workflows/daily-views.yml`, `README.md`, `.gitignore`).
2. 저장소 **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `MONDAY_API_TOKEN`
   - Value: 먼데이 토큰
3. 저장소 **Settings → Pages → Build and deployment → Source: `GitHub Actions`**
4. **Actions** 탭에서 `Daily Monday Views` → `Run workflow` 로 1회 수동 실행(확인용).
   - 이후 매일 **00:00 UTC = 09:00 KST** 자동 실행.
   - 공개 주소: `https://<사용자>.github.io/<레포>/`

> 토큰은 저장소에 절대 올라가지 않습니다(`.env` 는 `.gitignore`, 빌드 시 Secret 주입).
> `docs/` 도 커밋하지 않습니다(Actions 가 생성·배포).

## 대안: 로컬 PC 에서 발행 (인터넷 없는 사내망 등)
`publish.ps1` + `register-task.ps1` 은 Windows 작업 스케줄러로 로컬 생성/발행하는 방식입니다.
이 경우 토큰은 로컬 `.env` 에 두고, `.env` 의 `GIT_REMOTE_URL` 에 저장소 URL 을 넣어 push 합니다.
GitHub Actions 를 쓰면 이 로컬 작업은 불필요합니다(중복 실행 방지를 위해 해제 권장:
`Unregister-ScheduledTask -TaskName 'AffinityMondayViews-Daily' -Confirm:$false`).

## 로컬에서 한 번 만들어 보기
```
node generate.mjs   ->  docs\index.html (브라우저로 열어 확인)
```

## 접근 비밀번호 (기본 5000)
- 페이지 데이터는 비밀번호로 **AES 암호화**되어 출력됩니다. 방문자가 비밀번호(기본 `5000`)를 입력해야 복호화되어 보입니다.
- 비밀번호 변경: 빌드 시 환경변수 `VIEW_PASSWORD` 설정 (워크플로 `env:` 또는 로컬 `.env`).
- 한계: 정적 페이지 특성상 누구나 URL 접근은 가능하며(데이터는 암호문), `5000` 같은 짧은 숫자는 무차별 대입에 약합니다.
  민감 데이터 보호가 중요하면 **긴 비밀번호** 사용 + (가능하면) 비공개 레포/별도 인증 호스팅을 권장합니다.

## 주의
- 토큰 만료 시: GitHub Secret(또는 로컬 `.env`) 의 `MONDAY_API_TOKEN` 교체.
