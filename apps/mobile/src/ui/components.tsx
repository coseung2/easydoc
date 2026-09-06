import type { ComponentProps, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors, radius } from "./theme";

export type TabKey = "home" | "documents" | "scan" | "tools" | "settings";

const tabs: { key: TabKey; label: string; icon: ComponentProps<typeof Feather>["name"] }[] = [
  { key: "home", label: "홈", icon: "home" },
  { key: "documents", label: "문서", icon: "file-text" },
  { key: "scan", label: "스캔", icon: "maximize" },
  { key: "tools", label: "도구", icon: "tool" },
  { key: "settings", label: "설정", icon: "settings" },
];

export function BottomNav({ active, onChange }: { active: TabKey; onChange: (tab: TabKey) => void }) {
  return (
    <View style={styles.nav}>
      {tabs.map((tab) => {
        const selected = active === tab.key;
        return (
          <Pressable key={tab.key} style={styles.navItem} onPress={() => onChange(tab.key)} accessibilityRole="button" accessibilityLabel={tab.label} accessibilityState={{ selected }}>
            <Feather name={tab.icon} size={19} color={selected ? colors.primary : colors.textMuted} />
            <Text style={[styles.navLabel, selected && styles.navLabelActive]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ScreenHeader({ title, right }: { title: string; right?: ReactNode }) {
  return <View style={styles.header}><Text style={styles.headerTitle}>{title}</Text><View>{right}</View></View>;
}

export function SearchBar({ label = "검색", onPress }: { label?: string; onPress: () => void }) {
  return <Pressable style={styles.search} onPress={onPress} accessibilityRole="search" accessibilityLabel={label}><Feather name="search" size={17} color={colors.textMuted} /><Text style={styles.searchText}>{label}</Text></Pressable>;
}

export function Chip({ label, active = false, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} accessibilityRole="button" accessibilityState={{ selected: active }}><Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text></Pressable>;
}

export function IconButton({ icon, accessibilityLabel, onPress }: { icon: ComponentProps<typeof Feather>["name"]; accessibilityLabel: string; onPress?: () => void }) {
  return <Pressable onPress={onPress} style={styles.iconButton} accessibilityRole="button" accessibilityLabel={accessibilityLabel}><Feather name={icon} size={19} color={colors.text} /></Pressable>;
}

export function ActionCard({ icon, label, onPress }: { icon: ComponentProps<typeof Feather>["name"]; label: string; onPress?: () => void }) {
  return (
    <Pressable style={styles.actionCard} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <View style={styles.actionLeft}><View style={styles.actionIcon}><Feather name={icon} size={18} color={colors.primary} /></View><Text style={styles.actionLabel}>{label}</Text></View>
      <Feather name="chevron-right" size={16} color={colors.textMuted} />
    </Pressable>
  );
}

export function FileBadge({ label }: { label: string }) {
  return <View style={styles.badge}><Text style={styles.badgeText}>{label}</Text></View>;
}

export const sharedStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, paddingHorizontal: 20, paddingBottom: 18 },
  row: { flexDirection: "row", alignItems: "center" },
  sectionTitle: { fontSize: 17, lineHeight: 24, fontWeight: "700", color: colors.text },
  muted: { color: colors.textMuted },
});

const styles = StyleSheet.create({
  nav: { height: 66, marginHorizontal: 20, marginBottom: 8, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", justifyContent: "space-between", backgroundColor: colors.background },
  navItem: { width: 58, height: 58, paddingTop: 12, alignItems: "center", gap: 4 },
  navLabel: { fontSize: 11, color: colors.textMuted, fontWeight: "600" },
  navLabelActive: { color: colors.primary },
  header: { height: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { fontSize: 26, lineHeight: 34, fontWeight: "800", color: colors.text, letterSpacing: -0.6 },
  search: { height: 46, borderRadius: radius.md, backgroundColor: colors.surfaceMuted, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14 },
  searchText: { color: colors.textMuted, fontSize: 14 },
  chip: { minHeight: 44, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, justifyContent: "center", backgroundColor: colors.surface },
  chipActive: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  chipTextActive: { color: colors.surface },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  actionCard: { height: 68, width: "48.8%", paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  actionLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  actionIcon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  actionLabel: { fontSize: 14, color: colors.text, fontWeight: "700" },
  badge: { paddingHorizontal: 8, height: 22, borderRadius: 7, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 10, fontWeight: "800", color: colors.textMuted },
});
