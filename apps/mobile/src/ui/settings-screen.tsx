import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { ScreenHeader } from "./components";
import { colors, radius } from "./theme";

function Row({ icon, title, subtitle, onPress }: { icon: keyof typeof Feather.glyphMap; title: string; subtitle: string; onPress?: () => void }) {
  return <Pressable style={styles.row} onPress={onPress}><View style={styles.icon}><Feather name={icon} size={18} color={colors.primary} /></View><View style={styles.text}><Text style={styles.title}>{title}</Text><Text style={styles.sub}>{subtitle}</Text></View><Feather name="chevron-right" size={17} color={colors.textMuted} /></Pressable>;
}

export function SettingsScreen({ paired, online, relayBaseUrl, onPair, onRelayUrlChange }: { paired: boolean; online: boolean; relayBaseUrl: string; onPair: () => void; onRelayUrlChange: (value: string) => Promise<void> }) {
  const [relayUrl, setRelayUrl] = useState(relayBaseUrl);
  const [message, setMessage] = useState("");
  useEffect(() => setRelayUrl(relayBaseUrl), [relayBaseUrl]);

  const saveRelay = async () => {
    setMessage("");
    try { await onRelayUrlChange(relayUrl); setMessage("Relay URL 저장됨"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "invalid_relay_url"); }
  };

  return <ScrollView style={styles.root} showsVerticalScrollIndicator={false}>
    <ScreenHeader title="설정" />
    <Text style={styles.label}>연결</Text>
    <View style={styles.card}>
      <Row icon="monitor" title={paired ? "연결된 PC" : "PC 연결"} subtitle={paired ? (online ? "온라인 · 전송 가능" : "오프라인") : "QR 코드로 Windows PC와 연결"} onPress={onPair} />
      <Row icon="wifi" title="전송 상태" subtitle={online ? "PC가 온라인입니다" : "연결 대기"} />
      <Row icon="folder" title="기본 저장" subtitle="스캔 문서를 기기에 유지" />
    </View>
    <Text style={styles.label}>Relay</Text>
    <View style={styles.relayCard}><Text style={styles.relayTitle}>Cloudflare Worker URL</Text><Text style={styles.relayHelp}>예: https://easydoc-relay.example.workers.dev</Text><TextInput value={relayUrl} onChangeText={setRelayUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://..." placeholderTextColor={colors.textMuted} style={styles.input} /><Pressable style={styles.saveButton} onPress={saveRelay}><Text style={styles.saveText}>주소 적용</Text></Pressable>{message && <Text style={styles.message}>{message}</Text>}</View>
    <Text style={styles.label}>스캔</Text>
    <View style={styles.card}><Row icon="maximize" title="자동 문서 감지" subtitle="문서 경계를 감지해 자르기" /><Row icon="layers" title="기본 필터" subtitle="컬러" /></View>
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
  relayCard: { borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, padding: 14 },
  relayTitle: { fontSize: 13, fontWeight: "800", color: colors.text },
  relayHelp: { marginTop: 4, fontSize: 10, color: colors.textMuted },
  input: { marginTop: 10, height: 42, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, color: colors.text, backgroundColor: colors.background, fontSize: 11 },
  saveButton: { marginTop: 10, height: 40, borderRadius: 10, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  saveText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  message: { marginTop: 8, fontSize: 10, color: colors.textMuted, textAlign: "center" },
});
