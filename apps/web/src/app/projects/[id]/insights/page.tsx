import Link from "next/link";
import { notFound } from "next/navigation";
import { ReportForm } from "@/app/projects/[id]/insights/report-form";
import { getDatabaseUrl, getDb } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { getFilterOptions } from "@/lib/funnel";
import { getOwnedProject } from "@/lib/ingestion-health";
import { dashboardHref } from "@/lib/dashboard-href";
import { completeReportPeriod } from "@/lib/period";
import { ensureDeveloperRecord } from "@/lib/projects";
import { getReport, listReports, type StoredReport } from "@/lib/reports";
import { MIN_FEEDBACK, MIN_SESSIONS } from "@/lib/thresholds";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<StoredReport["status"], string> = {
  done: "已生成",
  insufficient_data: "样本不足",
  failed: "生成失败",
  pending: "生成中",
};

const CONFIDENCE_LABEL = { low: "低", medium: "中", high: "高" };

export default async function InsightsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    period?: string;
    app_version?: string;
    paywall_version?: string;
    platform?: string;
    report?: string;
    error?: string;
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const developer = await requireUser();
  if (!getDatabaseUrl()) {
    return (
      <main>
        <h1>报告</h1>
        <p className="error">缺少 DATABASE_URL。</p>
      </main>
    );
  }

  const db = getDb();
  await ensureDeveloperRecord(db, developer);
  const project = await getOwnedProject(db, id, developer.id);
  if (!project) notFound();

  const period = query.period === "30d" ? "30d" : "7d";
  const appVersion = query.app_version?.trim() ?? "";
  const paywallVersion = query.paywall_version?.trim() ?? "";
  const platform = query.platform === "ios" || query.platform === "android" ? query.platform : "";
  const now = new Date();
  const range = completeReportPeriod(project.timezone, period, now);
  const [reports, filters] = await Promise.all([
    listReports(db, project.id),
    getFilterOptions(db, project, range),
  ]);
  const selected = query.report ? await getReport(db, project.id, query.report) : (reports[0] ?? null);

  return (
    <main className="wide">
      <p>
        <Link href="/projects">项目</Link>
        {" · "}
        <Link
          href={dashboardHref(project.id, "overview", {
            from: range.from,
            to: range.to,
            platform,
            appVersion,
            paywallVersion,
          })}
        >
          概览
        </Link>
        {" · "}
        <Link
          href={dashboardHref(project.id, "feedback", {
            from: range.from,
            to: range.to,
            platform,
            appVersion,
            paywallVersion,
          })}
        >
          反馈
        </Link>
        {" · "}
        <Link href={`/projects/${project.id}/settings`}>设置</Link>
        {" · "}
        <Link href={`/projects/${project.id}/setup`}>接入引导</Link>
      </p>
      <h1>{project.name} 的报告</h1>
      <p className="muted">
        数字和事实句由代码计算。AI 只做文字主题归类，以及基于这些事实的假设和建议。报告只用已经结束的完整自然日，不含今天。从概览或反馈进来时会保留平台、App 版本和 Paywall 版本，但不会沿用那边含今天的日期。近 7 天是昨天往前共 7 天。
      </p>
      <p className="links">
        <Link className={period === "7d" ? "current" : undefined} href={dashboardHref(project.id, "insights", { period: "7d", appVersion, paywallVersion, platform })}>
          近 7 天
        </Link>
        <Link className={period === "30d" ? "current" : undefined} href={dashboardHref(project.id, "insights", { period: "30d", appVersion, paywallVersion, platform })}>
          近 30 天
        </Link>
      </p>
      <p className="muted">
        {range.from} 至 {range.to}，时区 {project.timezone}
      </p>
      {query.error ? <p className="error">{query.error}</p> : null}
      <ReportForm
        projectId={project.id}
        period={period}
        appVersion={appVersion}
        paywallVersion={paywallVersion}
        platform={platform}
        appVersions={filters.app_versions}
        paywallVersions={filters.paywall_versions}
      />

      <h2>历史报告</h2>
      {reports.length === 0 ? <p className="muted">还没有报告。</p> : null}
      <p className="links">
        {reports.map((report) => (
          <Link
            key={report.id}
            className={selected?.id === report.id ? "current" : undefined}
            href={dashboardHref(project.id, "insights", { period, appVersion, paywallVersion, platform, report: report.id })}
          >
            {report.periodStart} 至 {report.periodEnd} · {STATUS_LABEL[report.status]}
          </Link>
        ))}
      </p>

      {selected ? <ReportView report={selected} /> : null}
    </main>
  );
}

function ReportView({ report }: { report: StoredReport }) {
  const snapshot = report.inputSnapshot;
  const keyChanges = new Set(snapshot?.key_changes ?? []);
  const sessions = snapshot?.funnel.current.sessions ?? 0;
  const feedbackTotal = snapshot?.feedback.total ?? 0;

  return (
    <section>
      <h2>
        {report.periodStart} 至 {report.periodEnd}
        <span className="muted"> · {STATUS_LABEL[report.status]}</span>
      </h2>
      {report.status === "insufficient_data" ? (
        <p className="drop">
          样本未达到 V0.1 阈值（当前 {feedbackTotal} 条反馈 / {sessions} sessions，阈值 {MIN_FEEDBACK} / {MIN_SESSIONS}），未调用 AI
        </p>
      ) : null}
      {report.status === "failed" && report.error ? <p className="error">{report.error}</p> : null}
      {report.model ? <p className="muted">模型 {report.model}</p> : null}

      <h2>事实</h2>
      {snapshot?.facts.length ? (
        <ul>
          {snapshot.facts.map((fact) => (
            <li key={fact.id}>
              <code>{fact.id}</code> {fact.text}
              {keyChanges.has(fact.id) ? <span className="muted"> · 关键变化</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">这份报告没有事实句。</p>
      )}
      {snapshot?.caveats.map((caveat) => (
        <p className="muted" key={caveat}>
          {caveat}
        </p>
      ))}

      {report.status === "done" && report.output ? (
        <>
          <h2>假设</h2>
          {report.output.hypotheses.length === 0 ? <p className="muted">没有通过校验的假设。</p> : null}
          {report.output.hypotheses.map((hypothesis) => (
            <article className="card" key={hypothesis.id}>
              <p>{hypothesis.text}</p>
              <p className="muted">
                依据 {hypothesis.based_on.join("、")} · 信心 {CONFIDENCE_LABEL[hypothesis.confidence]}
              </p>
            </article>
          ))}
          <h2>建议测试</h2>
          {report.output.suggested_tests.length === 0 ? <p className="muted">没有通过校验的测试。</p> : null}
          {report.output.suggested_tests.map((test) => (
            <article className="card" key={test.id}>
              <p>{test.text}</p>
              <p className="muted">
                对应 {test.for_hypothesis} · 看 {test.measure}
              </p>
            </article>
          ))}
          {report.output.notes ? (
            <>
              <h2>说明</h2>
              <p>{report.output.notes}</p>
            </>
          ) : null}
        </>
      ) : null}

      {snapshot ? (
        <details>
          <summary>查看计算用的快照</summary>
          <pre>{JSON.stringify(snapshot, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}
