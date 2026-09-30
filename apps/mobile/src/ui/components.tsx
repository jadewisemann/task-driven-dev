import { type ReactNode, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { initials } from '../core/board.ts';
import { colors, radius, space } from './theme.ts';

export const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Scrollable screen body with pull-to-refresh. */
export function Screen({ children, refreshing = false, onRefresh, scroll = true, padded = true }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; scroll?: boolean; padded?: boolean }) {
  const content = <View style={padded ? styles.padded : undefined}>{children}</View>;
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right']}>
      {scroll ? (
        <ScrollView keyboardShouldPersistTaps="handled" refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.muted} /> : undefined}>
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

export function Card({ children, onPress, style, accent }: { children: ReactNode; onPress?: () => void; style?: ViewStyle; accent?: string }) {
  const body = <View style={[styles.card, accent ? { borderLeftColor: accent, borderLeftWidth: 4 } : null, style]}>{children}</View>;
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

type ButtonKind = 'primary' | 'success' | 'danger' | 'ghost' | 'default';
const BUTTON_BG: Record<ButtonKind, string> = { primary: colors.accent, success: '#1f7a5c', danger: 'transparent', ghost: 'transparent', default: colors.panel2 };

/**
 * Button that shows a spinner and blocks double taps while its async action
 * runs. Errors that reach it are shown in an alert (never an unhandled rejection).
 */
export function Button({ title, onPress, kind = 'default', disabled, small }: { title: string; onPress: () => unknown; kind?: ButtonKind; disabled?: boolean; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const press = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onPress();
    } catch (err) {
      Alert.alert('Something went wrong', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const off = disabled || busy;
  return (
    <Pressable
      onPress={press}
      disabled={off}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: BUTTON_BG[kind], borderColor: kind === 'danger' ? colors.danger : kind === 'primary' ? colors.accent : colors.border },
        (pressed || off) && { opacity: 0.6 },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={[styles.buttonText, small && { fontSize: 13 }, kind === 'danger' && { color: colors.danger }]}>{title}</Text>}
    </Pressable>
  );
}

export const Row = ({ children, gap = space.sm, wrap = false, style }: { children: ReactNode; gap?: number; wrap?: boolean; style?: ViewStyle }) => (
  <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>
);

export const Title = ({ children }: { children: ReactNode }) => <Text style={styles.title}>{children}</Text>;
export const Muted = ({ children, small }: { children: ReactNode; small?: boolean }) => <Text style={[styles.muted, small && { fontSize: 12 }]}>{children}</Text>;
export const Body = ({ children }: { children: ReactNode }) => <Text style={styles.body}>{children}</Text>;
export const SectionTitle = ({ children }: { children: ReactNode }) => <Text style={styles.section}>{children}</Text>;

export const Badge = ({ label, color = colors.muted }: { label: string; color?: string }) => (
  <View style={[styles.badge, { borderColor: color }]}>
    <Text style={[styles.badgeText, { color }]}>{label}</Text>
  </View>
);

export const Dot = ({ color, size = 8 }: { color: string; size?: number }) => <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;

export function Avatar({ name, color, size = 26 }: { name?: string; color?: string; size?: number }) {
  if (!name) {
    return (
      <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.muted }]}>
        <Text style={{ color: colors.muted, fontSize: size * 0.42 }}>?</Text>
      </View>
    );
  }
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: color || colors.accent }]}>
      <Text style={{ color: colors.bg, fontWeight: '700', fontSize: size * 0.42 }}>{initials(name)}</Text>
    </View>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => (
  <View style={{ padding: space.xl, alignItems: 'center' }}>
    <Text style={styles.muted}>{children}</Text>
  </View>
);

export const ErrorText = ({ error }: { error: unknown }) => (error ? <Text style={styles.error}>{error instanceof Error ? error.message : String(error)}</Text> : null);

export const Code = ({ children, maxLines }: { children: ReactNode; maxLines?: number }) => (
  <Text style={styles.code} numberOfLines={maxLines} selectable>
    {children}
  </Text>
);

export function Input(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 4, marginBottom: space.sm }}>
      {label ? <Muted small>{label}</Muted> : null}
      <TextInput placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} {...rest} style={[styles.input, rest.multiline && { minHeight: 90, textAlignVertical: 'top' }, style]} />
    </View>
  );
}

/** Horizontal segmented control (also used as scrollable column tabs). */
export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[styles.segment, o.value === value && styles.segmentActive]}>
          <Text style={[styles.segmentText, o.value === value && { color: '#fff' }]}>{o.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

/** Bottom-sheet style picker. */
export function PickerModal<T>({ visible, title, items, keyOf, render, onPick, onClose }: { visible: boolean; title: string; items: T[]; keyOf: (item: T) => string; render: (item: T) => ReactNode; onPick: (item: T) => void; onClose: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={[styles.title, { marginBottom: space.md }]}>{title}</Text>
          <FlatList
            data={items}
            keyExtractor={keyOf}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  onPick(item);
                  onClose();
                }}
                style={({ pressed }) => [styles.sheetItem, pressed && { backgroundColor: colors.panel2 }]}
              >
                {render(item)}
              </Pressable>
            )}
          />
          <Button title="Cancel" kind="ghost" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export const Progress = ({ ratio }: { ratio: number }) => (
  <View style={styles.progress}>
    <View style={[styles.progressBar, { width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` }]} />
  </View>
);

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  padded: { padding: space.lg, gap: space.md },
  card: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: 6 },
  button: { borderWidth: 1, borderRadius: radius.sm, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', minHeight: 42 },
  buttonSmall: { paddingVertical: 6, paddingHorizontal: 10, minHeight: 32 },
  buttonText: { color: colors.text, fontWeight: '600', fontSize: 15 },
  title: { color: colors.text, fontSize: 18, fontWeight: '700' },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 14 },
  section: { color: colors.accent, fontSize: 12, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: space.md },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 },
  badgeText: { fontSize: 11, fontWeight: '600' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  error: { color: '#ffb3c1', backgroundColor: '#3a1420', borderRadius: radius.sm, padding: space.sm, fontSize: 13 },
  code: { color: colors.text, fontFamily: monoFont, fontSize: 12, backgroundColor: '#07080c', borderRadius: radius.sm, padding: space.sm },
  input: { color: colors.text, backgroundColor: colors.bg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  segment: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  segmentActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentText: { color: colors.muted, fontWeight: '600', fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: 'rgba(5,6,10,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.panel, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, maxHeight: '75%', gap: space.sm },
  sheetItem: { paddingVertical: 12, paddingHorizontal: 8, borderRadius: radius.sm },
  progress: { height: 6, backgroundColor: colors.panel2, borderRadius: 3, overflow: 'hidden', flex: 1 },
  progressBar: { height: '100%', backgroundColor: colors.accent2 },
});
