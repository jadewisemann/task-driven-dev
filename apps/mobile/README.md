# todo.devs mobile

React Native(Expo SDK 57 · expo-router · TypeScript) 앱. 휴대폰에서 보드 확인, 담당자 지정,
실행/취소/재시도/승인, 오케스트레이터에 목표 입력 → 플랜 검토 → 실행, 실시간 로그, 에이전트 모델/노력 조정,
SSH 원격 세션 전환, 워크플로우 실행을 할 수 있습니다. 편집이 많은 작업(에이전트 페르소나, 노드 그래프)은 웹 UI 에서 합니다.

## 실행

```bash
cd apps/mobile
npm ci               # package-lock.json 의 검증된 버전 설치 (CI 와 동일)
npx expo start       # Expo Go 로 QR 스캔, 또는
npm run ios          # / npm run android — 개발 빌드
```

SDK 를 올릴 때는 `npm run setup`(= `npx expo install --fix`)으로 버전을 다시 맞추고 `npx expo-doctor` 로 확인한 뒤 lockfile 을 커밋합니다.
테스트: `npm test`(코어 — 이 저장소의 실제 서버를 띄워 검증), `npx tsc --noEmit`, `npm run export`(iOS·Android 번들).

## 서버와 페어링

```bash
todo-devs serve --host 0.0.0.0   # 네트워크 모드: 토큰 필수, ~/.todo-devs/auth.json 에 보관
todo-devs pair                   # 1회용 코드(10분, 1회) + 링크 출력
```

- 휴대폰에서 `app:` 링크(`todo-devs://pair?...`)를 열거나, 앱의 **Paste pairing link** 를 누르거나, 주소와 코드를 직접 입력합니다.
- 같은 Wi‑Fi 가 아니면 Tailscale 주소를 쓰세요(`todo-devs pair --host <tailscale-ip>`). LAN 주소는 암호화되지 않은 HTTP 입니다.
- 토큰은 기기 키체인/키스토어(expo-secure-store)에 저장됩니다. `todo-devs token rotate` 후에는 다시 페어링해야 합니다.

## 구조

```
src/core/     순수 TypeScript — React 에 의존하지 않음 (Node 로도 실행 가능)
  client.ts   RPC(POST /api/rpc), 롱폴링(GET /api/events/poll), 페어링(POST /api/pair)
  events.ts   EventFeed: 커서 기반 롱폴링 루프, 재연결/서버 재시작 시 reset 알림
  api.ts      사용하는 RPC 메서드의 타입 래퍼 (peer = 원격 세션)
  board.ts    컬럼 그룹핑, 진행률, 흐름 레인, 태스크 액션 규칙
  links.ts    페어링 링크/코드 파싱
src/state/    ConnectionProvider(서버·세션·프로젝트 선택, 피드 수명주기), useLive(이벤트 기반 새로고침)
src/ui/       공용 컴포넌트, 테마
src/app/      expo-router 화면: (tabs)/board · orchestrator · runs · agents · more, task/[id], run/[id], plan/[id], agent/[id], connect, pair
```

실시간 갱신: 앱은 `after=0` 으로 커서를 먼저 받은 뒤 상태를 불러오고, 그 커서부터 롱폴링합니다.
서버 재시작·버퍼 초과·오프라인 복귀 시 `reset` 이 오면 화면이 다시 불러옵니다. 앱이 백그라운드로 가면 폴링을 멈춥니다.

## 알려진 한계

- 푸시 알림 없음 (앱이 열려 있을 때만 실시간 갱신).
- iOS ATS / Android cleartext 예외가 `app.json` 에 설정되어 있습니다(LAN·Tailscale 의 `http://` 접속용). 스토어 배포 시에는 HTTPS 리버스 프록시를 두고 예외를 좁히세요.
