import Link from "next/link";
import { notFound } from "next/navigation";
import {
  clearProjectDataAction,
  createKeyAction,
  deleteUserDataAction,
  deprecateKeyAction,
  revokeKeyAction,
  updateTimezoneAction,
} from "@/app/projects/[id]/settings/actions";
import { getDatabaseUrl, getDb } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { getOwnedProject } from "@/lib/ingestion-health";
import { ensureDeveloperRecord } from "@/lib/projects";
import { listProjectKeys } from "@/lib/project-settings";

export const dynamic = "force-dynamic";

function formatAge(iso: string | null, now: Date) {
  if (!iso) return "从未使用";
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function formatDay(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

function bannerMessage(params: {
  saved?: string;
  events?: string;
  feedback?: string;
  reports?: string;
}) {
  switch (params.saved) {
    case "timezone":
      return "时区已更新。概览分桶会按新时区计算。";
    case "key_created":
      return "已新建一把 active Client Key。";
    case "key_deprecated":
      return "Key 已标记为 deprecated，仍可上报。";
    case "key_revoked":
      return "Key 已撤销，后续上报会被拒绝。";
    case "user_deleted":
      return `已删除该用户数据：事件 ${params.events ?? "0"} 条，反馈 ${params.feedback ?? "0"} 条。`;
    case "cleared":
      return `已清空项目数据：事件 ${params.events ?? "0"} 条，反馈 ${params.feedback ?? "0"} 条，报告 ${params.reports ?? "0"} 份。`;
    default:
      return null;
  }
}

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    saved?: string;
    error?: string;
    events?: string;
    feedback?: string;
    reports?: string;
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const developer = await requireUser();
  if (!getDatabaseUrl()) {
    return (
      <main>
        <h1>项目设置</h1>
        <p className="error">缺少 DATABASE_URL。</p>
      </main>
    );
  }

  const db = getDb();
  await ensureDeveloperRecord(db, developer);
  const project = await getOwnedProject(db, id, developer.id);
  if (!project) notFound();
  const keys = await listProjectKeys(db, project.id);
  const now = new Date();
  const banner = bannerMessage(query);
  const activeCount = keys.filter((key) => key.status === "active").length;

  return (
    <main>
      <p>
        <Link href="/projects">返回项目</Link>
        {" · "}
        <Link href={`/projects/${project.id}/overview`}>概览</Link>
        {" · "}
        <Link href={`/projects/${project.id}/feedback`}>反馈</Link>
        {" · "}
        <Link href={`/projects/${project.id}/insights`}>报告</Link>
        {" · "}
        <Link href={`/projects/${project.id}/setup`}>接入引导</Link>
      </p>
      <h1>设置 · {project.name}</h1>
      <p className="muted">基本配置与隐私操作</p>
      {banner ? <p className="banner">{banner}</p> : null}
      {query.error ? <p className="error">{query.error}</p> : null}

      <h2>基本配置</h2>
      <form action={updateTimezoneAction}>
        <input type="hidden" name="project_id" value={project.id} />
        <label>
          项目名称
          <input value={project.name} disabled readOnly />
        </label>
        <label>
          时区（IANA）
          <input name="timezone" required defaultValue={project.timezone} placeholder="Asia/Shanghai" />
        </label>
        <button type="submit">保存时区</button>
      </form>

      <h2>Client Keys</h2>
      <p className="muted">
        deprecated 仍接受上报，用于观察旧版本流量；revoked 立即拒绝。状态只能沿 active → deprecated →
        revoked 单向流转。不能撤销最后一把 active Key。
      </p>
      <form action={createKeyAction}>
        <input type="hidden" name="project_id" value={project.id} />
        <label>
          新 Key 标签（可选）
          <input name="label" maxLength={80} placeholder="例如：v1.2 发布" />
        </label>
        <button type="submit">新建 Key</button>
      </form>
      {keys.map((key) => (
        <article className="card" key={key.id}>
          <p>
            <code>{key.key}</code>
          </p>
          <p className="muted">
            {key.label ? `「${key.label}」 · ` : null}
            {key.status}
            {key.status === "revoked"
              ? ` · 撤销于 ${formatDay(key.revokedAt?.toISOString() ?? null)}`
              : ` · 最近使用 ${formatAge(key.lastUsedAt?.toISOString() ?? null, now)}`}
          </p>
          {key.status === "active" ? (
            <form action={deprecateKeyAction}>
              <input type="hidden" name="project_id" value={project.id} />
              <input type="hidden" name="key_id" value={key.id} />
              <button className="secondary" type="submit">
                标记 deprecated
              </button>
            </form>
          ) : null}
          {key.status === "deprecated" ? (
            <form action={revokeKeyAction}>
              <input type="hidden" name="project_id" value={project.id} />
              <input type="hidden" name="key_id" value={key.id} />
              <button className="secondary" type="submit" disabled={activeCount < 1}>
                撤销
              </button>
            </form>
          ) : null}
          {key.status === "deprecated" && activeCount < 1 ? (
            <p className="muted">请先新建一把 active Key，才能撤销这把 deprecated Key。</p>
          ) : null}
        </article>
      ))}

      <h2>数据保留</h2>
      <p>原始事件与反馈保留 {project.retentionDays} 天后自动删除（V0.1 固定）。AI 报告保留。</p>

      <h2>删除某个用户的数据</h2>
      <p className="muted">按 anonymous_user_id 删除该用户的 events 与 feedback。</p>
      <form action={deleteUserDataAction}>
        <input type="hidden" name="project_id" value={project.id} />
        <label>
          anonymous_user_id
          <input name="anonymous_user_id" required placeholder="用户匿名 ID" />
        </label>
        <button type="submit">删除该用户数据</button>
      </form>

      <h2>删除项目全部数据</h2>
      <p className="muted">危险操作：清空本项目的 events、feedback 与 ai_reports。请输入项目名称确认。</p>
      <form action={clearProjectDataAction}>
        <input type="hidden" name="project_id" value={project.id} />
        <label>
          输入「{project.name}」确认
          <input name="confirm_name" required placeholder={project.name} />
        </label>
        <button type="submit">清空项目数据</button>
      </form>
    </main>
  );
}
