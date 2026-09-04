import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { ScreenHeader } from "./components";
import { colors, radius } from "./theme";

function Row({ icon, title, subtitle, onPress }: { icon: keyof typeof Feather.glyphMap; title: string; subtitle: string; onPress?: () => void }) {
  return <Pressable style={styles.row} onPress={onPress}><View style={styles.icon}><Feather name={icon} size={18} color={colors.primary} /></View><View style={styles.text}><Text style={styles.title}>{title}</Text><Text style={styles.sub}>{subtitle}</Text></View><Feather name="chevron-right" size={17} color={colors.textMuted} /></Pressable>;
}

export function SettingsScreen({ paired, online, onPair }: { paired: boolean; online: boolean; onPair: () => void }) {
  return <ScrollView style={styles.root} showsVerticalScrollIndicator={false}>
    <ScreenHeader title="설정" />
    <Text style={styles.label}>연결</Text>
    <View style={styles.card}>
      <Row icon="monitor" title={paired ? "연결된 PC" : "PC 연결"} subtitle={paired ? (online ? "온라인 · 전송 가능" : "오프라인") : "QR 코드로 Windows PC와 연결"} onPress={onPair} />
      <Row icon="wifi" title="전송 상태" subtitle={online ? "PC가 온라인입니다" : "연결 대기"} />
      <Row icon="folder" title="기본 저장" subtitle="스캔 문서를 기기에 유지" />
    </View>
    <Text style={styles.label}>스캔</Text>
    <View style={styles.card}><Row icon="maximize" title="자동 문서 감지" subtitle="문서 경계를 감지해 자르기" /><Row icon="layers" title="기본 필터" subtitle="자동" /></View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background },
  label: { marginTop: 18, marginBottom: 8, color: colors.textMuted, fontSize: 12, fontWeight: "800" },
  card: { borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  row: { minHeight: 64, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  text: { flex: 1 },
  title: { fontSize: 13, fontWeight: "800", color: colors.text },
  sub: { marginTop: 3, fontSize: 11, color: colors.textMuted },
});
