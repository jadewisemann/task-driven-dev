import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useConnection } from '../../state/connection.tsx';
import { colors } from '../../ui/theme.ts';

type IconName = keyof typeof Ionicons.glyphMap;
const icon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} color={color} size={size} />;

/** Tab bar for a connected server. Each tab screen renders <FeedBanner/> itself. */
export default function TabsLayout() {
  const { ready, active, project, peer } = useConnection();
  if (!ready) return null;
  if (!active) return <Redirect href="/connect" />;
  const subtitle = `${project?.name ?? '…'}${peer ? ' · remote' : ''}`;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.panel },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '700' },
        tabBarStyle: { backgroundColor: colors.panel, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
      }}
    >
      <Tabs.Screen name="board" options={{ title: 'Board', headerTitle: subtitle, tabBarIcon: icon('grid-outline') }} />
      <Tabs.Screen name="orchestrator" options={{ title: 'Orchestrator', tabBarIcon: icon('sparkles-outline') }} />
      <Tabs.Screen name="runs" options={{ title: 'Runs', tabBarIcon: icon('pulse-outline') }} />
      <Tabs.Screen name="agents" options={{ title: 'Agents', tabBarIcon: icon('people-outline') }} />
      <Tabs.Screen name="more" options={{ title: 'More', headerTitle: active.name, tabBarIcon: icon('ellipsis-horizontal') }} />
    </Tabs>
  );
}
