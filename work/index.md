# 작업 기록

작업별 원본은 `work/<작업명>/WORK.md` 하나입니다. 여러 저장소를 수정해도 같은 문서를 사용합니다. [기본 양식](templates/WORK.md)을 복사하고 아래 목록에 연결합니다.

## 작업 목록

- [기본 구조와 부트스트랩 문서 작성](bootstrap/WORK.md)

## 메타데이터

| 필드 | 값과 의미 |
| --- | --- |
| `status` | `planned`, `in-progress`, `paused`, `done`, `cancelled` |
| `scope` | 이번 작업에 포함되는 범위의 목록 |
| `design-impact` | `none`: 설계 영향 없음, `local`: 기존 원칙 내 영역 변경, `system`: 시스템 책임·경계·공통 원칙 변경 |
| `approval` | `not-required`, `pending`, `approved`, `rejected` |
| `repositories` | 실제 변경 대상 저장소 이름의 목록. 문서 작업이면 문서를 관리하는 저장소를 기록 |

`status`는 작업 진행 상태이고 `approval`은 설계 변경 승인 상태입니다. 둘은 별개입니다. 설계 초안 작성 작업은 완료되어도 제안 자체는 승인 대기일 수 있습니다.

`design-impact: system`에는 `approval: not-required`를 사용하지 않습니다. 시스템 설계를 바꾸는 구현은 `approved`일 때만 시작하고, 본문에 승인 대상·승인자·날짜·근거를 남깁니다. 기존 사용자 요청에 구체적인 변경 승인이 포함돼 있으면 그 요청을 근거로 기록합니다.

완료 기준을 충족하면 검증 결과와 한계를 남기고 `done`으로 변경합니다. 취소·완료한 기록도 삭제하지 않습니다. 반복 작업 절차는 실제 반복이 확인되면 `templates/`에 추가합니다.
