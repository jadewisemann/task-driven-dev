import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import type { Peer, Workflow } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { useLive } from '../../state/useLive.ts';
import { FeedBanner } from '../../ui/FeedBanner.tsx';
import { Badge, Button, Card, Dot, ErrorText, Input, Muted, Row, Screen, SectionTitle, monoFont } from '../../ui/components.tsx';
import { colors } from '../../ui/theme.ts';

const FEEDBACK_URL = 'https://github.com/jadewisemann/task-driven-dev/issues/new/choose';

const PEER_COLOR: Record<Peer['status']['state'], string> = { connected: colors.accent2, connecting: colors.warn, error: colors.danger, disconnected: colors.muted };

/** Server & session switching, projects, and running project workflows with JSON input. */
export default function More() {
  const { api, active, servers, switchServer, projects, project, selectProject, peer, selectPeer } = useSession();
  const [sessionError, setSessionError] = useState<unknown>(null);
  // In a remote session the feed only carries that machine's events, so peer status is also polled.
  const peersQuery = useLive<Peer[]>((a) => a.peers.list(), [], { match: (e) => e.type.startsWith('peer.'), intervalMs: 15_000 });
  const pid = project?.id;
  const workflowsQuery = useLive<Workflow[]>((a) => (pid ? a.workflows.list(pid) : Promise.resolve([])), [pid], { match: (e) => e.type.startsWith('workflow.') });

  const choosePeer = async (id: string | null) => {
    setSessionError(null);
    try {
      await selectPeer(id);
    } catch (err) {
      setSessionError(err);
    }
  };

  return (
    <>
      <FeedBanner />
      <Screen refreshing={peersQuery.refreshing} onRefresh={peersQuery.refresh}>
        <SectionTitle>Session</SectionTitle>
        <Muted small>Control this server, or another machine it reaches over SSH.</Muted>
        <Card onPress={() => choosePeer(null)} accent={!peer ? colors.accent2 : undefined}>
          <Row>
            <Dot color={colors.accent2} />
            <Text style={{ color: colors.text, flex: 1 }}>{`${active.name} (this server)`}</Text>
            {!peer && <Badge label="active" color={colors.accent2} />}
          </Row>
        </Card>
        {(peersQuery.data ?? []).map((p) => (
          <Card key={p.id} onPress={() => choosePeer(p.id)} accent={peer === p.id ? colors.accent2 : undefined}>
            <Row>
              <Dot color={PEER_COLOR[p.status.state]} />
              <Text style={{ color: colors.text, flex: 1 }}>{p.name}</Text>
              {peer === p.id && <Badge label="active" color={colors.accent2} />}
            </Row>
            <Muted small>{`${p.transport} ${p.target}${p.status.info?.host ? ` · ${p.status.info.host}` : ''}`}</Muted>
            {p.status.error ? <Muted small>{p.status.error}</Muted> : null}
          </Card>
        ))}
        <ErrorText error={sessionError} />

        <SectionTitle>Project</SectionTitle>
        {projects.map((p) => (
          <Card key={p.id} onPress={() => void selectProject(p.id)} accent={p.id === project?.id ? colors.accent : undefined}>
            <Text style={{ color: colors.text }}>{p.name}</Text>
            {p.description ? <Muted small>{p.description}</Muted> : null}
          </Card>
        ))}

        <SectionTitle>Workflows</SectionTitle>
        {(workflowsQuery.data ?? []).length === 0 ? <Muted small>No project workflows. Build them in the web UI.</Muted> : null}
        {(workflowsQuery.data ?? []).map((wf) => (pid ? <WorkflowRunner key={wf.id} workflow={wf} projectId={pid} run={api.workflows.run} /> : null))}

        <SectionTitle>Servers</SectionTitle>
        {servers.map((s) => (
          <Card key={s.id} onPress={() => void switchServer(s.id)} accent={s.id === active.id ? colors.accent2 : undefined}>
            <Text style={{ color: colors.text }}>{s.name}</Text>
            <Muted small>{s.url}</Muted>
          </Card>
        ))}
        <Button title="Pair another server" onPress={() => router.push('/connect')} />

        <SectionTitle>About</SectionTitle>
        <Card>
          <Text style={{ color: colors.text, fontWeight: '600' }}>{`todo.devs ${Constants.expoConfig?.version ?? ''} · ${(Constants.expoConfig?.extra as { channel?: string } | undefined)?.channel ?? ''}`}</Text>
          <Muted small>Alpha build — expect rough edges. Reports help a lot: include what you did, what you expected, and `todo-devs doctor` from the computer.</Muted>
          <Button small kind="primary" title="Report an issue" onPress={() => Linking.openURL(FEEDBACK_URL)} />
        </Card>
      </Screen>
    </>
  );
}

/** Runs a project workflow with a JSON input (prefilled from its Start node sample). */
function WorkflowRunner({ workflow, projectId, run }: { workflow: Workflow; projectId: string; run: (id: string, projectId: string, input: unknown) => Promise<{ runId: string; status: string }> }) {
  const sample = workflow.graph.nodes.find((n) => n.type === 'trigger')?.config?.sample ?? {};
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(JSON.stringify(sample, null, 2));
  const [error, setError] = useState<unknown>(null);
  /** Starts the run and opens its live log (workflows with agents can take minutes). */
  async function go() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return setError(new Error('Input must be valid JSON'));
    }
    try {
      const res = await run(workflow.id, projectId, parsed);
      router.push(`/run/${res.runId}`);
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Card onPress={() => setOpen(!open)}>
      <Text style={{ color: colors.text, fontWeight: '600' }}>{workflow.name}</Text>
      {workflow.description ? <Muted small>{workflow.description}</Muted> : null}
      {open && (
        <View style={{ gap: 6 }}>
          <Input label="Input JSON" multiline value={input} onChangeText={setInput} style={{ fontFamily: monoFont }} />
          <Button kind="success" title="▶ Run workflow" onPress={go} />
          <ErrorText error={error} />
        </View>
      )}
    </Card>
  );
}
