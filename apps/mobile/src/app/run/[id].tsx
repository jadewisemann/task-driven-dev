import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { timeAgo } from '../../core/board.ts';
import type { LogLine, Run } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { Badge, Button, ErrorText, Muted, Row, monoFont } from '../../ui/components.tsx';
import { colors } from '../../ui/theme.ts';

const MAX_LINES = 3000;
const STREAM_COLOR = { stdout: colors.text, stderr: '#ff8fa3', system: colors.accent2 };

/**
 * Live log: pages the history in, then appends `run.log` events from the feed.
 * Live lines that arrive while history is loading are buffered and merged by id.
 */
export default function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const runId = String(id);
  const { api, feed } = useSession();
  const [run, setRun] = useState<Run | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<unknown>(null);
  const scroll = useRef<ScrollView>(null);
  const follow = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let lastId = 0;
    let loading = true;
    let pending: LogLine[] = [];
    const append = (incoming: LogLine[]) => {
      const fresh = incoming.filter((l) => l.id > lastId).sort((a, b) => a.id - b.id);
      if (!fresh.length) return;
      lastId = fresh[fresh.length - 1]!.id;
      setLines((prev) => [...prev, ...fresh].slice(-MAX_LINES));
    };
    async function loadHistory() {
      loading = true;
      try {
        for (;;) {
          const page = await api.runs.logs(runId, lastId);
          if (cancelled) return;
          append(page);
          if (page.length < 2000) break;
        }
        setRun(await api.runs.get(runId));
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        loading = false;
        append(pending);
        pending = [];
      }
    }
    const offEvents = feed.subscribe((e) => {
      if (e.type === 'run.log' && e.payload.runId === runId) {
        const line: LogLine = { id: e.payload.id, ts: e.payload.ts, stream: e.payload.stream, text: e.payload.text };
        if (loading) pending.push(line);
        else append([line]);
      } else if (e.type === 'run.finished' && e.payload.run?.id === runId) {
        setRun(e.payload.run as Run);
      }
    });
    const offReset = feed.onReset(() => void loadHistory()); // missed lines after a reconnect
    void loadHistory();
    return () => {
      cancelled = true;
      offEvents();
      offReset();
    };
  }, [api, feed, runId]);

  useEffect(() => {
    if (follow.current) requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
  }, [lines]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, padding: 12, gap: 8 }}>
      <Stack.Screen options={{ title: run?.meta.taskTitle?.slice(0, 28) || run?.meta.workflowName || 'Run' }} />
      <Row wrap>
        <Badge label={run?.status ?? '…'} color={run?.status === 'running' ? colors.warn : run?.status === 'succeeded' ? colors.accent2 : colors.danger} />
        <Muted small>{`${run?.meta.agentName ?? ''} · attempt ${run?.attempt ?? ''} · ${timeAgo(run?.startedAt)}`}</Muted>
        {run?.status === 'running' && <Button small kind="danger" title="Cancel" onPress={() => api.runs.cancel(runId)} />}
      </Row>
      {run?.command ? (
        <Text style={{ color: colors.muted, fontFamily: monoFont, fontSize: 11 }} numberOfLines={2}>
          {run.command}
        </Text>
      ) : null}
      <ErrorText error={error} />
      <ScrollView
        ref={scroll}
        style={{ flex: 1, backgroundColor: '#07080c', borderRadius: 8 }}
        contentContainerStyle={{ padding: 10 }}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          follow.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
        }}
        scrollEventThrottle={200}
      >
        <Text selectable style={{ fontFamily: monoFont, fontSize: 11, lineHeight: 16 }}>
          {lines.map((l) => (
            <Text key={l.id} style={{ color: STREAM_COLOR[l.stream] ?? colors.text }}>
              {l.text}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}
