# Phase 7 细化计划：可信指标层与分群

> 状态：待审核。通过之前不改业务代码、不做 migration、不提交。
> 依据：`docs/design-v0.2.md` 里已确认的 Phase 7。
> 这一期只做一件事：让现有付费页数据能按平台和版本拆开，并且每个数字都能追溯。不采集产品行为，不做留存，不做订阅状态，不做 Agent。

## 0. 要不要先 commit / push

不需要。写这份计划不依赖 Git。`docs/design-v0.2.md` 和本文件目前都还没进版本库。等你审过这份计划，再把两份文档一起提交。push 可以再等：杭州服务器不是从 GitHub 拉代码，推不推都不影响下一步。

不要提交 `apps/web/tsconfig.tsbuildinfo`。

## 1. 做完之后你能看到什么

打开概览，除了现在的整体漏斗，还可以：

- 按平台（iOS / Android）、App 版本、付费页版本筛选。
- 看一张分群表：每一组的展示次数、点击、购买、转化率。人数太少的组不显示具体数字。
- 看「变化来自哪里」：整体转化变了多少，是某一组自己变差了，还是各组占比变了。
- 支付失败单独计数。用户自己取消和支付报错分开，取消不算购买失败。

长高一点这一期只多报一个事件：华为支付返回错误或用户取消时，发送 `purchase_failed`。不改付费页文案，不做 A→B。那仍是 Phase 6 的事。

## 2. 实现顺序

按这个顺序做。每一步都能单独验证，做完再进入下一步。

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 数据库加列，接入接受 `purchase_failed` 和可选的 `sdk_version` | 旧的 4 个事件照常入库；新事件带失败类型；缺字段的旧请求不被拒绝 |
| 2 | 抽出指标计算，概览、反馈、报告改为调用它 | 现有 `verify-phase2` 到 `verify-phase4` 的数字与改前一致 |
| 3 | 平台筛选、分群、变化拆解、小样本规则 | 分组加总等于整体；拆解加总等于总变化；样本不足不显示比率 |
| 4 | 评论主题写回反馈表，报告引用证据编号 | 同一条评论不会每次生成报告都重新归类 |
| 5 | 概览页面加上筛选和两张表 | 打开页面能看；深链带着同一组筛选条件 |
| 6 | 长高一点在支付失败时调用 SDK | 另开一轮，不放进 PayLens 这一期的代码 |

## 3. 数据库变更（草案，审核前不执行）

新文件 `apps/web/drizzle/0005_phase7.sql`，并在 `drizzle/meta/_journal.json` 登记。

```sql
ALTER TABLE events ADD COLUMN failure_kind text;
ALTER TABLE events ADD COLUMN sdk_version text;
ALTER TABLE events ADD CONSTRAINT events_failure_kind_check
  CHECK (failure_kind IS NULL OR failure_kind IN ('user_cancelled', 'payment_error', 'unknown'));

ALTER TABLE feedback ADD COLUMN sdk_version text;
ALTER TABLE feedback ADD COLUMN theme text;
ALTER TABLE feedback ADD COLUMN theme_version text;

CREATE INDEX events_viewed_idx
  ON events (project_id, occurred_at)
  WHERE event_name = 'paywall_viewed';
```

说明：

- 都是新增列，旧行保持为空。不改已有数据，不删数据。
- `failure_kind` 只允许 `purchase_failed` 填写。应用层保证这一点；数据库只限制取值。
- 索引用普通 `CREATE INDEX`，放进 Drizzle 的迁移事务里。现在事件表只有很少几行，锁表可以忽略。设计文档里的 `CONCURRENTLY` 留给以后表变大时再手工做，因为那种写法不能放在 Drizzle 的事务迁移里。
- 回滚：删这三列和这个索引。已写入的 `purchase_failed` 行要先删掉，否则删列没有问题，但事件名会留在表里变成白名单之外的历史行。回滚脚本写在迁移文件顶部的注释里，不自动执行。
- 生产执行方式和以前一样：你在杭州服务器或 Supabase SQL Editor 里跑。本地 `pnpm db:migrate` 只用于你自己的库。这一期不从这里远程改生产库。

`schema.ts` 同步加上这些列。

## 4. 事件规则

`purchase_failed` 加入 `apps/web/src/lib/ingest-events.ts` 的 `EVENT_NAMES`，以及 SDK 的 `packages/sdk/src/session.ts`。

| 字段 | 规则 |
|---|---|
| `failure_kind` | 必填，只能是 `user_cancelled`、`payment_error`、`unknown`。别的值整条拒绝 |
| `product_id` | 允许，规则与 `subscribe_clicked` 相同 |
| 其他四个事件 | 如果带了 `failure_kind`，整条拒绝 |
| `sdk_version` | 可选，最长 32 字符。不带就存空，旧版 App 不受影响 |

会话规则：

- 有打开的付费页会话时，失败记在这次会话上。
- 不把会话标成已购买，也不把它关掉。用户还可以重试。
- 没有打开的会话时，照旧单独记一条，算孤儿，不进漏斗。和现在的 `subscribe_clicked` 一样。
- `user_cancelled` 不进入「支付失败率」。失败率 = 有 `payment_error` 的会话数 / 有点击的会话数。取消单独显示次数。

SDK 每次上报都带上 `packages/sdk/src/version.ts` 里的版本字符串。反馈也带。队列里的旧事件没有这个字段，服务器照常接受。

## 5. 指标模块

新建 `apps/web/src/lib/metrics/`。概览、反馈统计、报告快照改为调用这里，不再各自复制「找出本期 paywall_viewed」那段 SQL。

这一期实现的工具，输入输出按 `design-v0.2.md` 的 H 节信封：

- `getPaywallFunnel`
- `comparePeriods`
- `breakdownMetric`（维度只允许 `platform`、`app_version`、`paywall_version`、`product_id`）
- `getFeedbackReasons`
- `getFeedbackThemes`
- `getIngestionHealth`
- `getProjectContext`
- `listDimensionValues`

共同规则：

- 日期按项目时区解释，查询改成 `occurred_at` 的 UTC 区间，好用上索引。今天仍标成不完整。
- `asOf`：只计入 `received_at` 不晚于这个时间的行。同一次页面打开或同一次报告使用同一个 `asOf`，结果可以重跑。
- 样本规则按设计文档 G 节：一组少于 5 人不显示数字；分母少于 30 不显示比率；30 到 99 显示比率和 Wilson 95% 区间并标小样本；两组区间重叠则写「看不出差别」。
- 变化拆解：组内变化 = 上期占比 ×（本期转化 − 上期转化）；占比变化 =（本期占比 − 上期占比）× 本期转化。各组相加等于整体变化。
- 不返回 `anonymous_user_id`。
- `product_id` 只在点击和购买这一层拆，不把「看到付费页」按产品拆开，因为看到付费页时还没有产品。

现有门槛数字不改：100 次会话、20 条反馈、单个原因 30 条。它们继续只挡住 AI 假设，不挡住概览上的确定性数字。

## 6. 要改的文件

PayLens 仓库：

| 文件 | 改什么 |
|---|---|
| `apps/web/src/db/schema.ts` | 新列 |
| `apps/web/drizzle/0005_phase7.sql`、`drizzle/meta/_journal.json` | 迁移 |
| `apps/web/src/lib/ingest-events.ts` | 新事件、失败类型、sdk 版本 |
| `apps/web/src/lib/ingest-feedback.ts` | 可选 `sdk_version` |
| `apps/web/src/lib/metrics/*` | 新模块 |
| `apps/web/src/lib/funnel.ts` | 改成调用指标模块，保留现有返回形状，供页面和旧测试使用 |
| `apps/web/src/lib/feedback-stats.ts`、`snapshot.ts`、`report-facts.ts` | 同上；事实句增加 `class` 和 `evidence_id` |
| `apps/web/src/lib/reports.ts` | 归类后把主题写回 `feedback.theme`；已有主题的评论不再送给模型 |
| `apps/web/src/lib/period.ts` | 筛选增加 `platform` |
| `apps/web/src/app/projects/[id]/overview/page.tsx` | 平台筛选、分群表、变化来源表 |
| `apps/web/src/app/api/projects/[id]/overview/route.ts`、`filters/route.ts` | 接受 `platform` |
| `apps/web/src/app/projects/[id]/feedback/page.tsx`、`insights/page.tsx` | 筛选条带上平台，链到同一组条件 |
| `apps/web/scripts/verify-phase7.ts` | 新测试；`package.json` 的 `verify` 接上 |
| `packages/sdk/src/session.ts`、`index.ts`、`version.ts`、`verify.ts` | 新事件和 sdk 版本 |
| `examples/expo-demo/App.tsx` | 演示按钮增加「支付失败」，避免示例和真实事件名单脱节 |

长高一点（另一个仓库，Phase 7 的 PayLens 代码合并思路确定后再改）：

- `mobile/src/screens/SubscriptionScreen.js`：华为支付返回取消时发 `user_cancelled`，其他失败发 `payment_error`。用户没点订阅就离开，仍然只发 `paywall_closed`，不发失败。
- 不在这一期重打安装包。内存队列的问题留到 Phase 8 之前。

## 7. 测试

新脚本 `verify-phase7.ts` 用 PGlite，沿用现有脚本的写法。

必须覆盖：

1. 把 Phase 2 到 Phase 4 已有的手工数据再算一遍，会话数、点击、购买、关闭未购买、回答率与现在一致。
2. 一组 iOS、一组 Android，两组相加等于不筛选的整体。
3. 构造「每组转化没变、但 Android 占比上升」的数据，整体下降应主要出现在占比变化上，而不是组内变化。
4. 分母 0、29、30、99、100 时，显示规则符合第 5 节。
5. 同一批数据用同一个 `asOf` 算两次，结果相同；把 `asOf` 设到新事件到达之前，新事件不计入。
6. 上海时区当天 0 点前后的事件落在正确的本地日期。
7. 不带 `sdk_version` 的旧请求返回 200；`purchase_failed` 缺少或写错 `failure_kind` 时只拒绝这一条。
8. `user_cancelled` 不增加失败率，也不把会话算成已购买。
9. 已有 `theme` 的评论不会再次进入归类请求。

SDK 的 `verify.ts` 增加：`purchase_failed` 带上 `failure_kind` 和 `sdk_version`，并且不把会话标成已购买。

不新增依赖。Wilson 区间用一小段自写函数，输入 0、1 和中间值各测一次。

## 8. 明确不做

- 行为事件、`trackEvent`、事件登记表。
- 留存、激活、订阅表、`pl_sec_`。
- Agent、提问页、主动信号。
- 新的调查类型，或把冷却改成 30 天。长高一点保持现在的 7 天退出调查。
- 统计显著性结论。页面只说「看不出差别 / 弱信号 / 清楚」，不说「显著」。
- 超过两层的下钻。这一期页面只做一层分群，加上筛选。
- 发布 SDK 到 npm。
- 在这一期改生产库。迁移等审核通过、代码在本地验证之后，再单独请你执行。

## 9. 风险

| 风险 | 处理 |
|---|---|
| 抽出 SQL 后数字和现在不一致 | 第 2 步以旧测试为门槛，不一致就不进入第 3 步 |
| 长高一点样本仍然只有 1 次展示 | 页面显示「样本不足」，这是正确结果，不凑数 |
| 迁移在生产执行 | 只加列和索引；执行前把回滚语句放在手边 |
| 主题写回失败 | 报告仍用本次归类结果；写回失败记在日志里，不让整份报告失败 |

## 10. 请你确认的点

1. 同意按第 2 节的 6 步做，做完第 5 步再改长高一点。
2. 同意失败率只算 `payment_error`，用户取消单独计数。
3. 同意索引用普通 `CREATE INDEX`，不在这次迁移里用 `CONCURRENTLY`。
4. 同意审核通过后再提交文档、再写代码。生产迁移另一次确认。
