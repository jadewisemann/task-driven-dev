import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { normalizeBaseUrl } from '../core/client.ts';
import { hostOf, isValidCode, normalizeCode } from '../core/links.ts';
import { useConnection } from '../state/connection.tsx';
import { Body, Button, Card, ErrorText, Muted, Screen, Title } from '../ui/components.tsx';
import { colors } from '../ui/theme.ts';

/**
 * Deep link target: todo-devs://pair?url=…&code=…&name=…
 * Nothing happens until the user confirms: any web page or message can carry
 * such a link, and pairing makes that server the one every action goes to.
 */
export default function Pair() {
  const params = useLocalSearchParams<{ url?: string; code?: string; name?: string }>();
  const { pair, ready } = useConnection();
  const [error, setError] = useState<unknown>(null);

  let request: { url: string; code: string; name?: string } | null = null;
  try {
    if (params.url && params.code && isValidCode(String(params.code))) {
      request = { url: normalizeBaseUrl(String(params.url)), code: normalizeCode(String(params.code)), name: params.name ? String(params.name) : undefined };
    }
  } catch {
    request = null;
  }

  if (!request) {
    return (
      <Screen>
        <Title>Invalid pairing link</Title>
        <Body>Create a new one with `todo-devs pair` on your computer.</Body>
        <Button title="Enter a code instead" onPress={() => router.replace('/connect')} />
      </Screen>
    );
  }

  const confirm = async () => {
    setError(null);
    try {
      await pair(request!);
      router.dismissTo('/board');
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Screen>
      <Title>Pair with this server?</Title>
      <Card>
        <Text style={{ color: colors.text, fontSize: 17, fontWeight: '700' }}>{request.name || hostOf(request.url)}</Text>
        <Muted>{request.url}</Muted>
      </Card>
      <Muted small>Only continue if you just created this link with `todo-devs pair` on your own computer. After pairing, everything you do in the app goes to this server.</Muted>
      <ErrorText error={error} />
      <Button testID="pair-confirm" kind="primary" title="Pair" onPress={confirm} disabled={!ready} />
      <Button kind="ghost" title="Cancel" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
    </Screen>
  );
}
