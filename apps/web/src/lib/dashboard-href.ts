export function dashboardHref(
  projectId: string,
  page: "overview" | "feedback" | "insights",
  input: {
    from?: string;
    to?: string;
    range?: "7d" | "30d";
    period?: "7d" | "30d";
    platform?: string;
    appVersion?: string;
    paywallVersion?: string;
    segment?: string;
    report?: string;
  } = {},
) {
  const params = new URLSearchParams();
  if (input.range) params.set("range", input.range);
  if (input.period) params.set("period", input.period);
  if (input.from) params.set("from", input.from);
  if (input.to) params.set("to", input.to);
  if (input.platform) params.set("platform", input.platform);
  if (input.appVersion) params.set("app_version", input.appVersion);
  if (input.paywallVersion) params.set("paywall_version", input.paywallVersion);
  if (input.segment) params.set("segment", input.segment);
  if (input.report) params.set("report", input.report);
  const query = params.toString();
  return `/projects/${projectId}/${page}${query ? `?${query}` : ""}`;
}
