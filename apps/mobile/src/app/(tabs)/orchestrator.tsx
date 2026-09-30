import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Switch, Text, View } from 'react-native';
import { PLAN_STATUS_LABEL, STATUS_COLORS, lanes, progress, timeAgo } from '../../core/board.ts';
import type { Agent, Plan, ReviewPolicy, TaskGraph } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { useLive } from '../../state/useLive.ts';
import { FeedBanner } from '../../ui/FeedBanner.tsx';
import { SchedulerBar } from '../../ui/SchedulerBar.tsx';
import { TaskCard } from '../../ui/TaskCard.tsx';
import { Badge, Button, Card, Empty, ErrorText, Input, Muted, Progress, Row, Screen, SectionTitle } from '../../ui/components.tsx';
import { colors } from '../../ui/theme.ts';

const OPEN = new Set(['planning', 'draft', 'failed']);

/**
 * Orchestrator mode from the phone: describe a goal, let the orchestrator plan
 * and assign it, then follow the dependency flow lane by lane.
 */
export default function Orchestrator() {
  const { api, project } = useSession();
  const pid = project?.id;
  const [goal, setGoal] = useState('');
  const [autoRun, setAutoRun] = useState(true);
  const [autoApprove, setAutoApprove] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const { data, refreshing, refresh } = useLive(
    async (a) => (pid ? { plans: await a.orchestrator.list(pid), graph: await a.tasks.graph(pid), agents: await a.agents.list() } : null),
    [pid],
  );
  const graph: TaskGraph | undefined = data?.graph;
  const agents: Agent[] = data?.agents ?? [];
  const byId = useMemo(() => new Map((graph?.tasks ?? []).map((t) => [t.id, t])), [graph]);
  if (!pid) return <Empty>No project on this server yet.</Empty>;
  const plans: Plan[] = data?.plans ?? [];
  const open = plans.filter((p) => OPEN.has(p.status));
  const history = plans.filter((p) => !OPEN.has(p.status)).slice(0, 8);
  const p = progress(graph?.tasks ?? []);
  const reviewPolicy: ReviewPolicy = autoApprove ? 'auto-approve' : 'wait';

  async function submit() {
    setError(null);
    try {
      const plan = await api.orchestrator.plan({ projectId: pid!, goal: goal.trim(), autoRun, reviewPolicy });
      setGoal('');
      if (!autoRun) router.push(`/plan/${plan.id}`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <FeedBanner />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <Card>
          <Text style={{ color: colors.text, fontWeight: '700' }}>What should the team build?</Text>
          <Input multiline placeholder="e.g. 로그인 API를 만들고 그 다음 로그인 화면, 그리고 테스트 작성" value={goal} onChangeText={setGoal} />
          <Row>
            <Switch value={autoRun} onValueChange={setAutoRun} />
            <Muted small>Start as soon as it is planned</Muted>
          </Row>
          <Row>
            <Switch value={autoApprove} onValueChange={setAutoApprove} />
            <Muted small>Keep going when an agent asks for review</Muted>
          </Row>
          <ErrorText error={error} />
          <Button kind="primary" title={autoRun ? '✦ Plan & run' : 'Plan'} onPress={submit} disabled={!goal.trim()} />
        </Card>

        {open.map((plan) => (
          <Card key={plan.id} onPress={() => router.push(`/plan/${plan.id}`)} accent={plan.status === 'failed' ? colors.danger : colors.accent}>
            <Row>
              <Badge label={PLAN_STATUS_LABEL[plan.status]} color={plan.status === 'failed' ? colors.danger : colors.accent} />
              <Muted small>{timeAgo(plan.createdAt)}</Muted>
            </Row>
            <Text style={{ color: colors.text }} numberOfLines={2}>
              {plan.goal}
            </Text>
            {plan.status === 'draft' && <Muted small>{`${plan.plan.tasks.length} tasks — tap to review`}</Muted>}
          </Card>
        ))}

        <SectionTitle>Flow</SectionTitle>
        <Row>
          <Muted small>{`${p.done}/${p.total} done · ${p.running} running · ${p.failed} failed · ${p.review} review`}</Muted>
        </Row>
        <Progress ratio={p.ratio} />
        <SchedulerBar projectId={pid} reviewPolicy={reviewPolicy} />
        {graph && graph.tasks.length === 0 ? <Empty>No tasks yet — describe a goal above.</Empty> : null}
        {graph
          ? lanes(graph).map((lane, i) => (
              <View key={i} style={{ gap: 6 }}>
                <Row>
                  <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.panel2, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: colors.muted, fontSize: 11 }}>{i + 1}</Text>
                  </View>
                  <Muted small>{i === 0 ? 'can start now' : `after step ${i}`}</Muted>
                  <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
                  {lane.map((t) => (
                    <View key={t.id} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: STATUS_COLORS[t.status] }} />
                  ))}
                </Row>
                {lane.map((t) => (
                  <TaskCard key={t.id} task={t} agents={agents} byId={byId} />
                ))}
              </View>
            ))
          : null}

        {history.length > 0 && <SectionTitle>Plans</SectionTitle>}
        {history.map((plan) => (
          <Card key={plan.id} onPress={() => router.push(`/plan/${plan.id}`)}>
            <Row>
              <Badge label={PLAN_STATUS_LABEL[plan.status]} color={plan.status === 'finished' ? colors.accent2 : plan.status === 'incomplete' ? colors.danger : colors.muted} />
              <Muted small>{`${plan.taskIds.length} tasks · ${timeAgo(plan.createdAt)}`}</Muted>
            </Row>
            <Text style={{ color: colors.text }} numberOfLines={2}>
              {plan.goal}
            </Text>
          </Card>
        ))}
      </Screen>
    </KeyboardAvoidingView>
  );
}
