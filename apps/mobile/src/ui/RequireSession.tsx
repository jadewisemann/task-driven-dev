import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useConnection } from '../state/connection.tsx';
import { colors } from './theme.ts';

/**
 * Renders children only once saved servers are loaded and one is active, so
 * screens can call useSession() safely — also when opened cold from a deep link.
 */
export function RequireSession({ children }: { children: ReactNode }) {
  const { ready, active } = useConnection();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!active) return <Redirect href="/connect" />;
  return <>{children}</>;
}

/** HOC for route files: `export default withSession(TaskScreen)`. */
export function withSession<P extends object>(Screen: (props: P) => ReactNode) {
  return function Guarded(props: P) {
    return (
      <RequireSession>
        <Screen {...props} />
      </RequireSession>
    );
  };
}
