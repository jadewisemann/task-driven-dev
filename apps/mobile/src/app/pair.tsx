import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { normalizeBaseUrl } from '../core/client.ts';
import { normalizeCode } from '../core/links.ts';
import { useConnection } from '../state/connection.tsx';
import { Body, Button, ErrorText, Screen, Title } from '../ui/components.tsx';
import { colors } from '../ui/theme.ts';

/** Deep link target: todo-devs://pair?url=…&code=…&name=… */
export default function Pair() {
  const params = useLocalSearchParams<{ url?: string; code?: string; name?: string }>();
  const { pair, ready } = useConnection();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true; // a one-time code must be redeemed once, even if the screen re-renders
    (async () => {
      try {
        if (!params.url || !params.code) throw new Error('This pairing link is incomplete');
        await pair({ url: normalizeBaseUrl(String(params.url)), code: normalizeCode(String(params.code)), name: params.name ? String(params.name) : undefined });
        router.replace('/board');
      } catch (err) {
        setError(err);
      }
    })();
  }, [ready, params.url, params.code, params.name, pair]);

  return (
    <Screen>
      <Title>Pairing{params.name ? ` with ${params.name}` : ''}</Title>
      {!error ? <ActivityIndicator color={colors.accent} /> : null}
      <Body>{params.url ? String(params.url) : ''}</Body>
      <ErrorText error={error} />
      {error ? <Button title="Enter a new code" onPress={() => router.replace('/connect')} /> : null}
    </Screen>
  );
}
