const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MOBILE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;

/** 评论里的邮箱和手机号换成固定占位，避免把联系方式存进反馈。 */
export function redactComment(comment: string) {
  return comment.replace(EMAIL_PATTERN, "[removed]").replace(MOBILE_PATTERN, "[removed]");
}
