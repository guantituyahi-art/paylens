import Link from "next/link";
import { createProjectAction, signOutAction } from "@/app/projects/actions";
import { getDatabaseUrl, getDb } from "@/db/client";
import { requireUser } from "@/lib/auth";
import { ensureDeveloperRecord, listProjectsForDeveloper } from "@/lib/projects";
import { getSupabaseEnv } from "@/lib/supabase/env";

export const dynamic = "force-dynamic";

const inputErrors: Record<string, string> = {
  name: "请填写项目名称（1–80 个字符）",
  timezone: "时区必须是合法的 IANA 时区，例如 Asia/Shanghai",
  database: "缺少 DATABASE_URL。请在 apps/web/.env.local 中配置 Postgres 连接串。",
};

function publicDbError(error: unknown) {
  const raw = error instanceof Error ? error.message : "数据库不可用";
  return raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]");
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  const params = await searchParams;
  if (!getSupabaseEnv()) {
    return (
      <main>
        <h1>PayLens</h1>
        <p className="error">
          还没有配置登录。请把 apps/web/.env.example 复制为 apps/web/.env.local，填入 Supabase 与
          DATABASE_URL。
        </p>
      </main>
    );
  }

  const developer = await requireUser();
  let projects: Awaited<ReturnType<typeof listProjectsForDeveloper>> = [];
  let dbError: string | null = null;
  if (!getDatabaseUrl()) {
    dbError = inputErrors.database;
  } else {
    try {
      const db = getDb();
      await ensureDeveloperRecord(db, developer);
      projects = await listProjectsForDeveloper(db, developer.id);
    } catch (error) {
      dbError = publicDbError(error);
    }
  }

  return (
    <main>
      <div className="row">
        <h1>项目</h1>
        <form action={signOutAction}>
          <button className="secondary" type="submit">
            退出
          </button>
        </form>
      </div>
      <p className="muted">{developer.email}</p>
      {params.created ? <p className="banner">项目已创建，第一把 Client Key 状态为 active。</p> : null}
      {params.error && inputErrors[params.error] ? (
        <p className="error">{inputErrors[params.error]}</p>
      ) : null}
      {dbError ? <p className="error">{dbError}</p> : null}

      <h2>新建项目</h2>
      <form action={createProjectAction}>
        <label>
          项目名称
          <input name="name" required maxLength={80} placeholder="例如：我的第二个 App" />
        </label>
        <label>
          时区（IANA）
          <input name="timezone" required defaultValue="Asia/Shanghai" placeholder="Asia/Shanghai" />
        </label>
        <button type="submit">创建项目</button>
      </form>

      <h2>已有项目</h2>
      {projects.length === 0 ? <p className="muted">还没有项目。</p> : null}
      {projects.map((project) => (
        <article className="card" key={project.id}>
          <strong>{project.name}</strong>
          <p>
            <Link href={`/projects/${project.id}/overview`}>概览</Link>
            {" · "}
            <Link href={`/projects/${project.id}/feedback`}>反馈</Link>
            {" · "}
            <Link href={`/projects/${project.id}/insights`}>报告</Link>
            {" · "}
            <Link href={`/projects/${project.id}/setup`}>接入引导</Link>
          </p>
          <p className="muted">时区 {project.timezone}</p>
          {project.keys.length === 0 ? <p className="muted">还没有 Client Key。</p> : null}
          {project.keys.map((key) => (
            <p key={key.id}>
              <code>{key.value}</code>
              <span className="muted"> · {key.status}</span>
            </p>
          ))}
        </article>
      ))}
    </main>
  );
}
