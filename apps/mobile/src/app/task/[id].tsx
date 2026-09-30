import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { COLUMNS, PRIORITY_LABELS, STATUS_COLORS, taskActions, timeAgo } from '../../core/board.ts';
import type { Agent, Run, Task, TaskStatus } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { useLive } from '../../state/useLive.ts';
import { Avatar, Badge, Body, Button, Card, Code, Dot, Empty, ErrorText, Muted, PickerModal, Row, Screen, SectionTitle, Title } from '../../ui/components.tsx';
import { colors } from '../../ui/theme.ts';

interface TaskView {
  task: Task;
  tasks: Task[];
  agents: Agent[];
  runs: Run[];
}

/** Task detail: status, assignee, dependencies, result, and every action a PM would take from a phone. */
export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const [picker, setPicker] = useState<'agent' | 'status' | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const { data, error, refreshing, refresh } = useLive<TaskView>(
    async (a) => {
      const task = await a.tasks.get(String(id));
      const [tasks, agents, runs] = await Promise.all([a.tasks.list(task.projectId), a.agents.list(), a.runs.list({ taskId: task.id, limit: 5 })]);
      return { task, tasks, agents, runs };
    },
    [id],
  );
  const byId = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data?.tasks]);

  if (!data) return <Screen>{error ? <ErrorText error={error} /> : <Empty>Loading…</Empty>}</Screen>;
  const { task, agents, runs } = data;
  const agent = agents.find((a) => a.id === task.assigneeId);
  const actions = taskActions(task, byId);
  const successors = data.tasks.filter((t) => t.dependsOn.includes(task.id));

  const act = (fn: () => Promise<unknown>) => async () => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err);
    }
  };

  const confirmDelete = () =>
    new Promise<void>((resolve) =>
      Alert.alert('Delete task?', task.title, [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            void api.tasks
              .remove(task.id)
              .then(() => router.back())
              .catch(setActionError)
              .finally(resolve),
        },
      ]),
    );

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen options={{ title: task.title.slice(0, 28) }} />
      <Title>{task.title}</Title>
      <Row wrap>
        <Badge label={task.status} color={STATUS_COLORS[task.status]} />
        <Badge label={`priority ${PRIORITY_LABELS[task.priority]}`} />
        <Badge label={`complexity ${task.complexity}/5`} color={colors.accent} />
        {task.attempts > 0 && <Badge label={`attempt ${task.attempts}`} />}
      </Row>
      {task.description ? <Body>{task.description}</Body> : <Muted>No description.</Muted>}

      <Card onPress={() => setPicker('agent')}>
        <Muted small>Assignee (tap to change)</Muted>
        <Row>
          <Avatar name={agent?.name} color={agent?.color} size={30} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.text, fontWeight: '600' }}>{agent ? agent.name : 'Unassigned'}</Text>
            {agent && <Muted small>{`${agent.role} · ${agent.harness}/${agent.model || 'default'} · effort ${agent.effort} · T${agent.tier}`}</Muted>}
          </View>
        </Row>
      </Card>

      <ErrorText error={actionError} />
      <Row wrap>
        {actions.canRun && <Button kind="success" title="▶ Run now" onPress={act(() => api.tasks.run(task.id))} />}
        {actions.canForceRun && <Button title="Run anyway" onPress={act(() => api.tasks.run(task.id, true))} />}
        {actions.canCancel && <Button kind="danger" title="■ Cancel" onPress={act(() => api.tasks.cancel(task.id))} />}
        {actions.canApprove && <Button kind="success" title="Approve" onPress={act(() => api.tasks.move(task.id, 'done'))} />}
        {actions.canRetry && <Button title="↻ Re-queue" onPress={act(() => api.tasks.retry(task.id))} />}
        {actions.canMove && <Button title="Move…" onPress={() => setPicker('status')} />}
      </Row>
      {!task.assigneeId && <Muted small>Assign an agent to run this task.</Muted>}

      {task.error ? (
        <>
          <SectionTitle>Error</SectionTitle>
          <Code maxLines={12}>{task.error}</Code>
        </>
      ) : null}
      {task.result ? (
        <>
          <SectionTitle>Result</SectionTitle>
          {task.result.summary ? <Body>{String(task.result.summary)}</Body> : null}
          <Code maxLines={20}>{JSON.stringify(task.result, null, 2)}</Code>
        </>
      ) : null}

      <SectionTitle>Runs after</SectionTitle>
      {task.dependsOn.length === 0 ? <Muted small>No predecessors.</Muted> : null}
      {task.dependsOn.map((depId) => {
        const dep = byId.get(depId);
        return (
          <Card key={depId} onPress={() => router.push(`/task/${depId}`)}>
            <Row>
              <Dot color={dep ? STATUS_COLORS[dep.status] : colors.muted} />
              <Text style={{ color: colors.text, flex: 1 }}>{dep?.title ?? depId}</Text>
              <Muted small>{dep?.status ?? ''}</Muted>
            </Row>
          </Card>
        );
      })}
      {successors.length > 0 && <SectionTitle>Unblocks</SectionTitle>}
      {successors.map((s) => (
        <Card key={s.id} onPress={() => router.push(`/task/${s.id}`)}>
          <Row>
            <Dot color={STATUS_COLORS[s.status]} />
            <Text style={{ color: colors.text, flex: 1 }}>{s.title}</Text>
          </Row>
        </Card>
      ))}

      <SectionTitle>Runs</SectionTitle>
      {runs.length === 0 ? <Muted small>Not run yet.</Muted> : null}
      {runs.map((r) => (
        <Card key={r.id} onPress={() => router.push(`/run/${r.id}`)}>
          <Row>
            <Text style={{ color: colors.text, flex: 1 }}>{`#${r.attempt} ${r.meta.agentName ?? ''}`}</Text>
            <Badge label={r.status} color={r.status === 'running' ? colors.warn : r.status === 'succeeded' ? colors.accent2 : colors.danger} />
          </Row>
          <Muted small>{timeAgo(r.startedAt)}</Muted>
        </Card>
      ))}
      {task.branch ? <Muted small>{`branch ${task.branch}`}</Muted> : null}
      <Muted small>{`updated ${timeAgo(task.updatedAt)}`}</Muted>
      <Button kind="danger" title="Delete task" onPress={confirmDelete} />

      <PickerModal<Agent | null>
        visible={picker === 'agent'}
        title="Assign to"
        items={[null, ...agents]}
        keyOf={(a) => a?.id ?? 'none'}
        render={(a) => (
          <Row>
            <Avatar name={a?.name} color={a?.color} />
            <View>
              <Text style={{ color: colors.text }}>{a ? a.name : 'Unassigned'}</Text>
              {a && <Muted small>{`${a.role} · T${a.tier} · ${a.model || a.harness}`}</Muted>}
            </View>
          </Row>
        )}
        onPick={(a) => void act(() => api.tasks.assign(task.id, a?.id ?? null))()}
        onClose={() => setPicker(null)}
      />
      <PickerModal<TaskStatus>
        visible={picker === 'status'}
        title="Move to"
        items={COLUMNS.map((c) => c.statuses[0]!)}
        keyOf={(s) => s}
        render={(s) => (
          <Row>
            <Dot color={STATUS_COLORS[s]} />
            <Text style={{ color: colors.text }}>{COLUMNS.find((c) => c.statuses[0] === s)?.title}</Text>
          </Row>
        )}
        onPick={(s) => void act(() => api.tasks.move(task.id, s))()}
        onClose={() => setPicker(null)}
      />
    </Screen>
  );
}
