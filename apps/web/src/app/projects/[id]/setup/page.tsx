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
        {" · "}
        <Link href={`/projects/${project.id}/settings`}>设置</Link>
      </p>
      <h1>接入 {project.name}</h1>
      <p className="muted">时区 {project.timezone}</p>
      <IngestionStatus projectId={project.id} expectedCount={EVENT_NAMES.length} />

      <h2>隐私提示（给开发者，非法律意见）</h2>
      <ul>
        <li>
          App Store 隐私标签：Identifiers → User ID（不与用户关联，用于分析）、Usage Data → Product
          Interaction；若开启文字评论，再勾选 User Content → Other User Content。不涉及 ATT（无 IDFA、无跨
          App 追踪）。
        </li>
        <li>GDPR：分析类处理需要合法基础；隐私政策里应提及 PayLens 作为处理方。</li>
        <li>
          PIPL：若终端用户在中国大陆而服务器在境外，涉及跨境传输，请结合你的部署位置自行评估。
        </li>
        <li>
          开发者与 PayLens 之间理论上需要 DPA；V0.1 自用可先不做，对外开放前再补。
        </li>
        <li>
          数据保留：events / feedback 默认 365 天后删除；可按 anonymous_user_id 删除，也可清空项目数据。详见
          <Link href={`/projects/${project.id}/settings`}>项目设置</Link>。
        </li>
      </ul>

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
