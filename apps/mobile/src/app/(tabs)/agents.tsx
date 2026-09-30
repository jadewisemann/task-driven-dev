import { router } from 'expo-router';
import { Text, View } from 'react-native';
import type { Agent } from '../../core/types.ts';
import { useLive } from '../../state/useLive.ts';
import { FeedBanner } from '../../ui/FeedBanner.tsx';
import { Avatar, Badge, Card, ErrorText, Muted, Row, Screen } from '../../ui/components.tsx';
import { colors } from '../../ui/theme.ts';

const TIER_LABEL = ['', 'small', 'standard', 'frontier'];

/** The team. Tap an agent to adjust model / effort. Full editing lives in the web UI. */
export default function Agents() {
  const { data, error, refreshing, refresh } = useLive<Agent[]>((a) => a.agents.list(), [], { match: (e) => e.type.startsWith('agent.') });
  return (
    <>
      <FeedBanner />
      <Screen refreshing={refreshing} onRefresh={refresh}>
        <ErrorText error={error} />
        {(data ?? []).map((a) => (
          <Card key={a.id} accent={a.color} onPress={() => router.push(`/agent/${a.id}`)}>
            <Row>
              <Avatar name={a.name} color={a.color} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>{a.name}</Text>
                <Muted small>{a.role}</Muted>
              </View>
              <Badge label={`T${a.tier} ${TIER_LABEL[a.tier]}`} color={a.tier === 3 ? colors.accent : a.tier === 2 ? colors.info : colors.accent2} />
            </Row>
            <Muted small>{`${a.harness} · ${a.model || 'default'} · effort ${a.effort} · ${a.config.autonomy}`}</Muted>
            {a.persona ? (
              <Text style={{ color: '#c3c7d4', fontSize: 13 }} numberOfLines={2}>
                {a.persona}
              </Text>
            ) : null}
          </Card>
        ))}
      </Screen>
    </>
  );
}
