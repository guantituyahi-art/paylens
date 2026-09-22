import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { IngestionStatus } from "@/app/projects/[id]/setup/ingestion-status";
import { getDatabaseUrl, getDb } from "@/db/client";
import { projectKeys } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { EVENT_NAMES } from "@/lib/ingest-events";
import { getOwnedProject } from "@/lib/ingestion-health";
import { ensureDeveloperRecord } from "@/lib/projects";

export const dynamic = "force-dynamic";

export default async function SetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const developer = await requireUser();
  if (!getDatabaseUrl()) {
    return (
      <main>
        <h1>接入 PayLens</h1>
        <p className="error">缺少 DATABASE_URL。</p>
      </main>
    );
  }

  const db = getDb();
  await ensureDeveloperRecord(db, developer);
  const project = await getOwnedProject(db, id, developer.id);
  if (!project) notFound();
  const keys = await db.select().from(projectKeys).where(eq(projectKeys.projectId, project.id));
  const activeKey = keys.find((key) => key.status === "active");

  return (
    <main>
      <p>
        <Link href="/projects">返回项目</Link>
        {" · "}
        <Link href={`/projects/${project.id}/overview`}>概览</Link>
        {" · "}
        <Link href={`/projects/${project.id}/insights`}>报告</Link>
      </p>
      <h1>接入 {project.name}</h1>
      <p className="muted">时区 {project.timezone}</p>
      <IngestionStatus projectId={project.id} expectedCount={EVENT_NAMES.length} />
      <h2>1. 安装</h2>
      <pre>{`pnpm add @paylens/react-native @react-native-async-storage/async-storage
pnpm add expo-application`}</pre>
      <h2>2. 初始化</h2>
      <p className="muted">不传 appVersion 时，SDK 会尝试读取 expo-application。</p>
      <pre>{`import { PayLens } from "@paylens/react-native";

PayLens.init({
  clientKey: "${activeKey?.key ?? "pl_pub_…"}",
  endpoint: "http://localhost:3000/v1",
  paywallVersion: "A",
});`}</pre>
      <h2>3. 在 Paywall 上发送 4 个事件</h2>
      <pre>{`PayLens.track("paywall_viewed");
PayLens.track("subscribe_clicked", { productId: "pro_monthly" });
PayLens.track("paywall_closed");
PayLens.track("purchase_success", { productId: "pro_monthly" });`}</pre>
      <h2>4. 退出调查</h2>
      <pre>{`PayLens.track("paywall_closed");
if (PayLens.shouldShowExitSurvey()) setSurveyVisible(true);

<PayLensExitSurvey visible={surveyVisible} onClose={() => setSurveyVisible(false)} />`}</pre>
      <p className="muted">
        Client Key 是公开 key，会放进 App。购买成功如果发生在关闭后 10 分钟内，仍算同一次 Paywall。
        已经购买成功的不再出现调查。默认 7 天内只问一次，选「其他」才出现输入框。
      </p>
    </main>
  );
}
