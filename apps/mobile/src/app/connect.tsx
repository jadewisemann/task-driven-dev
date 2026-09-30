import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import { normalizeBaseUrl } from '../core/client.ts';
import { isValidCode, normalizeCode, parsePairingLink } from '../core/links.ts';
import { useConnection } from '../state/connection.tsx';
import { Badge, Body, Button, Card, ErrorText, Input, Muted, Row, Screen, SectionTitle, Title } from '../ui/components.tsx';
import { colors } from '../ui/theme.ts';

/**
 * Pair a server: paste the link printed by `todo-devs pair`, or type the
 * address and the one-time code. Also lists and switches paired servers.
 */
export default function Connect() {
  const { servers, active, pair, switchServer, removeServer } = useConnection();
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function submit(request?: { url: string; code: string; name?: string }) {
    setError(null);
    try {
      const req = request ?? { url: normalizeBaseUrl(url), code: normalizeCode(code) };
      if (!isValidCode(req.code)) throw new Error('The pairing code has 10 letters/digits — run `todo-devs pair` on the computer');
      await pair(req);
      router.replace('/board');
    } catch (err) {
      setError(err);
    }
  }

  async function pasteLink() {
    const text = await Clipboard.getStringAsync();
    const req = parsePairingLink(text);
    if (!req) return setError(new Error('The clipboard does not contain a todo.devs pairing link'));
    setUrl(req.url);
    setCode(req.code);
    await submit(req);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen>
        <Title>Pair a todo.devs server</Title>
        <Body>On your computer run the server on the network, then create a one-time code:</Body>
        <Card>
          <Text style={{ color: colors.accent2, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) }}>todo-devs serve --host 0.0.0.0{'\n'}todo-devs pair</Text>
        </Card>
        <Muted small>Open the “app:” link on this phone, or paste it here. Prefer the Tailscale address when you are not on the same Wi‑Fi.</Muted>
        <Button title="Paste pairing link" kind="primary" onPress={pasteLink} />
        <SectionTitle>Or enter it manually</SectionTitle>
        <Input label="Server address" placeholder="100.64.0.2:7420" value={url} onChangeText={setUrl} keyboardType="url" />
        <Input label="Pairing code" placeholder="ABCDE-FGHJK" value={code} onChangeText={setCode} autoCapitalize="characters" />
        <ErrorText error={error} />
        <Button title="Pair" onPress={() => submit()} disabled={!url || !code} />

        {servers.length > 0 && <SectionTitle>Paired servers</SectionTitle>}
        {servers.map((s) => (
          <Card key={s.id} onPress={() => (switchServer(s.id), router.replace('/board'))} accent={s.id === active?.id ? colors.accent2 : undefined}>
            <Row>
              <Text style={{ color: colors.text, fontWeight: '600', flex: 1 }}>{s.name}</Text>
              {s.id === active?.id && <Badge label="active" color={colors.accent2} />}
            </Row>
            <Muted small>{s.url}</Muted>
            <View style={{ alignSelf: 'flex-start' }}>
              <Button
                small
                kind="danger"
                title="Forget"
                onPress={() =>
                  new Promise<void>((resolve) =>
                    Alert.alert('Forget server?', `${s.name} will need to be paired again.`, [
                      { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
                      { text: 'Forget', style: 'destructive', onPress: () => void removeServer(s.id).then(resolve) },
                    ]),
                  )
                }
              />
            </View>
          </Card>
        ))}
      </Screen>
    </KeyboardAvoidingView>
  );
}
