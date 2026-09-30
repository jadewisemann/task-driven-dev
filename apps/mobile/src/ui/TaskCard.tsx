import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { PRIORITY_LABELS, STATUS_COLORS, agentLabel, waitingOn } from '../core/board.ts';
import type { Agent, Task } from '../core/types.ts';
import { Avatar, Card, Muted, Row } from './components.tsx';
import { colors } from './theme.ts';

/** Compact card used on the board and in flow lanes. */
export function TaskCard({ task, agents, byId }: { task: Task; agents: Agent[]; byId: Map<string, Task> }) {
  const agent = agents.find((a) => a.id === task.assigneeId);
  const waiting = waitingOn(task, byId);
  const detail =
    task.status === 'running'
      ? `running · attempt ${task.attempts}`
      : task.status === 'failed' || task.status === 'blocked'
        ? (task.error || task.status).split('\n')[0]
        : task.status === 'review'
          ? task.result?.summary || 'awaiting review'
          : task.status === 'done'
            ? task.result?.summary || 'done'
            : waiting.length
              ? `waiting on ${waiting.length} task${waiting.length > 1 ? 's' : ''}`
              : null;
  return (
    <Card accent={STATUS_COLORS[task.status]} onPress={() => router.push(`/task/${task.id}`)}>
      <Row>
        <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }} numberOfLines={2}>
          {task.title}
        </Text>
        {task.priority >= 2 && <Text style={{ color: task.priority === 3 ? colors.danger : colors.warn, fontSize: 11, fontWeight: '700' }}>{PRIORITY_LABELS[task.priority]?.toUpperCase()}</Text>}
      </Row>
      <Row>
        <Avatar name={agent?.name} color={agent?.color} size={20} />
        <Muted small>{agentLabel(agent)}</Muted>
        <View style={{ flex: 1 }} />
        <Text style={{ color: colors.accent, fontSize: 9, letterSpacing: 1 }}>{'●'.repeat(task.complexity)}</Text>
      </Row>
      {detail ? (
        <Text style={{ color: task.status === 'failed' || task.status === 'blocked' ? '#ff8fa3' : colors.muted, fontSize: 12 }} numberOfLines={2}>
          {detail}
        </Text>
      ) : null}
    </Card>
  );
}
