import Link from "next/link";
import { notFound } from "next/navigation";
import { DailyChart } from "@/app/projects/[id]/overview/daily-chart";
import { getDatabaseUrl, getDb } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { DROP_LABELS, getFilterOptions, getOverview, type Overview } from "@/lib/funnel";
import { EVENT_NAMES } from "@/lib/ingest-events";
import { getOwnedProject } from "@/lib/ingestion-health";
import { parseDashboardQuery, resolvePeriod } from "@/lib/period";
import { ensureDeveloperRecord, listProjectsForDeveloper } from "@/lib/projects";

export const dynamic = "force-dynamic";

function formatPercent(value: number | null) {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatCount(value: number) {
  return value.toLocaleString("zh-CN");
}

function formatAge(iso: string, now: Date) {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function rangeHref(projectId: string, range: "7d" | "30d", appVersion: string, paywallVersion: string) {
  const params = new URLSearchParams({ range });
  if (appVersion) params.set("app_version", appVersion);
  if (paywallVersion) params.set("paywall_version", paywallVersion);
  return `/projects/${projectId}/overview?${params.toString()}`;
}

function FilterForm({
  projectId,
  from,
  to,
  appVersion,
  paywallVersion,
  appVersions,
  paywallVersions,
}: {
  projectId: string;
  from: string;
  to: string;
  appVersion: string;
  paywallVersion: string;
  appVersions: string[];
  paywallVersions: string[];
}) {
  const appOptions = appVersion && !appVersions.includes(appVersion) ? [appVersion, ...appVersions] : appVersions;
  const paywallOptions =
    paywallVersion && !paywallVersions.includes(paywallVersion) ? [paywallVersion, ...paywallVersions] : paywallVersions;

  return (
    <form className="filters" action={`/projects/${projectId}/overview`}>
      <label>
        开始
        <input type="date" name="from" defaultValue={from} required />
      </label>
      <label>
        结束
        <input type="date" name="to" defaultValue={to} required />
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
      <button type="submit">查看</button>
    </form>
  );
}

function FunnelNumbers({ overview }: { overview: Overview }) {
  const steps = [
    { label: "Paywall Sessions", value: overview.funnel.sessions, rate: null, rateLabel: "" },
    {
      label: "Subscribe Clicked",
      value: overview.funnel.clicked,
      rate: overview.funnel.view_to_click,
      rateLabel: "看到后点击",
    },
    {
      label: "Purchased",
      value: overview.funnel.purchased,
      rate: overview.funnel.click_to_purchase,
      rateLabel: "点击后购买",
    },
  ];

  return (
    <section className="funnel">
      {steps.map((step) => (
        <article className="card metric" key={step.label}>
          <p className="muted">{step.label}</p>
          <strong>{formatCount(step.value)}</strong>
          {step.rateLabel ? (
            <p className="muted">
              {formatPercent(step.rate)} {step.rateLabel}
            </p>
          ) : (
            <p className="muted">每次展示计 1 次</p>
          )}
        </article>
      ))}
    </section>
  );
}

export default async function OverviewPage({
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
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const developer = await requireUser();
  if (!getDatabaseUrl()) {
    return (
      <main>
        <h1>概览</h1>
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
  const projects = await listProjectsForDeveloper(db, developer.id);
  const fallback = resolvePeriod({ timezone: project.timezone, now, range: "7d" });
  const fallbackPeriod = fallback.ok ? fallback.period : { from: "", to: "" };

  return (
    <main className="wide">
      <p>
        <Link href="/projects">项目</Link>
        {" · "}
        <Link href={`/projects/${project.id}/feedback`}>反馈</Link>
        {" · "}
        <Link href={`/projects/${project.id}/insights`}>报告</Link>
        {" · "}
        <Link href={`/projects/${project.id}/settings`}>设置</Link>
        {" · "}
        <Link href={`/projects/${project.id}/setup`}>接入引导</Link>
      </p>
      <h1>{project.name}</h1>
      <p className="muted">时区 {project.timezone}。漏斗按每次 Paywall 展示计算，同一个人打开多次会算多次。</p>
      {projects.length > 1 ? (
        <p className="links">
          {projects.map((item) => (
            <Link key={item.id} href={`/projects/${item.id}/overview`} className={item.id === project.id ? "current" : undefined}>
              {item.name}
            </Link>
          ))}
        </p>
      ) : null}

      {parsed.ok ? (
        <OverviewBody projectId={project.id} timezone={project.timezone} now={now} query={query} parsed={parsed.query} />
      ) : (
        <>
          <p className="error">{parsed.message}</p>
          <FilterForm
            projectId={project.id}
            from={query.from || fallbackPeriod.from}
            to={query.to || fallbackPeriod.to}
            appVersion={query.app_version ?? ""}
            paywallVersion={query.paywall_version ?? ""}
            appVersions={[]}
            paywallVersions={[]}
          />
        </>
      )}
    </main>
  );
}

async function OverviewBody({
  projectId,
  timezone,
  now,
  query,
  parsed,
}: {
  projectId: string;
  timezone: string;
  now: Date;
  query: { app_version?: string; paywall_version?: string };
  parsed: { period: { from: string; to: string }; appVersion: string | null; paywallVersion: string | null };
}) {
  const db = getDb();
  const project = { id: projectId, timezone };
  const [overview, filters] = await Promise.all([
    getOverview(db, project, { ...parsed, now }),
    getFilterOptions(db, project, parsed.period),
  ]);
  const quick7 = resolvePeriod({ timezone, now, range: "7d" });
  const quick30 = resolvePeriod({ timezone, now, range: "30d" });
  const sameRange = (period: { from: string; to: string } | undefined) =>
    period?.from === overview.period.from && period?.to === overview.period.to;
  const appVersion = query.app_version ?? "";
  const paywallVersion = query.paywall_version ?? "";
  const includesToday = overview.daily.some((day) => day.partial);

  return (
    <>
      <p className="links">
        <Link
          className={quick7.ok && sameRange(quick7.period) ? "current" : undefined}
          href={rangeHref(projectId, "7d", appVersion, paywallVersion)}
        >
          最近 7 天
        </Link>
        <Link
          className={quick30.ok && sameRange(quick30.period) ? "current" : undefined}
          href={rangeHref(projectId, "30d", appVersion, paywallVersion)}
        >
          最近 30 天
        </Link>
      </p>
      <FilterForm
        projectId={projectId}
        from={overview.period.from}
        to={overview.period.to}
        appVersion={parsed.appVersion ?? ""}
        paywallVersion={parsed.paywallVersion ?? ""}
        appVersions={filters.app_versions}
        paywallVersions={filters.paywall_versions}
      />
      <p className="muted">
        {overview.period.from} 至 {overview.period.to}
        {includesToday ? " · 含今天，今天的数据还不完整" : ""}
      </p>

      {overview.funnel.sessions === 0 ? (
        <p className="card">这个时间范围内还没有 Paywall 展示。</p>
      ) : (
        <>
          <FunnelNumbers overview={overview} />
          <p className="muted">整体转化 {formatPercent(overview.funnel.overall)}</p>
          {overview.biggest_drop ? (
            <p className="drop">
              最大流失点：{DROP_LABELS[overview.biggest_drop.step]}（流失 {formatCount(overview.biggest_drop.lost)} 次
              {overview.biggest_drop.lost_rate !== null ? `，${formatPercent(overview.biggest_drop.lost_rate)}` : ""}）
            </p>
          ) : null}
          <p>
            关闭未购买 {formatCount(overview.closed_without_purchase)}
            {" · "}
            收到反馈 {formatCount(overview.feedback_count)}（回答率 {formatPercent(overview.feedback_response_rate)}）
          </p>
          <p className="muted">回答率 = 反馈条数 / 关闭未购买。回答的人不代表所有没付钱的人。</p>
          <DailyChart daily={overview.daily} />
          <div className="table-wrap">
            <table className="daily">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>展示</th>
                  <th>购买</th>
                  <th>整体转化</th>
                </tr>
              </thead>
              <tbody>
                {overview.daily.map((day) => (
                  <tr key={day.date}>
                    <td>
                      {day.date}
                      {day.partial ? " · 不完整" : ""}
                    </td>
                    <td>{formatCount(day.sessions)}</td>
                    <td>{formatCount(day.purchased)}</td>
                    <td>{formatPercent(day.overall)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>接入健康</h2>
      <p>
        {overview.health.last_event_at
          ? `最近事件 ${formatAge(overview.health.last_event_at, now)}`
          : "还没有事件"}
        {" · "}
        已见到 {overview.health.event_names_seen.length}/{EVENT_NAMES.length} 种事件
        {" · "}
        孤儿 session {formatCount(overview.health.orphan_sessions)}
      </p>
      <p className="muted">接入健康看整个项目，不随上面的日期和版本筛选变化。没有先发送 paywall_viewed 的事件只记在这里，不进入漏斗。</p>
      {overview.health.last_event_at && overview.health.event_names_seen.length < EVENT_NAMES.length ? (
        <p className="drop">还没见过全部 4 种事件。漏发 paywall_closed 时，关闭未购买会偏少。</p>
      ) : null}
    </>
  );
}
