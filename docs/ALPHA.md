# todo.devs 알파 테스트 가이드 (v0.1.0-alpha.1)

알파 빌드입니다. 데이터 포맷과 API 가 바뀔 수 있고, 거친 부분이 있습니다. 목표는 **실제 작업에 한 번 써 보고 막힌 지점을 알려 주는 것**입니다.

## 1. 설치 (macOS · Linux)

Node.js **22.13 이상**과 git 이 필요합니다(`node --version`). Windows 는 아직 지원하지 않습니다(WSL 은 Linux 로 동작).

[릴리스 페이지](https://github.com/jadewisemann/task-driven-dev/releases)에서 `todo-devs-0.1.0-alpha.1.tgz` 를 받아서:

```bash
npm install -g ./todo-devs-0.1.0-alpha.1.tgz
todo-devs --version
todo-devs doctor          # Node·git·ssh·데이터 폴더·DB·서비스 점검 (서버 실행 중이면 에이전트 CLI 도)
```

또는 소스에서: `git clone … && cd task-driven-dev && npm link` (설치할 의존성 없음).

## 2. 실행

```bash
todo-devs serve                           # http://127.0.0.1:7420 (이 컴퓨터에서만)
todo-devs service install                 # 로그인 시 자동 시작 (macOS launchd / Linux systemd --user)
todo-devs service install --host 0.0.0.0  # 휴대폰에서도 쓰려면 네트워크 모드 (토큰 필수)
todo-devs service status
```

데이터는 `~/.todo-devs` 에 있습니다. 업데이트 전후로 백업하세요: `todo-devs backup` → `todo-devs restore FILE`.

## 3. 에이전트 연결

기본 예시 팀은 Atlas·Forge·Lens(`claude-code`), Sprint(`codex`), Mocky(`mock`) 입니다.
서버를 띄운 뒤 `todo-devs doctor` 를 실행하면 CLI 를 찾을 수 없는 에이전트를 알려 줍니다.

- **CLI 없이 체험**: **Agents** 탭에서 각 에이전트의 하네스를 `mock` 으로 바꾸세요(가짜 결과를 내며 전체 흐름을 그대로 보여 줌).
  오케스트레이터는 모든 에이전트에 작업을 배정하므로, 일부만 `mock` 이면 CLI 가 없는 에이전트의 작업이 실패합니다.
- **실제 작업**: 하네스를 설치된 CLI 로 지정하세요 — `claude-code`, `codex`, `kiro-cli`, `gemini`, `aider`, `shell`, `custom`.
  각 CLI 의 로그인/API 키는 그 CLI 에서 직접 설정합니다.

## 4. 모바일 앱

| 기기 | 방법 |
|------|------|
| Android | 릴리스의 `todo-devs-0.1.0-alpha.1.apk` 를 휴대폰에서 받아 설치("출처를 알 수 없는 앱" 허용). ⚠️ 알파 APK 는 Expo 템플릿의 **공개된 디버그 키**로 서명되어 있습니다. 같은 키로 서명된 다른 APK 가 업데이트로 설치되면 앱에 저장된 서버 토큰을 가져갈 수 있으니, 이 릴리스 페이지 외의 APK 는 설치하지 마세요. 이후 정식 빌드와는 서명이 달라 재설치가 필요합니다. |
| iOS 시뮬레이터 (Mac) | `todo-devs-0.1.0-alpha.1-ios-simulator.zip` 압축을 풀고 시뮬레이터를 켠 뒤 `xcrun simctl install booted <압축에서 나온 .app>` (또는 .app 을 시뮬레이터 창에 드래그) |
| iPhone 실기기 | 아직 서명된 빌드가 없습니다. 소스에서 `cd apps/mobile && npm ci && npx expo start` 후 Expo Go 로 QR 스캔. Expo Go 에서는 `todo-devs://` 링크가 열리지 않으니 앱의 연결 화면에 주소와 코드를 직접 입력하세요 |

**페어링**: 컴퓨터에서 서버를 네트워크 모드로 띄운 뒤(`--host 0.0.0.0`) `todo-devs pair` 를 실행하고,
출력된 `todo-devs://pair?…` 링크를 휴대폰에서 열어 **Pair** 를 누릅니다(또는 앱에 주소와 코드 입력). 코드는 10분·1회용입니다.
같은 Wi‑Fi 밖에서는 Tailscale 을 쓰세요: `todo-devs pair --host <tailscale-ip>`.

## 5. 테스트 시나리오

해 보신 항목에 체크해서 피드백과 함께 보내 주세요.

- [ ] 설치 → `todo-devs doctor` 가 모두 ✓ (또는 경고 내용이 납득됨)
- [ ] 웹 UI 에서 카드 3개를 만들고 선행/후행을 연결, 에이전트 칩을 카드에 드롭해 담당자 지정 → **Run all** → 순서대로 Done
- [ ] 선행 작업이 실패하면 후행이 Blocked, 재시도로 복구되면 자동 해제
- [ ] **Orchestrator** 에 목표 한 문장 입력 → 플랜 검토/수정 → 실행 → DAG 화면에서 진행 확인
- [ ] 실제 하네스(claude-code / codex 등) 에이전트 하나로 git 저장소 프로젝트의 작업 실행 → worktree 브랜치에 커밋됨
- [ ] **Workflows** 에서 템플릿 워크플로우를 JSON 입력으로 실행, Router 분기 확인
- [ ] SSH 원격: 다른 머신에 설치 후 `todo-devs peer add …` → 세션 스위처로 원격 보드 조작
- [ ] 모바일: 페어링 → 보드에서 카드 추가 → 컴퓨터 화면에 즉시 반영 → 휴대폰에서 실행/승인
- [ ] `todo-devs service install` 후 재로그인해도 서버가 떠 있음
- [ ] `todo-devs backup` → 다른 `--home` 에 `restore` → 데이터 동일

## 6. 피드백 보내기

[이슈 등록](https://github.com/jadewisemann/task-driven-dev/issues/new/choose) — 버그 리포트 또는 피드백 양식을 고르세요.
웹 UI **Settings** 와 앱 **More → About** 에도 링크가 있습니다. 버그라면 `todo-devs doctor --json` 출력과 재현 순서를 붙여 주세요.
서버 로그: 서비스로 실행 중이면 `~/.todo-devs/logs/`, 직접 실행 중이면 터미널 출력입니다.

## 7. 알려진 제한

- CI 는 실제 LLM CLI 를 호출하지 않습니다(가짜 하네스로 검증). 하네스별 플래그/출력 형식이 CLI 버전에 따라 다를 수 있습니다 — 가장 받고 싶은 피드백입니다.
- CLI 가 없는 에이전트에 배정된 작업은 실패합니다(자동으로 다른 에이전트로 넘기지 않음).
- iOS 는 시뮬레이터 빌드와 Expo Go 만 제공합니다(TestFlight 없음). 푸시 알림 없음 — 앱은 열려 있을 때 실시간 갱신됩니다.
- Windows 네이티브 미지원. 서비스 설치는 macOS launchd / Linux systemd(user) 만 지원합니다.
- Android APK 는 공개 디버그 키로 서명됩니다(위 ⚠️ 참고).
- 네트워크 모드의 LAN 주소는 평문 HTTP 입니다. 신뢰하는 네트워크나 Tailscale 에서만 쓰세요.
- 알파 간 업그레이드 시 데이터 마이그레이션은 자동이지만, 되돌리기는 백업 복원으로만 가능합니다.
