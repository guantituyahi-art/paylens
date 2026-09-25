"use client";

import { useFormStatus } from "react-dom";
import { generateReportAction } from "@/app/projects/[id]/insights/actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "正在生成报告…" : "生成报告"}
    </button>
  );
}

export function ReportForm({
  projectId,
  period,
  appVersion,
  paywallVersion,
  platform,
  appVersions,
  paywallVersions,
}: {
  projectId: string;
  period: "7d" | "30d";
  appVersion: string;
  paywallVersion: string;
  platform: string;
  appVersions: string[];
  paywallVersions: string[];
}) {
  const appOptions = appVersion && !appVersions.includes(appVersion) ? [appVersion, ...appVersions] : appVersions;
  const paywallOptions =
    paywallVersion && !paywallVersions.includes(paywallVersion) ? [paywallVersion, ...paywallVersions] : paywallVersions;

  return (
    <form className="filters" action={generateReportAction}>
      <input type="hidden" name="project_id" value={projectId} />
      <input type="hidden" name="period" value={period} />
      <label>
        平台
        <select name="platform" defaultValue={platform}>
          <option value="">全部</option>
          <option value="ios">iOS</option>
          <option value="android">Android</option>
        </select>
      </label>
      <label>
        App 版本
        <select name="app_version" defaultValue={appVersion}>
          <option value="">全部</option>
          {appOptions.map((version) => (
            <option key={version} value={version}>
              {version}
            </option>
          ))}
        </select>
      </label>
      <label>
        Paywall 版本
        <select name="paywall_version" defaultValue={paywallVersion}>
          <option value="">全部</option>
          {paywallOptions.map((version) => (
            <option key={version} value={version}>
              {version}
            </option>
          ))}
        </select>
      </label>
      <SubmitButton />
    </form>
  );
}
