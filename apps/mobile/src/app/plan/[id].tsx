import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Switch, Text, View } from 'react-native';
import { PLAN_STATUS_LABEL } from '../../core/board.ts';
import type { Agent, Plan, PlanTask } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { useLive } from '../../state/useLive.ts';
import { Avatar, Badge, Body, Button, Card, Code, Empty, ErrorText, Input, Muted, PickerModal, Row, Screen, SectionTitle, Title } from '../../ui/components.tsx';
import { withSession } from '../../ui/RequireSession.tsx';
import { colors } from '../../ui/theme.ts';

/**
 * Review a plan before it runs: every task, its agent (changeable), its
 * dependencies and — importantly — the description the agent will be given.
 */
function PlanScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { data, error, refreshing, refresh } = useLive(async (a) => ({ plan: await a.orchestrator.get(String(id)), agents: await a.agents.list() }), [id], {
    match: (e) => e.type === 'plan.updated' && e.payload.plan?.id === id,
  });
  const [edits, setEdits] = useState<PlanTask[] | null>(null);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(true);
  const [actionError, setActionError] = useState<unknown>(null);

  const plan: Plan | undefined = data?.plan;
  const agents: Agent[] = data?.agents ?? [];
  // Start editing from the server's draft; keep local edits while the user works.
  useEffect(() => {
    if (plan?.status === 'draft' && !edits) setEdits(plan.plan.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] })));
  }, [plan, edits]);

  if (!plan) return <Screen>{error ? <ErrorText error={error} /> : <Empty>Loading…</Empty>}</Screen>;
  const tasks = plan.status === 'draft' ? (edits ?? plan.plan.tasks) : plan.plan.tasks;
  const editable = plan.status === 'draft';
  const update = (key: string, patch: Partial<PlanTask>) => setEdits((prev) => (prev ?? []).map((t) => (t.key === key ? { ...t, ...patch } : t)));
  const remove = (key: string) => setEdits((prev) => (prev ?? []).filter((t) => t.key !== key).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== key) })));

  const act = (fn: () => Promise<unknown>, after?: () => void) => async () => {
    setActionError(null);
    try {
      await fn();
      after?.();
    } catch (err) {
      setActionError(err);
    }
  };

  return (
    <Screen refreshing={refreshing} onRefresh={refresh}>
      <Stack.Screen options={{ title: 'Plan' }} />
      <Row>
        <Badge label={PLAN_STATUS_LABEL[plan.status]} color={plan.status === 'failed' || plan.status === 'incomplete' ? colors.danger : colors.accent} />
        <Muted small>{plan.source === 'agent' ? 'planned by the orchestrator model' : plan.source === 'heuristic' ? 'built-in planner' : ''}</Muted>
      </Row>
      <ErrorText error={error} />
      <Title>{plan.goal}</Title>
      {plan.status === 'planning' && (
        <Row>
          <ActivityIndicator color={colors.accent} />
          <Muted>The orchestrator is planning…</Muted>
        </Row>
      )}
      {plan.plan.warnings?.map((w, i) => (
        <Text key={i} style={{ color: colors.warn, fontSize: 12 }}>
          {`! ${w}`}
        </Text>
      ))}
      {plan.summary ? <Code>{plan.summary}</Code> : null}

      {tasks.length > 0 && <SectionTitle>{`Tasks (${tasks.length})`}</SectionTitle>}
      {tasks.map((t) => {
        const agent = agents.find((a) => a.id === t.agentId);
        return (
          <Card key={t.key} onPress={() => setExpanded(expanded === t.key ? null : t.key)}>
            <Row>
              <Muted small>{t.key}</Muted>
              <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }}>{t.title}</Text>
              <Badge label={`c${t.complexity}`} color={colors.accent} />
            </Row>
            <Row>
              <Avatar name={agent?.name} color={agent?.color} size={20} />
              <Muted small>{agent ? `${agent.name} (T${agent.tier})` : 'auto — cheapest capable'}</Muted>
              {t.dependsOn.length ? <Muted small>{`· after ${t.dependsOn.join(', ')}`}</Muted> : null}
            </Row>
            {t.assignReason ? <Muted small>{t.assignReason}</Muted> : null}
            {expanded === t.key &&
              (editable ? (
                <View style={{ gap: 6 }}>
                  <Input label="Title" value={t.title} onChangeText={(v) => update(t.key, { title: v })} />
                  <Input label="Instructions for the agent" multiline value={t.description} onChangeText={(v) => update(t.key, { description: v })} />
                  <Row wrap>
                    {[1, 2, 3, 4, 5].map((c) => (
                      <Button key={c} small kind={c === t.complexity ? 'primary' : 'default'} title={`c${c}`} onPress={() => update(t.key, { complexity: c })} />
                    ))}
                  </Row>
                  <Row wrap>
                    <Button small title="Change agent" onPress={() => setPickFor(t.key)} />
                    <Button small kind="danger" title="Remove" onPress={() => remove(t.key)} />
                  </Row>
                </View>
              ) : (
                <Body>{t.description}</Body>
              ))}
          </Card>
        );
      })}

      <ErrorText error={actionError} />
      {editable && (
        <>
          <Row>
            <Switch value={autoApprove} onValueChange={setAutoApprove} />
            <Muted small>Keep going when an agent asks for review</Muted>
          </Row>
          <Button kind="primary" title="▶ Run plan" onPress={act(() => api.orchestrator.run(plan.id, { tasks: edits ?? undefined, reviewPolicy: autoApprove ? 'auto-approve' : 'wait' }), () => router.back())} />
          <Button title="Add to board only" onPress={act(() => api.orchestrator.apply(plan.id, edits ?? undefined), () => router.back())} />
        </>
      )}
      {(editable || plan.status === 'failed' || plan.status === 'planning') && <Button kind="danger" title={plan.status === 'planning' ? 'Cancel planning' : 'Discard'} onPress={act(() => api.orchestrator.discard(plan.id), () => router.back())} />}
      {['applied', 'incomplete'].includes(plan.status) && <Button kind="success" title="▶ Run" onPress={act(() => api.orchestrator.run(plan.id, { reviewPolicy: autoApprove ? 'auto-approve' : 'wait' }))} />}

      <PickerModal<Agent | null>
        visible={pickFor !== null}
        title="Assign to"
        items={[null, ...agents]}
        keyOf={(a) => a?.id ?? 'auto'}
        render={(a) => (
          <Row>
            <Avatar name={a?.name} color={a?.color} />
            <Text style={{ color: colors.text }}>{a ? `${a.name} · ${a.role} · T${a.tier}` : 'Auto (cheapest capable)'}</Text>
          </Row>
        )}
        onPick={(a) => pickFor && update(pickFor, { agentId: a?.id ?? null, assignReason: a ? 'chosen by you' : '' })}
        onClose={() => setPickFor(null)}
      />
    </Screen>
  );
}

export default withSession(PlanScreen);
