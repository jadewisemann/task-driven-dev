import { useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { COLUMNS, groupByColumn, progress } from '../../core/board.ts';
import type { Agent, Task } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { useLive } from '../../state/useLive.ts';
import { FeedBanner } from '../../ui/FeedBanner.tsx';
import { SchedulerBar } from '../../ui/SchedulerBar.tsx';
import { TaskCard } from '../../ui/TaskCard.tsx';
import { Button, Empty, ErrorText, Input, Muted, Progress, Row, Screen, Segmented } from '../../ui/components.tsx';

/** Board: one column at a time (column tabs with counts), cards, quick add. */
export default function Board() {
  const { api, project, projectsReady } = useSession();
  const [column, setColumn] = useState('todo');
  const adding = useRef(false);
  const [title, setTitle] = useState('');
  const pid = project?.id;
  const { data, error, refreshing, refresh } = useLive(async (a) => (pid ? { tasks: await a.tasks.list(pid), agents: await a.agents.list() } : { tasks: [] as Task[], agents: [] as Agent[] }), [pid]);
  const tasks = data?.tasks ?? [];
  const agents = data?.agents ?? [];
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const groups = useMemo(() => groupByColumn(tasks), [tasks]);
  const p = progress(tasks);

  if (!pid) return <Empty>{projectsReady ? 'No project on this server yet.' : 'Loading…'}</Empty>;
  const col = COLUMNS.find((c) => c.id === column)!;
  const list = groups[column] ?? [];

  /** Guarded against double submits (keyboard "done" + button). */
  async function add() {
    if (!title.trim() || !pid || adding.current) return;
    adding.current = true;
    try {
      await api.tasks.create({ projectId: pid, title: title.trim(), status: column === 'backlog' ? 'backlog' : 'todo' });
      setTitle('');
    } finally {
      adding.current = false;
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FeedBanner />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <View testID="board-screen" />
        <Row>
          <Muted small>{`${p.done}/${p.total} done`}</Muted>
          <Progress ratio={p.ratio} />
        </Row>
        <SchedulerBar projectId={pid} />
        <Segmented options={COLUMNS.map((c) => ({ value: c.id, label: `${c.title} ${groups[c.id]?.length ?? 0}` }))} value={column} onChange={setColumn} />
        <ErrorText error={error} />
        {list.length === 0 ? <Empty>{`Nothing in ${col.title}.`}</Empty> : list.map((t) => <TaskCard key={t.id} task={t} agents={agents} byId={byId} />)}
        {(column === 'backlog' || column === 'todo') && (
          <Row>
            <View style={{ flex: 1 }}>
              <Input testID="quick-add-input" placeholder={`Add to ${col.title}…`} value={title} onChangeText={setTitle} onSubmitEditing={() => void add().catch(() => {})} returnKeyType="done" />
            </View>
            <Button testID="quick-add-button" title="Add" onPress={add} disabled={!title.trim()} />
          </Row>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}
