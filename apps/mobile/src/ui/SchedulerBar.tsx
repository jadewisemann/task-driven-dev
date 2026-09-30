import { View } from 'react-native';
import type { ReviewPolicy, SchedulerStatus } from '../core/types.ts';
import { useSession } from '../state/connection.tsx';
import { useLive } from '../state/useLive.ts';
import { Badge, Button, Muted, Row } from './components.tsx';
import { colors } from './theme.ts';

const STATE_COLOR: Record<SchedulerStatus['state'], string> = { running: colors.warn, waiting: '#b77cff', finished: colors.accent2, stopped: colors.danger, idle: colors.muted };

/** Scheduler state + Run all / Stop for a project. */
export function SchedulerBar({ projectId, reviewPolicy = 'wait' }: { projectId: string; reviewPolicy?: ReviewPolicy }) {
  const { api } = useSession();
  const { data: status, reload } = useLive<SchedulerStatus>((a) => a.scheduler.status(projectId), [projectId], { match: (e) => e.type.startsWith('scheduler.') });
  const live = status?.state === 'running' || status?.state === 'waiting';
  return (
    <View style={{ gap: 6 }}>
      <Row>
        <Badge label={`scheduler ${status?.state ?? '…'}`} color={STATE_COLOR[status?.state ?? 'idle']} />
        {status?.stats ? <Muted small>{`✓${status.stats.succeeded} ✗${status.stats.failed}`}</Muted> : null}
        <View style={{ flex: 1 }} />
        {live ? (
          <Button small kind="danger" title="Stop" onPress={async () => (await api.scheduler.stop(projectId), reload())} />
        ) : (
          <Button small kind="success" title="▶ Run all" onPress={async () => (await api.scheduler.start(projectId, { reviewPolicy }), reload())} />
        )}
      </Row>
      {status?.reason && live ? <Muted small>{status.reason}</Muted> : null}
    </View>
  );
}
