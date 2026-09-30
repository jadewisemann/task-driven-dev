import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import type { Agent, Effort, Harness } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { withSession } from '../../ui/RequireSession.tsx';
import { useLive } from '../../state/useLive.ts';
import { Body, Button, Empty, ErrorText, Input, Muted, Row, Screen, SectionTitle, Segmented, Title } from '../../ui/components.tsx';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'max'];

/** Quick agent tuning from the phone: model, effort, tier. */
function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { data, error } = useLive(async (a) => {
    const [agents, harnesses] = await Promise.all([a.agents.list(), a.agents.harnesses()]);
    return { agent: agents.find((x) => x.id === id) as Agent | undefined, harnesses: harnesses as Harness[] };
  }, [id]);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort>('medium');
  const [tier, setTier] = useState('2');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const agent = data?.agent;

  useEffect(() => {
    if (!agent) return;
    setModel(agent.model);
    setEffort(agent.effort);
    setTier(String(agent.tier));
  }, [agent?.id, agent?.updatedAt]);

  if (!agent) return <Screen>{error ? <ErrorText error={error} /> : <Empty>Loading…</Empty>}</Screen>;
  const harness = data?.harnesses.find((h) => h.id === agent.harness);

  async function save() {
    setSaveError(null);
    setSaved(false);
    try {
      const patch: { model?: string; effort?: Effort; tier?: number } = {};
      if (model !== agent!.model) patch.model = model;
      if (effort !== agent!.effort) patch.effort = effort;
      if (Number(tier) !== agent!.tier) patch.tier = Number(tier);
      if (Object.keys(patch).length) await api.agents.update(agent!.id, patch);
      setSaved(true);
    } catch (err) {
      setSaveError(err);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: agent.name }} />
      <ErrorText error={error} />
      <Title>{agent.name}</Title>
      <Muted>{`${agent.role} · ${harness?.name ?? agent.harness}${harness && !harness.installed ? ' (not installed on the server)' : ''}`}</Muted>
      {agent.persona ? <Body>{agent.persona}</Body> : null}
      <SectionTitle>Model</SectionTitle>
      <Input value={model} onChangeText={setModel} placeholder="model id" />
      {harness?.models.length ? (
        <Segmented options={harness.models.map((m) => ({ value: m, label: m }))} value={model} onChange={setModel} />
      ) : null}
      <SectionTitle>Effort</SectionTitle>
      <Segmented options={EFFORTS.map((e) => ({ value: e, label: e }))} value={effort} onChange={setEffort} />
      <SectionTitle>Tier (used by the orchestrator)</SectionTitle>
      <Segmented options={[{ value: '1', label: 'T1 small' }, { value: '2', label: 'T2 standard' }, { value: '3', label: 'T3 frontier' }]} value={tier} onChange={setTier} />
      <ErrorText error={saveError} />
      <Row>
        <Button kind="primary" title="Save" onPress={save} />
        {saved ? <Muted small>Saved</Muted> : null}
      </Row>
      <Muted small>Persona, harness, context graph and node graph are edited in the web UI.</Muted>
    </Screen>
  );
}

export default withSession(AgentScreen);
