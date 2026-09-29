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

통합 브랜치 `feat/todo-devs` 에 기능 브랜치를 순서대로 `--no-ff` 머지한 뒤 `main` 으로 PR.
