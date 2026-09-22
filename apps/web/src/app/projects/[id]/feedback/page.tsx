import Link from "next/link";
import { notFound } from "next/navigation";
import { getDatabaseUrl, getDb } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { getFeedbackComments, getFeedbackSummary, type ReasonStat } from "@/lib/feedback-stats";
import { getFilterOptions, getOverview } from "@/lib/funnel";
import { getOwnedProject } from "@/lib/ingestion-health";
import { parseDashboardQuery } from "@/lib/period";
import { ensureDeveloperRecord } from "@/lib/projects";

export const dynamic = "force-dynamic";

function formatPercent(value: number | null) {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatCount(value: number) {
  return value.toLocaleString("zh-CN");
}

function formatDelta(reason: ReasonStat) {
  if (reason.low_sample) return "(小样本)";
  if (reason.delta_pp === null || reason.delta_pp === 0) return "—";
  if (reason.delta_pp > 0) return `▲ +${reason.delta_pp}pp`;
  return `▼ ${reason.delta_pp}pp`;
}

function formatAge(iso: string, now: Date) {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export default async function FeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    app_version?: string;
    paywall_version?: string;
    text?: string;
    cursor?: string;
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const developer = await requireUser();
  if (!getDatabaseUrl()) {
    return (
      <main>
        <h1>反馈</h1>
        <p className="error">缺少 DATABASE_URL。</p>
      </main>
    );
  }

  const db = getDb();
  await ensureDeveloperRecord(db, developer);
  const project = await getOwnedProject(db, id, developer.id);
  if (!project) notFound();
  const now = new Date();
  const parsed = parseDashboardQuery(project.timezone, query, now);
  const textOnly = query.text !== "all";

  return (
    <main className="wide">
      <p>
        <Link href="/projects">项目</Link>
        {" · "}
        <Link href={`/projects/${project.id}/overview`}>概览</Link>
        {" · "}
        <Link href={`/projects/${project.id}/insights`}>报告</Link>
        {" · "}
        <Link href={`/projects/${project.id}/settings`}>设置</Link>
        {" · "}
        <Link href={`/projects/${project.id}/setup`}>接入引导</Link>
      </p>
      <h1>{project.name} 的反馈</h1>
      <p className="muted">这里看用户自己说的没付钱原因。变化是和上一整段同样长的时间比。</p>
      {parsed.ok ? (
        <FeedbackBody project={project} now={now} query={query} parsed={parsed.query} textOnly={textOnly} />
      ) : (
        <p className="error">{parsed.message}</p>
      )}
    </main>
  );
}

async function FeedbackBody({
  project,
  now,
  query,
  parsed,
  textOnly,
}: {
  project: { id: string; timezone: string };
  now: Date;
  query: { text?: string; cursor?: string; app_version?: string; paywall_version?: string };
  parsed: { period: { from: string; to: string }; appVersion: string | null; paywallVersion: string | null };
  textOnly: boolean;
}) {
  const db = getDb();
  const filter = { ...parsed };
  const [summary, overview, filters, comments] = await Promise.all([
    getFeedbackSummary(db, project, filter),
    getOverview(db, project, { ...filter, now }),
    getFilterOptions(db, project, parsed.period),
    getFeedbackComments(db, project, { ...filter, textOnly, cursor: query.cursor ?? null }),
  ]);
  if ("error" in comments) {
    return <p className="error">这一页的位置无效，请从反馈列表重新开始。</p>;
  }
  const maxCount = Math.max(1, ...summary.reasons.map((reason) => reason.count));
  const base = new URLSearchParams();
  base.set("from", parsed.period.from);
  base.set("to", parsed.period.to);
  if (parsed.appVersion) base.set("app_version", parsed.appVersion);
  if (parsed.paywallVersion) base.set("paywall_version", parsed.paywallVersion);
  const textParams = new URLSearchParams(base);
  if (!textOnly) textParams.set("text", "all");
  const allParams = new URLSearchParams(base);
  allParams.set("text", "all");
  const onlyTextParams = new URLSearchParams(base);

  return (
    <>
      <p className="links">
        <Link href={`/projects/${project.id}/feedback?range=7d`}>最近 7 天</Link>
        <Link href={`/projects/${project.id}/feedback?range=30d`}>最近 30 天</Link>
      </p>
      <form className="filters" action={`/projects/${project.id}/feedback`}>
        <label>
          开始
          <input type="date" name="from" defaultValue={parsed.period.from} required />
        </label>
        <label>
          结束
          <input type="date" name="to" defaultValue={parsed.period.to} required />
        </label>
        <label>
          App 版本
          <select name="app_version" defaultValue={parsed.appVersion ?? ""}>
            <option value="">全部</option>
            {filters.app_versions.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </label>
        <label>
          Paywall 版本
          <select name="paywall_version" defaultValue={parsed.paywallVersion ?? ""}>
            <option value="">全部</option>
            {filters.paywall_versions.map((version) => (
              <option key={version} value={version}>
                {version}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">查看</button>
      </form>
      <p className="muted">
        {parsed.period.from} 至 {parsed.period.to} · 对比 {summary.compare.from} 至 {summary.compare.to}
      </p>
      <p>
        共 {formatCount(summary.total)} 条反馈 · 回答率 {formatPercent(overview.feedback_response_rate)}
      </p>
      <p className="muted">
        回答率 = 反馈条数 / 关闭未购买（{formatCount(overview.closed_without_purchase)}）。回答的人不代表所有没付钱的人。
      </p>
      {summary.reasons.length === 0 ? <p className="card">这个时间范围内还没有反馈。</p> : null}
      {summary.reasons.map((reason) => (
        <div className="reason" key={reason.code}>
          <span>{reason.label}</span>
          <div className="reason-track">
            <div className="reason-fill" style={{ width: `${(reason.count / maxCount) * 100}%` }} />
          </div>
          <span>
            {formatCount(reason.count)} · {formatPercent(reason.share)} · {formatDelta(reason)}
          </span>
        </div>
      ))}

      <div className="row">
        <h2>文字反馈</h2>
        {textOnly ? (
          <Link href={`/projects/${project.id}/feedback?${allParams.toString()}`}>查看全部反馈</Link>
        ) : (
          <Link href={`/projects/${project.id}/feedback?${onlyTextParams.toString()}`}>仅看含文字</Link>
        )}
      </div>
      {comments.comments.length === 0 ? <p className="muted">没有符合条件的反馈。</p> : null}
      {comments.comments.map((item) => (
        <article className="card comment" key={item.id}>
          <p>{item.comment ? `“${item.comment}”` : "没有填写文字"}</p>
          <p className="muted">
            {item.reason_label || item.reason_code} · {item.app_version}
            {item.paywall_version ? ` · ${item.paywall_version}` : ""} · {formatAge(item.occurred_at, now)}
            {item.orphan ? " · 没有先看到付费页，不计入上面的分布" : ""}
          </p>
        </article>
      ))}
      {comments.next_cursor ? (
        <p>
          <Link href={`/projects/${project.id}/feedback?${textParams.toString()}&cursor=${encodeURIComponent(comments.next_cursor)}`}>
            下一页
          </Link>
        </p>
      ) : null}
    </>
  );
}
