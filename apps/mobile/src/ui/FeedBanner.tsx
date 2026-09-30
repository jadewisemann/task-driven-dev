import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { useConnection } from '../state/connection.tsx';
import { colors } from './theme.ts';

/** Thin banner under the header when the live connection is not healthy. */
export function FeedBanner() {
  const { feedStatus, feedError } = useConnection();
  if (feedStatus === 'live' || feedStatus === 'stopped') return null;
  const text = {
    connecting: 'Connecting…',
    offline: `Offline — retrying${feedError ? ` (${feedError})` : ''}`,
    unauthorized: 'Access was revoked (token rotated). Tap to pair again.',
  }[feedStatus];
  return (
    <Pressable onPress={feedStatus === 'unauthorized' ? () => router.push('/connect') : undefined} style={{ backgroundColor: feedStatus === 'connecting' ? colors.panel2 : '#3a1420', paddingVertical: 6, paddingHorizontal: 12 }}>
      <Text style={{ color: feedStatus === 'connecting' ? colors.muted : '#ffb3c1', fontSize: 12 }} numberOfLines={2}>
        {text}
      </Text>
    </Pressable>
  );
}
