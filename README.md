# todo.devs

AI 에이전트를 팀원처럼 칸반 카드에 배정하고, 선행/후행 관계를 따라 **끝까지 자율 실행**하는 로컬 도구.
자연어 목표를 오케스트레이터가 작업으로 쪼개 작은 모델에 할당하고, n8n 식 노드 그래프로 흐름을 제어하며,
SSH 로 다른 머신의 세션을 그대로 원격 조작합니다. 휴대폰용 React Native 앱(`apps/mobile`)도 있습니다.

- 런타임 의존성 없음 — Node.js **22.13+** 만 있으면 됩니다 (`node:sqlite`, `node:http`).
- 데이터: `~/.todo-devs` (`--home` 또는 `TODO_DEVS_HOME` 으로 변경)

```bash
node bin/todo-devs.js serve          # http://127.0.0.1:7420
# 또는: npm link && todo-devs serve
```

## 화면

| 탭 | 내용 |
|----|------|
| **Board** | 칸반(Backlog → To do → Running → Review → Done / Failed·Blocked). 카드 드래그, 에이전트 칩을 카드에 드롭해 담당자 지정, 선행 작업 지정, ▶ Run all |
| **Orchestrator** | 자연어 목표 입력 → 플랜(작업·의존성·담당 에이전트·설명) 검토/수정 → 실행. 전체 흐름을 DAG 로 실시간 확인, 노드 클릭 시 라이브 로그 |
| **Agents** | 에이전트 정의: 성격(시스템 프롬프트), 하네스, 모델, 노력 수준, 티어, 자율성, 컨텍스트 그래프, 재시도/타임아웃, worktree, 노드 그래프 |
| **Workflows** | n8n 식 캔버스 에디터. 프로젝트 워크플로우(JSON 입력으로 실행)와 에이전트 그래프(에이전트의 작업 절차) |
| **Runs** | 모든 실행 기록과 실시간 로그 |
| **Remote** | SSH 세션 관리. 상단 세션 스위처로 원격 머신을 선택하면 모든 화면이 그 머신을 조작 |

## 핵심 개념

**에이전트** — `harness` 는 실제 실행기입니다: `claude-code`, `codex`, `kiro-cli`, `gemini`, `aider`, `shell`, `custom`(명령 템플릿), `mock`(API 키 없이 시험용).
노력 수준은 Claude(`MAX_THINKING_TOKENS`)·Codex(`model_reasoning_effort`)에 네이티브로, 나머지는 프롬프트로 전달됩니다.
**컨텍스트 그래프**는 작업 의존성 그래프 중 에이전트가 볼 범위(선행 작업 깊이, 결과 포함 여부, 후행/병렬 작업, 프로젝트 브리프, 글자 예산)입니다.
시작 시 예시 팀(Atlas/Forge/Sprint/Lens/Mocky)이 생성됩니다.

**스케줄러** — 선행 작업이 모두 `done` 인 `todo` 카드를 우선순위 순으로 동시성 한도만큼 실행합니다.
실패 시 에이전트의 `retries` 만큼 재시도, 최종 실패 시 후행 작업은 `blocked`, 선행이 복구되면 자동 해제.
에이전트가 `needs_review` 를 보고하면 정책에 따라 대기하거나 자동 승인하고, 모든 작업이 끝날 때까지 계속합니다.

**worktree** — 프로젝트에 git 저장소 경로를 지정하면 작업마다 `todo-devs/<id>-<slug>` 브랜치의 worktree 에서 실행하고,
선행 작업 브랜치를 자동 병합한 뒤 결과를 커밋합니다. 병합 충돌/커밋 실패는 조용히 넘어가지 않고 Review 로 올라옵니다.

**오케스트레이터** — 고티어 에이전트가 목표를 JSON 플랜으로 만들고, 할당기가 복잡도→필요 티어를 계산해
**가장 저렴한 역량 있는 에이전트**에 배정합니다(모델이 추천한 담당자는 과한 티어가 아니면 존중).
오케스트레이터가 mock 이거나 응답이 쓸 수 없으면 내장 플래너(한/영 문장·목록 분할, 역할/복잡도 추론)가 대신합니다.
플랜 실행은 해당 플랜의 작업만 대상으로 합니다.

**워크플로우 노드** — Start · JSON · Transform · Agent · Router · Merge · Shell · Create task · Output.
Router 는 `input.json.status eq approved` 같은 JSON 조건 규칙 또는 **에이전트 판단**으로 분기합니다.
템플릿 `{{input.x}}`, `{{vars.task.title}}`, `{{nodes.<id>.json}}`, `{{visits.<id>}}` 사용 가능. 루프(리뷰→수정)는 노드별 실행 횟수로 제한됩니다.
연결되지 않은 `error` 포트의 실패는 실행 실패로 처리되고, Shell 노드의 값은 인자로 전달되어 셸 코드로 해석되지 않습니다.
에이전트에 그래프를 지정하면 그 에이전트는 모든 작업을 그래프로 수행합니다(예: *Implement → review loop* 템플릿).

## 원격 제어 (SSH)

원격 머신에도 todo.devs 를 설치하고 `ssh user@host` 가 비밀번호 없이 되면 됩니다.

```bash
todo-devs peer add box me@build-box --port 22 --identity ~/.ssh/id_ed25519
todo-devs peer ping box
todo-devs status --peer box
todo-devs plan "결제 API 를 만들고 그 다음 결제 화면, 그리고 테스트" --run --peer box
```

로컬은 `ssh -T -o BatchMode=yes … -- me@build-box "todo-devs rpc"` 를 실행하고, 줄 단위 JSON-RPC 로 통신합니다.
원격에 `todo-devs serve` 가 떠 있으면 모든 호출이 그 서버로 전달되어(스케줄러는 연결을 끊어도 계속 동작) 이벤트가 실시간으로 중계됩니다.
서버가 없으면 세션 동안만 임베디드 인스턴스가 열립니다(동시에 하나만). `--exec "docker exec -i box todo-devs rpc"` 같은 임의 전송도 지원합니다.
원격 UI 를 직접 쓰려면 터널: `ssh -L 7421:127.0.0.1:7420 me@build-box` 후 `http://localhost:7421`.

## 모바일 앱

`apps/mobile` — Expo(SDK 57) · expo-router · TypeScript. 보드/담당자 지정, 실행·취소·재시도·승인,
오케스트레이터 목표 입력 → 플랜 검토 → 실행, 실시간 로그, 에이전트 모델/노력 조정, SSH 원격 세션 전환, 워크플로우 실행.

```bash
todo-devs serve --host 0.0.0.0     # 네트워크 모드 (토큰 필수, ~/.todo-devs/auth.json 에 보관)
todo-devs pair                     # 1회용 페어링 코드(10분·1회) + 앱/브라우저 링크
cd apps/mobile && npm run setup && npx expo start
```

휴대폰에서 `todo-devs://pair?...` 링크를 열고 **Pair** 를 누르거나, 앱에 주소와 코드를 입력합니다.
같은 Wi‑Fi 밖에서는 Tailscale 주소(`todo-devs pair --host <tailscale-ip>`)를 쓰세요. 자세한 내용은 [apps/mobile/README.md](apps/mobile/README.md).

## CLI

```
todo-devs serve | rpc
todo-devs status | tasks | add "<title>" [--after ID,ID] [--agent NAME]
todo-devs plan "<goal>" [--run] [--wait] [--auto-approve]
todo-devs run [--concurrency 2] [--auto-approve] | stop
todo-devs peer add|list|ping|rm …
todo-devs pair [--host ADDR] | token rotate     # 모바일/다른 기기 페어링
todo-devs call <method> [json] | methods        # 모든 기능은 JSON-RPC 메서드로 노출
```

실행 중인 서버가 있으면 CLI 는 그 서버로 호출합니다. `run`/`plan` 은 서버가 필요합니다.

## 보안 메모

- 기본 바인딩은 `127.0.0.1`. Host/Origin 검사, `application/json` 강제로 DNS 리바인딩·CSRF 차단.
- 네트워크 모드(`--host 0.0.0.0`)에서는 모든 API 에 토큰이 필요합니다(헤더로만 전달, 이벤트 스트림만 예외).
  토큰은 `auth.json`(0600)에 보관되고 링크에는 절대 들어가지 않습니다 — 기기는 1회용 코드(10분, 1회, 시도 횟수 제한)로 토큰을 받습니다.
  LAN 주소는 평문 HTTP 이므로 신뢰하는 네트워크에서만 쓰고, 외부에서는 Tailscale 을 권장합니다. `todo-devs token rotate` 로 모든 기기 연결을 끊을 수 있습니다.
- API 에 접근할 수 있으면 `shell`/`custom` 하네스로 로컬 명령을 실행할 수 있습니다(로컬 도구의 의도된 권한).
  에이전트 `env` 값은 API/이벤트에서 마스킹됩니다. 자율성(`safe`/`auto`/`full`)은 하네스별 권한 플래그로 매핑됩니다.
- 원격에서 온 이벤트는 UI 로만 중계되고 로컬 스케줄러/러너에는 영향을 주지 않습니다. ssh 옵션은 허용 목록만 받습니다.

## 구조

```
bin/todo-devs.js          CLI 진입점
src/cli/                  명령, 세션(데몬 HTTP 또는 인프로세스)
src/remote/               stdio 브리지 (`todo-devs rpc`), JSONL 프레이밍
src/server/core/          sqlite, 마이그레이션, 이벤트 버스, 에러
src/server/http/          HTTP · SSE · 정적 파일
src/server/rpc/           JSON-RPC 레지스트리
src/server/domain/        projects, tasks(DAG), agents, workflows
src/server/harness/       하네스 레지스트리(명령 구성)
src/server/agents/        컨텍스트 그래프 프롬프트 빌더
src/server/runtime/       프로세스 실행, 러너, 스케줄러, worktree, 실행 로그
src/server/workflow/      노드 엔진, 노드 타입, 식/템플릿, 템플릿 그래프
src/server/orchestrator/  플래너, 할당기, 플랜 수명주기
src/server/remote/        피어 관리, 원격 클라이언트
src/web/                  빌드 없는 ES 모듈 UI
apps/mobile/              React Native(Expo) 앱 — src/core 는 React 비의존 TS (RPC·롱폴링·페어링)
docs/PLAN.md              구현 계획
```
