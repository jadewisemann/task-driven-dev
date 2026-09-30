import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { timeAgo } from '../../core/board.ts';
import type { LogLine, Run } from '../../core/types.ts';
import { useSession } from '../../state/connection.tsx';
import { withSession } from '../../ui/RequireSession.tsx';
import { Badge, Button, ErrorText, Muted, Row, monoFont } from '../../ui/components.tsx';
import { colors } from '../../ui/theme.ts';

const MAX_LINES = 3000;
const PAGE = 2000;
const STREAM_COLOR: Record<LogLine['stream'], string> = { stdout: colors.text, stderr: '#ff8fa3', system: colors.accent2 };

/**
 * Live log: pages the history in, then appends `run.log` events from the feed.
 * - only the newest history load may write (a reset mid-load restarts it cleanly);
 * - live lines arriving meanwhile are buffered and merged by id;
 * - appends are batched per frame and rendered in a virtualized list.
 */
function RunScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const runId = String(id);
  const { api, feed } = useSession();
  const [run, setRun] = useState<Run | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<unknown>(null);
  const list = useRef<FlatList<LogLine>>(null);
  const follow = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let lastId = 0;
    let loadSeq = 0;
    let loading = false;
    let pending: LogLine[] = [];
    let batch: LogLine[] = [];
    let frame: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      frame = null;
      const fresh = batch.filter((l) => l.id > lastId).sort((a, b) => a.id - b.id);
      batch = [];
      if (!fresh.length || cancelled) return;
      lastId = fresh[fresh.length - 1]!.id;
      setLines((prev) => [...prev, ...fresh].slice(-MAX_LINES));
    };
    const append = (incoming: LogLine[], now = false) => {
      batch.push(...incoming);
      if (now) flush();
      else if (!frame) frame = setTimeout(flush, 100);
    };

    async function loadHistory() {
      const mine = ++loadSeq;
      loading = true;
      try {
        for (;;) {
          const page = await api.runs.logs(runId, lastId);
          if (cancelled || mine !== loadSeq) return;
          append(page, true);
          if (page.length < PAGE) break;
        }
        const r = await api.runs.get(runId);
        if (!cancelled && mine === loadSeq) setRun(r);
      } catch (err) {
        if (!cancelled && mine === loadSeq) setError(err);
      } finally {
        if (mine === loadSeq) {
          loading = false;
          append(pending);
          pending = [];
        }
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
    const offReset = feed.onReset(() => void loadHistory()); // catch up on lines missed while offline
    void loadHistory();
    return () => {
      cancelled = true;
      if (frame) clearTimeout(frame);
      offEvents();
      offReset();
    };
  }, [api, feed, runId]);

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
      <FlatList
        ref={list}
        data={lines}
        keyExtractor={(l) => String(l.id)}
        style={{ flex: 1, backgroundColor: '#07080c', borderRadius: 8 }}
        contentContainerStyle={{ padding: 10 }}
        renderItem={({ item }) => (
          <Text selectable style={{ fontFamily: monoFont, fontSize: 11, lineHeight: 16, color: STREAM_COLOR[item.stream] ?? colors.text }}>
            {item.text.replace(/\n$/, '')}
          </Text>
        )}
        onContentSizeChange={() => follow.current && list.current?.scrollToEnd({ animated: false })}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          follow.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40;
        }}
        scrollEventThrottle={200}
        initialNumToRender={60}
        windowSize={8}
      />
    </View>
  );
}

export default withSession(RunScreen);
