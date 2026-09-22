import { useEffect } from "react";
import { Button, SafeAreaView, Text, View } from "react-native";
import { PayLens } from "@paylens/react-native";

const clientKey = process.env.EXPO_PUBLIC_PAYLENS_CLIENT_KEY ?? "";
const endpoint = process.env.EXPO_PUBLIC_PAYLENS_ENDPOINT ?? "http://localhost:3000/v1";

export default function App() {
  useEffect(() => {
    if (!clientKey) return;
    PayLens.init({
      clientKey,
      endpoint,
      paywallVersion: "A",
    });
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, justifyContent: "center", padding: 24, gap: 12 }}>
      <Text>按顺序点这四个按钮，它们属于同一次 Paywall。</Text>
      <Text>不传 appVersion，SDK 会读取 expo-application。</Text>
      <View style={{ gap: 8 }}>
        <Button title="显示 Paywall" onPress={() => PayLens.track("paywall_viewed")} />
        <Button title="点击订阅" onPress={() => PayLens.track("subscribe_clicked", { productId: "pro_monthly" })} />
        <Button title="关闭 Paywall" onPress={() => PayLens.track("paywall_closed")} />
        <Button title="购买成功" onPress={() => PayLens.track("purchase_success", { productId: "pro_monthly" })} />
      </View>
      {!clientKey ? <Text>请在 EXPO_PUBLIC_PAYLENS_CLIENT_KEY 里填入 Client Key。</Text> : null}
    </SafeAreaView>
  );
}
