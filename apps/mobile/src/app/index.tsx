import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useConnection } from '../state/connection.tsx';
import { colors } from '../ui/theme.ts';

/** Entry: go to the board when a server is paired, otherwise to pairing. */
export default function Index() {
  const { ready, active } = useConnection();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  return <Redirect href={active ? '/board' : '/connect'} />;
}
