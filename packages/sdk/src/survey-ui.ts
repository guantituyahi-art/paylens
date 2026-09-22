import { shouldAskComment, type SurveyConfig } from "./survey";

type SurveyBridge = {
  getSurvey: () => SurveyConfig;
  markShown: () => void;
  submit: (reasonCode: string, extra?: { label?: string; comment?: string }) => void;
};

let bridge: SurveyBridge | null = null;

export function bindSurveyBridge(next: SurveyBridge) {
  bridge = next;
}

type ReactNs = {
  useEffect: (effect: () => void, deps: unknown[]) => void;
  useState: <T>(initial: T) => [T, (value: T) => void];
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;
};

/** 自带的退出调查。只有选「其他」并且允许留言时才出现输入框。 */
export function PayLensExitSurvey(props: { visible: boolean; onClose: () => void }) {
  const React = require("react") as ReactNs;
  const native = require("react-native") as {
    Modal: unknown;
    Pressable: unknown;
    Text: unknown;
    TextInput: unknown;
    View: unknown;
  };
  const [selected, setSelected] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");

  React.useEffect(() => {
    if (!props.visible) return;
    setSelected(null);
    setComment("");
    bridge?.markShown();
  }, [props.visible]);

  if (!props.visible || !bridge) return null;
  const survey = bridge.getSurvey();
  const askComment = shouldAskComment(selected, survey.allowComment);
  const h = React.createElement;
  const optionNodes = survey.options.map((option) =>
    h(
      native.Pressable,
      {
        key: option.code,
        onPress: () => setSelected(option.code),
        style: {
          padding: 12,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: selected === option.code ? "#1c1917" : "#d6d3d1",
          backgroundColor: selected === option.code ? "#f5f5f4" : "#ffffff",
        },
      },
      h(native.Text, null, option.label),
    ),
  );

  return h(
    native.Modal,
    { visible: props.visible, transparent: true, animationType: "fade", onRequestClose: props.onClose },
    h(
      native.View,
      { style: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" } },
      h(
        native.View,
        { style: { backgroundColor: "#ffffff", padding: 20, gap: 12, borderTopLeftRadius: 16, borderTopRightRadius: 16 } },
        h(native.Text, { style: { fontSize: 18, fontWeight: "600" } }, survey.question),
        ...optionNodes,
        askComment
          ? h(native.TextInput, {
              value: comment,
              onChangeText: setComment,
              placeholder: "可以写一句具体原因",
              multiline: true,
              maxLength: 300,
              style: { borderWidth: 1, borderColor: "#d6d3d1", borderRadius: 8, padding: 10, minHeight: 72 },
            })
          : null,
        askComment ? h(native.Text, { style: { color: "#78716c", fontSize: 12 } }, "请勿填写个人信息") : null,
        h(
          native.Pressable,
          {
            disabled: !selected,
            onPress: () => {
              if (!selected) return;
              const option = survey.options.find((item) => item.code === selected);
              bridge?.submit(selected, { label: option?.label, comment: askComment ? comment : undefined });
              props.onClose();
            },
            style: { backgroundColor: selected ? "#1c1917" : "#d6d3d1", borderRadius: 8, padding: 12 },
          },
          h(native.Text, { style: { color: "#ffffff", textAlign: "center" } }, "提交"),
        ),
        h(
          native.Pressable,
          { onPress: props.onClose, style: { padding: 8 } },
          h(native.Text, { style: { textAlign: "center", color: "#57534e" } }, "关闭"),
        ),
      ),
    ),
  );
}
