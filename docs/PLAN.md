# todo.devs — 구현 계획

에이전트를 "팀원"처럼 칸반 카드에 배정하고, 의존성(선행/후행)을 따라 끝까지 자율 실행하며,
n8n 식 노드 그래프로 흐름을 제어하고, SSH 로 다른 머신의 세션을 원격 조작하는 로컬 도구.

## 제약 / 기술 선택

- **런타임 의존성 0개**: Node.js ≥ 22 내장 모듈만 사용 (`node:sqlite`, `node:http`, `node:child_process`).
  설치 없이 `node bin/todo-devs.js serve` 로 실행된다.
- **프런트엔드**: 빌드 없는 Vanilla ES Modules (`src/web`). 서버가 정적 파일로 제공.
- **API 는 단일 JSON-RPC 표면**: 브라우저(`POST /api/rpc`), CLI, SSH 원격 브리지가 같은 메서드를 호출한다.
  원격 세션은 `peer` 필드만 추가하면 동일하게 동작한다.

## 아키텍처

```
bin/todo-devs.js         CLI (serve | rpc | call | plan | run | peer ...)
src/server/
  core/                  db(sqlite+마이그레이션), events(버스), ids, errors
  http/                  라우터, 정적 파일, SSE
  rpc/                   메서드 레지스트리 + 디스패처 (HTTP/STDIO 공용)
  domain/                projects, tasks(+DAG), agents, workflows, runs, peers
  harness/               mock / claude-code / codex / kiro-cli / gemini / shell / custom
  runtime/               runner(태스크 1개), scheduler(의존성 따라 끝까지), worktree
  workflow/              노드 엔진 (라우터/병합/루프), 노드 타입
  orchestrator/          자연어 → 플랜 → 티어 기반 모델 할당 → 실행
  remote/                SSH stdio JSON-RPC 클라이언트, 데몬 브리지
src/web/                 칸반, 에이전트, 흐름(DAG), 노드 에디터, 원격 세션 UI
```

## 기능 단위 (각각 별도 git worktree + 리뷰 서브에이전트 + 리팩토링)

| # | 브랜치 | 내용 |
|---|--------|------|
| F1 | `feat/core` | sqlite, RPC, HTTP/SSE, 프로젝트/태스크/의존성(사이클 검출), 칸반 UI |
| F2 | `feat/agents` | 에이전트 프로필(성격·하네스·모델·노력·컨텍스트 그래프), 하네스 레지스트리, 담당자 지정 |
| F3 | `feat/runner` | 태스크 실행기, 자율 스케줄러(동시성·재시도·차단 전파), worktree, 실시간 로그 |
| F4 | `feat/workflows` | 노드 엔진(JSON 입력 라우터·에이전트 판단 라우터·루프), 캔버스 에디터, 에이전트 그래프 |
| F5 | `feat/orchestrator` | 자연어 플랜 → 작업 추출 → 작은 모델 자동 할당 → 자동 실행, 흐름 뷰 |
| F6 | `feat/remote` | `todo-devs rpc` stdio 브리지, SSH 피어, 세션 스위처, CLI |
| F7 | `feat/mobile-api` | 네트워크 모드(영속 토큰), 1회용 페어링 코드, 이벤트 롱폴링(재시작 안전 커서) |
| F8 | `feat/mobile-app` | React Native(Expo SDK 57) 앱: 페어링, 보드, 태스크 액션, 오케스트레이터, 플랜, 로그, 에이전트, 원격 세션 |

통합 브랜치 `feat/todo-devs` 에 기능 브랜치를 순서대로 `--no-ff` 머지한 뒤 `main` 으로 PR.

## 진행 방식과 결과

각 기능은 별도 worktree 에서 구현 → 스크립트/헤드리스 브라우저로 검증 → 리뷰 서브에이전트 피드백 →
리팩토링 커밋 → 머지 순서로 진행했다. 리뷰에서 반영한 주요 항목:

- F1: 잘못된 URL 로 서버 크래시, `text/plain;application/json` CSRF 우회, 비동기 `tx`, CLI 쓰기가 데몬 이벤트를 우회
- F2: argv 길이 한계(프롬프트 stdin 전달), 설정 화이트리스트, env 비밀값 마스킹, 하네스별 자율성 일관화
- F3: 백그라운드 자식이 파이프를 잡아 실행이 끝나지 않는 문제, 삭제/이동 중 태스크, 브랜치 이름 고정, 로그 코얼레싱
- F4: 연결 안 된 error 포트가 실패를 삼킴, Shell 템플릿 인젝션, 그래프 결과 매핑, 머지 큐
- F5: 폐기/재시작 시 플랜 상태, 플랜 범위 스케줄링, 사이클 제거 정확도, 역량 우선 할당, 문장 분할
- F6: 원격 이벤트가 로컬 도메인 로직에 영향, SSE 프레임 주입, ssh 옵션 허용 목록, 프레이밍/수명주기
- F7: 서버 재시작 후 커서가 조용히 이벤트를 놓침, 링크/로그로 토큰 노출(→ 1회용 코드), SSH 브리지로 페어링 정보 유출, auth.json 원자적 쓰기
- F8: 딥링크 무확인 페어링, 탭 네비게이터 중복, 상세 화면 콜드스타트 크래시, SecureStore 용량, 원격 세션 피드 404 무한 재시도, 백그라운드 복귀 처리

모바일 앱은 샌드박스에서 npm 설치가 불가능해 번들/실기기 실행을 하지 못했다. 순수 TS 코어는 실제 서버를 상대로 Node 에서 실행해 검증했고,
화면 코드는 스텁 타입 선언으로 타입 검사만 했다. 첫 실행 시 `npm run setup`(= `npx expo install --fix`)으로 SDK 57 호환 버전을 맞춘다.

