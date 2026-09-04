import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { Feather } from "@expo/vector-icons";
import { claimPairing, type StoredMobilePairing } from "../pairing/client.ts";
import { colors, radius } from "./theme";

export function PairingScreen({
  relayBaseUrl,
  onBack,
  onPaired,
}: {
  relayBaseUrl: string;
  onBack: () => void;
  onPaired: (pairing: StoredMobilePairing) => void | Promise<void>;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const locked = useRef(false);

  const scan = async (result: BarcodeScanningResult) => {
    if (locked.current || busy) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (!relayBaseUrl) throw new Error("EXPO_PUBLIC_RELAY_URL 설정이 필요합니다.");
      const pairing = await claimPairing(relayBaseUrl, result.data);
      setMessage("PC 연결이 완료되었습니다.");
      await onPaired(pairing);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "pairing_invalid");
      locked.current = false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.back}><Feather name="arrow-left" size={20} /><Text style={styles.title}>PC 연결</Text></Pressable>
      </View>
      <Text style={styles.heading}>Windows PC의 QR 코드를 스캔하세요</Text>
      <Text style={styles.description}>EasyDoc 데스크톱 앱에서 “휴대폰 연결”을 누르면 5분 동안 유효한 QR 코드가 표시됩니다.</Text>
      <View style={styles.camera}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scan}
          />
        ) : (
          <Pressable style={styles.permission} onPress={requestPermission}>
            <Feather name="camera" size={30} color="#CBD5E1" />
            <Text style={styles.permissionText}>QR 스캔을 위해 카메라 권한 허용</Text>
          </Pressable>
        )}
        <View pointerEvents="none" style={styles.guide} />
      </View>
      <View style={styles.security}><Feather name="shield" size={17} color={colors.primary} /><Text style={styles.securityText}>QR 토큰은 1회용이며 private key는 기기 밖으로 전송되지 않습니다.</Text></View>
      {busy && <Text style={styles.status}>연결 확인 중...</Text>}
      {message && <Text style={[styles.status, message.includes("완료") && styles.success]}>{message}</Text>}
      {!relayBaseUrl && <Text style={styles.error}>앱 실행 전 EXPO_PUBLIC_RELAY_URL을 설정하세요.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, backgroundColor: colors.background },
  header: { height: 54, justifyContent: "center" },
  back: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { fontSize: 22, fontWeight: "800", color: colors.text },
  heading: { marginTop: 18, fontSize: 21, lineHeight: 28, fontWeight: "900", color: colors.text },
  description: { marginTop: 8, fontSize: 13, lineHeight: 20, color: colors.textMuted },
  camera: { marginTop: 24, height: 430, borderRadius: radius.lg, overflow: "hidden", backgroundColor: colors.camera, alignItems: "center", justifyContent: "center" },
  permission: { alignItems: "center", gap: 10 },
  permissionText: { color: "#CBD5E1", fontSize: 12, fontWeight: "700" },
  guide: { width: 242, height: 242, borderWidth: 3, borderColor: "#FFFFFF", borderRadius: 22 },
  security: { marginTop: 18, flexDirection: "row", alignItems: "center", gap: 9, padding: 13, borderRadius: radius.md, backgroundColor: colors.primarySoft },
  securityText: { flex: 1, fontSize: 11, lineHeight: 17, color: colors.textMuted },
  status: { marginTop: 14, textAlign: "center", fontSize: 12, color: colors.textMuted, fontWeight: "700" },
  success: { color: colors.success },
  error: { marginTop: 8, textAlign: "center", fontSize: 11, color: colors.danger },
});
