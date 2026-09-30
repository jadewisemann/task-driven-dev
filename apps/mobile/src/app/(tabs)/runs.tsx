import { router } from 'expo-router';
import { Text } from 'react-native';
import { timeAgo } from '../../core/board.ts';
import type { Run } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { useLive } from '../../state/useLive.ts';
import { FeedBanner } from '../../ui/FeedBanner.tsx';
import { Badge, Card, Empty, ErrorText, Muted, Row, Screen } from '../../ui/components.tsx';
import { colors } from '../../ui/theme.ts';

const STATUS_COLOR: Record<string, string> = { running: colors.warn, succeeded: colors.accent2, failed: colors.danger, cancelled: colors.danger, stopped: colors.muted, interrupted: colors.muted };

/** Every agent / workflow / planning run in the project, newest first. */
export default function Runs() {
  const { project } = useSession();
  const pid = project?.id;
  const { data, error, refreshing, refresh } = useLive<Run[]>((a) => (pid ? a.runs.list({ projectId: pid, limit: 100 }) : Promise.resolve([])), [pid], {
    match: (e) => e.type === 'run.started' || e.type === 'run.finished',
  });
  return (
    <>
      <FeedBanner />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <ErrorText error={error} />
        {data && data.length === 0 ? <Empty>No runs yet.</Empty> : null}
        {(data ?? []).map((r) => (
          <Card key={r.id} onPress={() => router.push(`/run/${r.id}`)} accent={STATUS_COLOR[r.status]}>
            <Row>
              <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }} numberOfLines={1}>
                {r.meta.taskTitle || r.meta.workflowName || r.kind}
              </Text>
              <Badge label={r.status} color={STATUS_COLOR[r.status]} />
            </Row>
            <Muted small>{`${r.kind} · ${r.meta.agentName ?? ''} · attempt ${r.attempt} · ${timeAgo(r.startedAt)}`}</Muted>
            {r.error ? (
              <Text style={{ color: '#ff8fa3', fontSize: 12 }} numberOfLines={2}>
                {r.error}
              </Text>
            ) : null}
          </Card>
        ))}
      </Screen>
    </>
  );
}
