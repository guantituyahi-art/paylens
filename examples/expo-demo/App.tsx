import { useEffect, useState } from "react";
import { Button, SafeAreaView, Text, View } from "react-native";
import { PayLens, PayLensExitSurvey } from "@paylens/react-native";

const clientKey = process.env.EXPO_PUBLIC_PAYLENS_CLIENT_KEY ?? "";
const endpoint = process.env.EXPO_PUBLIC_PAYLENS_ENDPOINT ?? "http://localhost:3000/v1";

export default function App() {
  const [surveyVisible, setSurveyVisible] = useState(false);

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
      <Text>先显示 Paywall。只点关闭，会出现退出调查；先点购买成功再关闭，则不会出现。</Text>
      <Text>选「其他」才出现输入框。7 天内不会再次出现。</Text>
      <View style={{ gap: 8 }}>
        <Button title="显示 Paywall" onPress={() => PayLens.track("paywall_viewed")} />
        <Button title="点击订阅" onPress={() => PayLens.track("subscribe_clicked", { productId: "pro_monthly" })} />
        <Button
          title="购买成功"
          onPress={() => PayLens.track("purchase_success", { productId: "pro_monthly" })}
        />
        <Button
          title="关闭 Paywall"
          onPress={() => {
            PayLens.track("paywall_closed");
            if (PayLens.shouldShowExitSurvey()) setSurveyVisible(true);
          }}
        />
      </View>
      <PayLensExitSurvey visible={surveyVisible} onClose={() => setSurveyVisible(false)} />
      {!clientKey ? <Text>请在 EXPO_PUBLIC_PAYLENS_CLIENT_KEY 里填入 Client Key。</Text> : null}
    </SafeAreaView>
  );
}
