import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConnectionProvider } from '../state/connection.tsx';
import { colors } from '../ui/theme.ts';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ConnectionProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.panel },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: '700' },
            contentStyle: { backgroundColor: colors.bg },
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="connect" options={{ title: 'Servers' }} />
          <Stack.Screen name="pair" options={{ title: 'Pairing' }} />
          <Stack.Screen name="task/[id]" options={{ title: 'Task' }} />
          <Stack.Screen name="run/[id]" options={{ title: 'Run' }} />
          <Stack.Screen name="plan/[id]" options={{ title: 'Plan' }} />
          <Stack.Screen name="agent/[id]" options={{ title: 'Agent' }} />
        </Stack>
      </ConnectionProvider>
    </SafeAreaProvider>
  );
}
