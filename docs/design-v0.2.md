# PayLens V0.2 设计：Phase 7–12

> 状态：设计已确认（2026-09-25）。Phase 7.0 已在生产库完成：7 张表已开启 RLS、无放行策略。Phase 7 细化计划见 `docs/phase-7-plan.md`，审核通过前不写功能代码。
> 前置文档：`docs/design-v0.1.md`。本文件不替代它；V0.1 的规则（session、孤儿事件、错误分类、事实由代码生成）继续有效。
> 长期方向：从订阅转化工具演进为面向独立 App 开发者的数据分析 Agent。主线仍然是订阅，不做通用分析平台。

## 已确认的决策

| # | 决策 |
|---|---|
| 1 | 先做 7.0 安全收口，再进入 Phase 7 |
| 2 | Phase 6 继续：真实使用、出第一份报告、做一次付费页 A→B |
| 3 | 顺序调整：订阅生命周期从第 7 期挪到第 10 期 |
| 4 | 分析工具层不单独成一期：从 Phase 7 起每个指标以工具形式写出，Dashboard 和 Agent 共用同一个计算函数 |
| 5 | 不做 `identify`；不支持事件属性 |
| 6 | 调查预算默认每个安装 30 天最多 1 次；只开退出调查时最低可调到 7 天 |
| 7 | `purchase_failed` 放进 Phase 7 |
| 8 | 行为事件单独放 `product_events` 表 |
| 9 | Agent 只用一张 `agent_runs` 表，工具调用放在 `steps` 里 |
| 10 | Phase 12 的 LLM 判断层推迟，先用确定性规则 |

---

## A. 现有架构审计（2026-09-25）

### A1. Phase 0–6 实际状态

| Phase | 实际实现 |
|---|---|
| 0 | pnpm monorepo；Next.js 15 + Drizzle + postgres.js；Supabase magic link；`developers` / `projects` / `project_keys`；建项目自动生成 `pl_pub_` key；时区在应用层校验 |
| 1 | `POST /v1/events`：4 个事件白名单、UUID 校验、每批 ≤ 50、≤ 64KB、时间钳制（未来 5 分钟 / 过去 7 天）、`(project_id, event_id)` 幂等、UTC 日配额 10 万。SDK 队列与退避，只有 `key_revoked` 停止该 key 重试 |
| 2 | Overview 按 paywall session 计数；10 分钟购买归属窗；孤儿 session 只进接入健康 |
| 3 | `POST /v1/feedback`，脱敏、≤ 300 字；SDK 自带调查组件，本地冷却 7 天 |
| 4 | Snapshot → 代码生成 facts / key_changes → AI 主题归类 → AI 假设与建议 → 数字与引用校验；样本不足只存事实 |
| 5 | Settings：时区、key 三态、按 `anonymous_user_id` 删除、清空项目；pg_cron 按 `retention_days` 删除 events / feedback |
| 6 | 进行中。杭州服务器可达；长高一点开发版上报了 viewed / closed 和 1 条反馈（开发者本人测试）。未到门槛、未出报告、未做 A→B |

测试：6 个 `apps/web/scripts/verify-phase*.ts`（PGlite + assert）和 `packages/sdk/src/verify.ts`。没有 CI；pg_cron 迁移无法在 PGlite 中测试；没有页面级测试。

### A2. 与 V0.1 设计的差异

1. 部署：长高一点实际使用杭州 ECS（手动上传、systemd、Nginx），Vercel 在开发者网络下打不开。仓库里没有 Dockerfile 和部署脚本，生产迁移靠手动执行。
2. SDK 的 AsyncStorage 从必需变成可选（`dcb9661` 内存兜底）。没有原生模块时，匿名 id、队列和调查冷却只在本次进程内有效，服务器不知道。
3. 未知平台静默记为 `ios`。
4. 评论主题不按条保存，每次生成报告重新归类。
5. Supabase 公开表没有开启 RLS（安全顾问已标红），见 Phase 7.0。
6. 漏斗的「最早一次 viewed」查询扫描项目全部历史；日期过滤用 `to_char(... AT TIME ZONE ...)`，用不上索引；接入健康每次统计全表。
7. 反馈不计入日配额。
8. SDK 默认 endpoint 和接入页示例仍是 `localhost`。

与设计一致：session 终止规则、孤儿 session、10 分钟归属窗、key 三态、样本门槛、事实由代码生成、AI 输出校验。

### A3. 可复用的结构

- events / feedback 的幂等写法和逐条拒收。
- `lib/period.ts` 的项目时区与自然日工具。
- `lib/thresholds.ts` 集中管理门槛。
- `buildFacts` + `validateInference`：代码写事实、模型只能引用事实 id、数字与因果词校验。
- `AiProvider` 抽象，`AI_BASE_URL` 可接其他兼容 OpenAI 的供应商。
- `getOwnedProject` 统一项目隔离。
- key 三态流转，可套用到服务端 key。
- PGlite 验证脚本写法；SDK 的队列、退避和错误分类。

### A4. 会限制下一阶段的结构

- `events.paywall_session_id` 为 NOT NULL，`EVENT_NAMES` 是全局写死的 4 个名字，产品行为没有地方放。
- 「找到本期 session」的 SQL 在 `funnel.ts`、`snapshot.ts`、`feedback-stats.ts` 中复制了 4 份。
- 没有「安装」概念、`sdk_version` 和存储模式，留存没有稳定锚点。
- 筛选只有 `app_version` 和 `paywall_version`。
- `ai_reports` 围绕「一个周期」设计，不适合「一个问题的一次调查」。
- 只有公开 key，没有服务端到服务端认证。
- 定时任务只有 pg_cron，只能跑 SQL。
- 调查没有类型字段。

### A5. 将来需要的 migration（本文件不执行）

见 K 节。

### 接入方观察（长高一点，不属于 PayLens）

长高一点服务端配置的产品是月付 ¥5 / 年付 ¥40，付费页显示年度 ¥39 / 终身 ¥69。按它的核验逻辑，真实购买会被判为 `PRODUCT_MISMATCH`，会影响 PayLens 收到的购买数据。长高一点也还没有接华为订阅通知，服务端只能提供「购买已核验」一个事实。

---

## B. 产品演进

### B1. 定位

从「付费页为什么没转化」扩展到「订阅业务里发生了什么、可能为什么」。每一种新数据都必须能帮助回答订阅相关问题。

四个能力台阶：看见（Dashboard 确定性展示）→ 解释（证据分级）→ 调查（Agent 调用工具）→ 提醒（主动信号）。

### B2. 证据分级

每条事实带 `class`，文字由代码模板生成，校验器按类别检查措辞。

| 类别 | 来源 | 允许的说法 | 不允许的说法 |
|---|---|---|---|
| measured | 漏斗、计数、比率 | 「整体转化 7.8%，上期 8.2%」 | 解释原因 |
| direct | 用户主动反馈 | 「回答者中 38% 选了价格（回答率 21%）」，必须同时写回答率 | 「38% 的用户因为价格没买」 |
| behavioral | 分组对比 | 「做过核心行为的组 X%，没做过的组 Y%，这只是相关」 | 「因为没用核心功能所以没买」 |
| hypothesis | AI 综合证据 | 「一个值得验证的假设是…」，必须引用证据 | 「原因是…」「证明了…」 |
| test | AI 生成 | 「把 X 改成 Y，观察 Z」，必须挂在某条假设下 | 没有观察指标的建议 |

置信度上限由代码强制：引用证据中有样本不足 → 最高「低」；只有 behavioral 证据 → 最高「中」；「高」要求 direct 与 behavioral 方向一致且都是清楚信号。

### B3. 调查预算（Survey Policy）

- 大多数分析只用行为数据；调查是补充证据。
- 每种调查需开发者在 `init` 中显式开启；服务器不能远程触发。
- 全局预算：每个安装 30 天内最多 1 次调查（所有类型合计）；项目只开启付费页退出调查时，最低可调到 7 天。
- 多种调查同时满足条件时，付费页退出调查优先。
- 只在自然结束点出现（关闭付费页后、完成一个流程后），不在启动时、不打断操作。
- 一定可跳过；最多 5 个选项；评论不强制；弹出即算看过。
- 冷却只记在本机，重装重置，写入接入文档。
- 7–12 期不新增调查类型：取消订阅发生在商店设置里，App 捕捉不到；长高一点没有试用，无法验证试用调查。出现第二种调查时再加 `feedback.survey_type`，并把 SDK 的 `lastSurveyShownAt` 升级为按类型的调查历史。

---

## C. Phase 7–12 路线

| Phase | 内容 | 依赖 | 理由 |
|---|---|---|---|
| 7.0 | 安全收口：Supabase 权限 / RLS | 无 | 采集更多数据前先关闭公开读写风险 |
| 7 | 可信指标层 + 现有字段分群 + `purchase_failed` | 7.0 | 不需要新数据；后续所有阶段建在这一层上 |
| 8 | 产品行为（受约束的事件登记）+ 安装身份稳定 | 7 | 每天产生数据；直接回答「是否还没体验价值就看到付费页」 |
| 9 | 激活与留存 | 8，外加 ≥ 5 周数据 | 需要行为数据和稳定身份 |
| 10 | 订阅生命周期（服务端可信） | 7 | 长高一点只有年付和终身、无试用，续费事实一年后才出现；接入有试用或月付的 App 时可与 9 对调 |
| 11 | 调查 Agent（只读、手动提问） | 7–9 | 工具足够多才值得做 |
| 12 | 主动信号 | 11 | 先确定性规则，判断模型以后接 |

复杂度用相对大小：S = 几天，M = 1–2 周，L = 数周，XL = 一个多月。

### Phase 7.0　安全收口（S；改生产数据库权限，执行前需确认）

- 先只读确认：公开表的 RLS 状态，以及 anon / authenticated 角色的表权限。
- 确认存在风险后，给所有 public 表开启 RLS、不写策略。PayLens 应用使用 postgres 角色，不受 RLS 限制。
- 回滚：`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`。
- 完成标准：anon key 读写每张表都被拒绝；Dashboard 与数据上报正常。

### Phase 7　可信指标层与分群（M–L）

- **产品目标**：每个数字都能追溯到算法、时间范围和筛选条件；能从整体下钻到平台、版本、付费页版本和产品。
- **能回答的问题**：转化真的变了吗，还是波动？变化集中在哪个平台或版本？是组内变差，还是各组占比变了？
- **新数据**：客户端 `purchase_failed`；其余用现有字段。
- **新事件 / 状态**：`purchase_failed`，带 `failure_kind`（`user_cancelled` / `payment_error` / `unknown`）。
- **数据库**：`events` 加 `failure_kind`、`sdk_version`；`feedback` 加 `sdk_version`、`theme`、`theme_version`；viewed 部分索引。
- **SDK**：`track("purchase_failed", { productId, failureKind })`；每条上报带 `sdk_version`。
- **后端**：新建 `lib/metrics/`：统一 session 查询、证据信封、`as_of` 截止时间、Wilson 置信区间、变化贡献拆解；overview、feedback 和报告改为调用它；日期过滤改为 UTC 时间区间。
- **Dashboard**：平台筛选；Overview 分群表（置信区间、小样本标记）；「变化来自哪里」表；数字可深链。
- **AI**：报告 Snapshot 由工具信封拼装；fact 带 `class` 和 `evidence_id`；评论主题按条保存。
- **隐私**：单元格人数 < 5 不显示；`purchase_failed` 无个人信息。
- **测试**：新旧实现结果一致；分组求和等于整体；贡献拆解相加等于总变化；`as_of` 重跑一致；置信区间边界；时区边界；旧 SDK 格式仍被接受。
- **迁移风险**：低到中；大表建索引用 `CONCURRENTLY`，不能放在事务中。
- **完成标准**：Dashboard 数字全部出自 metrics 模块；四个维度可分群；一致性测试通过；报告事实可追溯到证据 id。
- **明确不做**：行为事件、留存、订阅状态、Agent、统计显著性结论、超过 2 层的下钻。

### Phase 8　产品行为（L）

- **产品目标**：知道用户是否体验到核心价值，尤其是在看到付费页之前。
- **能回答的问题**：看付费页前做过核心行为吗？做过的人点击和购买率是否不同？引导完成率？
- **新数据**：只有事件名的行为事件；可选 `app_opened`；存储模式标记。
- **新事件 / 状态**：内置 `app_opened`、`onboarding_started`、`onboarding_completed`；开发者登记最多 20 个。
- **数据库**：`product_events`、`event_definitions`；`project_daily_usage` 加拒收计数；过期删除与按用户删除覆盖新表。
- **SDK**：`trackEvent(key)`（不碰付费页 session）；`init({ appOpens: true })`；队列满时先丢行为事件；本地状态加版本号。
- **后端**：`/v1/events` 按条区分付费页事件和行为事件；未登记事件名逐条拒收并计数；登记表内存缓存 60 秒。
- **Dashboard**：Settings「事件登记」；接入页显示每个事件最近收到时间；按「看付费页前是否做过核心行为」拆分漏斗。
- **AI**：工具 `get_event_adoption`、`get_paywall_context`，产出 behavioral 证据。
- **隐私**：事件名格式 `^[a-z][a-z0-9_]{2,40}$`；不允许属性，健康数值无法随事件上报。长高一点上线前需更新隐私政策与第三方 SDK 清单。
- **测试**：登记校验；未登记事件不影响整批；行为事件不改变漏斗；「付费页前是否做过」考虑时间先后与时区；去重；配额；删除；SDK 队列优先级。
- **迁移风险**：低；过期删除函数需手动在生产更新。
- **完成标准**：长高一点上报 3–5 个登记事件；拆分漏斗受样本门槛约束；只发旧事件的 App 不受影响。
- **明确不做**：事件属性、自动采集、屏幕追踪、单个用户时间线、路径分析、自定义漏斗。

### Phase 9　激活与留存（M）

- **产品目标**：看出哪些早期行为与留下来有关。
- **能回答的问题**：D1 / D7 / D30？完成引导或激活的人是否留得更久？新版本的新用户留存是否不同？
- **新数据**：无；需要 Phase 8 后 ≥ 5 周数据且身份持久。
- **数据库**：`projects` 加激活规则（事件名、最少次数、天数）；`product_events` 用户 + 时间索引。不建 cohorts 表。
- **SDK**：存储只在内存时控制台提示。
- **后端**：见 F 节。
- **Dashboard**：周同期群表、两组留存曲线、激活卡片，标出人数和未满观察期。
- **AI**：工具 `get_retention`、`get_activation`。
- **隐私**：无新增数据。
- **测试**：手算同期群；未满观察期；夏令时；排除内存安装；100 万事件查询耗时。
- **迁移风险**：低。
- **完成标准**：与手算样例一致；数据不足时正确显示样本不足。
- **明确不做**：保存同期群、预测流失、LTV、按图表自定义留存口径。

### Phase 10　订阅生命周期（L）

- **产品目标**：用服务端可信事实回答试用转化、续费、取消、扣费失败、退款。
- **能回答的问题**：试用转化多少？多少人关自动续费？扣费失败后恢复多少？客户端与服务端购买对得上吗？
- **新数据**：开发者后端用 `pl_sec_` 上报的订阅事件；RevenueCat 适配器可选。
- **数据库**：`project_server_keys`、`subscription_events`、`subscriptions`。
- **SDK**：只加 `getInstallId()`。
- **后端**：`POST /v1/subscription-events`：统一格式、幂等、状态可从事件重算、区分沙盒。
- **Dashboard**：各状态订阅数、生命周期漏斗、取消 / 扣费失败 / 退款趋势、客户端与服务端对账。
- **AI**：4 个订阅工具（见 H 节）。
- **隐私**：交易号哈希后存；不存收入金额。
- **测试**：状态机逐条；乱序；重复；退款；扣费失败恢复；重新订阅；沙盒排除；重算与逐条更新一致。
- **迁移风险**：中（新认证方式、密钥）。
- **完成标准**：长高一点后端或测试脚本上报已核验购买；状态与对账可见；重放测试通过。
- **明确不做**：直连苹果 / Google / 华为通知；发放会员权益；MRR、LTV；试用与取消调查；价格实验。
- **外部依赖**：长高一点需自行接华为订阅通知，才能提供续费与到期事实。

### Phase 11　调查 Agent（L）

- **产品目标**：针对「为什么」按计划调用工具调查，并能说「数据不足」。
- **新数据**：无。
- **数据库**：`agent_runs`。
- **后端**：工具注册表、调查循环、预算控制、汇总、校验；后台执行、前端轮询。
- **Dashboard**：「提问」页，展示每一步工具、证据卡片、深链和最终报告。
- **完成标准**：评测集达标（N 节）；报告中无来源不明的数字；单次成本在上限内。
- **明确不做**：自由 SQL、写操作、跨项目、针对具体用户、自主定时调查。

### Phase 12　主动信号（确定性规则 M；判断模型以后）

- 设计见 I4。
- **完成标准**：纯噪声合成数据每月误报 ≤ 1 条；植入的变化能被发现。
- **明确不做**：推送通知、实时告警；第一版无 LLM 判断。

---

## D. 订阅生命周期

### D1. 数据来源

| 来源 | 优点 | 代价 | 第一版 |
|---|---|---|---|
| 开发者后端调用 PayLens 服务端接口 | 适用于苹果、Google、华为；开发者本来就在核验票据；PayLens 不保管商店凭证 | 开发者写转发代码；续费事实取决于他是否接了商店通知 | 做 |
| RevenueCat webhook | 事件已统一格式，能区分试用 | 只适用于 RevenueCat 用户；不覆盖华为 | 可选，有真实需求再做 |
| App Store Server Notifications v2 | 事实最完整 | 需验证 JWS 证书链；每个 App 单独配置 | 推迟 |
| Google Play RTDN | 实时 | 需用服务账号调 Play API，PayLens 要保管高价值密钥 | 推迟 |
| 华为订阅通知 | 国内安卓需要 | 同样需调华为接口 | 推迟，由开发者后端处理 |

### D2. 事件、状态与推导事件

- 服务端事件（追加写入 `subscription_events`）：`purchased`（`period_type`：trial / intro / normal）、`renewed`、`auto_renew_disabled`、`auto_renew_enabled`、`billing_issue`、`billing_recovered`、`expired`、`refunded`、`product_changed`。
- 状态（`subscriptions`，由事件推导）：`status` ∈ {trial, active, billing_issue, expired, refunded}，加独立字段 `will_renew`。「已取消、到期前仍有权益」= status 为 trial / active 且 `will_renew = false` 且当前时间早于 `current_period_end`。free = 无记录，或 expired / refunded。
- 推导事件（查询时计算，不存）：`trial_started`、`trial_converted`、`trial_expired`、`subscription_started`、`subscription_cancelled`（= auto_renew_disabled）、`billing_failed`、`refund`。
- 客户端事件：保留 `purchase_success`（用于付费页归属），新增 `purchase_failed`。客户端不能设置订阅状态。

### D3. 状态转换

| 当前 | 事件 | 变为 |
|---|---|---|
| 无记录 | purchased（trial） | trial，会续费 |
| 无记录 | purchased（normal） | active |
| trial | renewed | active（推导 trial_converted） |
| trial / active | auto_renew_disabled / enabled | 状态不变，翻转 will_renew |
| trial / active | billing_issue | billing_issue，按商店宽限期决定权益 |
| billing_issue | billing_recovered / renewed | active |
| 除 refunded 外 | expired | expired |
| 任何 | refunded | refunded，权益立即结束 |
| expired / refunded | purchased | 新一轮 trial 或 active，本轮字段重置 |

### D4. 可靠性

- 幂等：`UNIQUE (project_id, source, source_event_id)`。开发者后端需提供确定性 `event_id`（建议用交易号 + 事件类型生成 UUIDv5）。
- 延迟与乱序：按 `effective_at` 排序；每写入一条就重算该订阅状态；最多接受 400 天前的事件。
- 只报购买、没报后续：`current_period_end` 过去超过 1 天且无续费时，不改状态，由工具标注「状态可能过期」。
- 恢复购买：对已存在且有效的订阅是空操作；客户端不发 `purchase_success`。
- 退款：按退款时间统计；购买后很快退款单独标记；付费页漏斗不回溯，差异由对账工具展示。
- 扣费失败：统计失败率与恢复率。
- 关联客户端：App 用 `getInstallId()` 把安装 id 交给自己的后端，后端上报时带上；RevenueCat 用户可用自定义属性 `paylens_install_id`。重装或换设备后续费仍挂在最初的安装上。

---

## E. 产品行为模型

- 付费页事件留在 `events`（有 session 语义）；行为事件放 `product_events`（无 session）。旧漏斗查询不变，行为事件的量级、配额、保留期可单独管理。
- 事件登记：每项目最多 20 个；`role` ∈ {core（最多 3 个）, onboarding, other}；显示名；启用 / 归档。无属性、无版本管理。
- 激活（Phase 9）：一条规则 = 事件 + 最少次数 + 首次出现后天数。
- 长高一点示例：建档时会自动写入一条初始身高记录（`saveGrowthProfileWithInitialRecord`），所以「记了一次身高」不能说明体验到价值。建议登记 `growth_record_added`（core，激活要求 ≥ 2 次）、`trend_viewed`、`stage_review_viewed`（core）、`reminder_enabled`。
- 不做：自动采集、屏幕浏览、事件属性、事件管理平台。

---

## F. 留存模型

- 安装首次出现：两张事件表中最早的 `occurred_at`，按项目时区取自然日；排除 `storage_mode = memory`。
- 活跃日：项目本地某天有任何行为事件、`app_opened` 或付费页事件。
- 口径：Dn = 第 n 天活跃（D1 / D7 / D30）；Rn = 第 1 至 n 天任意一天活跃（R7 / R30）。低频工具优先看 R30。
- 未满观察期：只把第 n 天已完整过去的同期群计入分母，并标明人数。
- 同期群：按首次出现的自然日或周分组，查询时现算。
- 对比：是否激活、是否完成引导、首次版本、平台、第 N 天内是否做过核心行为。措辞一律为行为关联。

---

## G. 分群模型

- 维度：Phase 7 `platform`、`app_version`、`paywall_version`、`product_id`（仅点击 / 购买层）；Phase 8 `core_before_paywall`；Phase 9 `activated`；Phase 10 `subscription_state`、`trial_state`；`acquisition_channel` 只预留。
- 所有工具共用同一套筛选对象；一次最多下钻 2 层。
- 变化贡献拆解：组内变化 = 上期占比 ×（本期转化 − 上期转化）；占比变化 =（本期占比 − 上期占比）× 本期转化；所有组相加等于整体变化。可识别组成变化（辛普森悖论）。

| 规则 | 值 |
|---|---|
| 组人数 < 5 | 不显示具体数字 |
| 分母 < 30 | 不显示比率，写「样本不足」 |
| 分母 30–99 | 显示比率 + Wilson 95% 区间，标「小样本」 |
| 分母 ≥ 100 | 正常显示 |
| 两组对比 | 区间重叠 → 看不出差别；不重叠但一边 < 100 → 弱信号；不重叠且都 ≥ 100 → 清楚 |

- 多重比较：只展示达标的组，下钻 ≤ 2 层，注明比较了多少组。

---

## H. 分析工具目录

### H1. 统一输入输出

```ts
type Period = { from: string; to: string }; // 项目本地自然日，含两端，最多 366 天
type Filters = {
  platform?: "ios" | "android"; app_version?: string; paywall_version?: string; product_id?: string;
  core_before_paywall?: boolean; activated?: boolean; subscription_state?: string;
};
type Envelope<R> = {
  evidence_id: string;
  tool: string; tool_version: string;
  args: object;
  timezone: string; as_of: string; data_through: string; // 只计入 received_at ≤ as_of 的数据
  definitions: Record<string, string>;
  sample: { unit: "paywall_session" | "install" | "feedback" | "subscription";
            n: number; required: number; status: "ok" | "low_sample" | "insufficient" };
  result: R;
  facts: { id: string; class: "measured" | "direct" | "behavioral"; text: string; source: string }[];
  caveats: string[];
};
type ToolError = { code: "invalid_argument" | "unsupported_dimension" | "data_not_collected"
                   | "period_out_of_range" | "timeout" | "internal"; message: string };
```

- 样本不足不是错误，是 `sample.status`。
- `data_not_collected` 表示项目没有这类数据，是 Agent 的能力边界。
- `project_id` 由调查循环按登录信息绑定，不作为参数暴露给模型。
- 结果不返回 `anonymous_user_id` 列表或原始数据行。

### H2. 工具清单

| 工具 | 阶段 | 用途和主要输入 | 主要输出 | 样本 |
|---|---|---|---|---|
| `get_project_context` | 7 | 数据覆盖、日期范围、登记事件、时区、门槛 | 各类数据是否存在与起止日期 | — |
| `list_dimension_values` | 7 | 维度、时间范围 | 取值及首次 / 最近出现时间 | — |
| `get_paywall_funnel` | 7 | 时间、筛选 | 展示 / 点击 / 购买 / 失败、各步转化、最大流失点、关闭未购买 | session |
| `compare_periods` | 7 | 指标、本期、对比期、筛选 | 两期值、差值、区间、信号强度 | 两边达标 |
| `breakdown_metric` | 7 | 指标、维度、可选对比、筛选 | 各组值、贡献拆解、不足组合并 | G 节规则 |
| `get_feedback_reasons` | 7 | 时间、筛选、对比 | 原因占比、变化、回答率 | `MIN_REASON_COUNT` |
| `get_feedback_themes` | 7 | 时间、筛选 | 已保存主题计数，每主题 ≤ 2 条脱敏例句 | `MIN_THEME_COUNT` |
| `get_ingestion_health` | 7 | — | 最近事件、事件种类、孤儿、拒收数、SDK 版本分布 | — |
| `get_event_adoption` | 8 | 事件、人群、时间 | 做过的安装占比、次数分布 | 安装 |
| `get_paywall_context` | 8 | 时间、筛选 | 付费页前做过核心行为的比例与两组漏斗 | session |
| `get_retention` | 9 | 同期群范围、天数、分组 | 人数、Dn、Rn、未满观察期 | 同期群 ≥ 30 |
| `get_activation` | 9 | 同期群范围、分组 | 激活率、激活时间中位数 | ≥ 30 |
| `get_subscription_summary` | 10 | 截止时间、筛选 | 各状态订阅数、可能过期数 | 订阅 |
| `get_trial_conversion` | 10 | 同期群范围 | 试用、已转化、已过期、仍在试用 | ≥ 20 试用 |
| `get_subscription_churn` | 10 | 时间 | 关续费、到期、扣费失败、恢复、退款比例 | 订阅 |
| `get_purchase_reconciliation` | 10 | 时间 | 客户端与服务端购买匹配、单边数量 | — |

可对比指标清单：`paywall.overall_conversion`、`paywall.view_to_click`、`paywall.click_to_purchase`、`paywall.failure_rate`、`feedback.response_rate`；Phase 8–10 追加 `event.adoption:<key>`、`retention.r7`、`retention.r30`、`activation.rate`、`trial.conversion`、`subscription.auto_renew_off_rate`、`subscription.billing_issue_rate`、`subscription.refund_rate`。每个指标写明单位、分母、定义版本。

---

## I. Agent 架构

### I1. 调查流程

1. 问题进入。
2. 范围检查（代码）：`get_project_context` 判断所需数据是否采集，没有则停止并说明缺什么。
3. 规划（LLM，结构化输出）：调用工具 / 结束 / 放弃，三选一。
4. 参数校验（代码）：schema、项目绑定、时间范围、下钻 ≤ 2 层、禁止重复调用。
5. 执行工具（代码，确定性）。
6. 保存证据到本次调查的 `steps`。
7. 把信封（不含原始数据）交回规划模型。
8. 回到 3，或由代码判定停止。
9. 汇总（LLM）：只能引用 fact id 和 evidence id。
10. 校验（代码）：数字出自证据、引用存在、无因果词、措辞符合类别、置信度不超上限。
11. 渲染（代码）：「发现」用工具 fact 原文；「假设」「建议实验」用模型文字。

### I2. 职责划分

- 代码：计数、比率、转化、留存、差值、同期群、分群、排序、门槛、置信区间、贡献拆解、停止条件、全部校验。
- LLM：调查计划、选工具、评论归类、假设、解释、建议实验。
- `AiProvider` 增加 `role`（planner / writer / classifier / judge），每个角色用环境变量指定模型。归类与判断可用快速模型（如 Jev / System One）。都走兼容 OpenAI 的 json_schema 接口，不锁定供应商。

### I3. 报告结构与停止条件

```json
{
  "answer_status": "answered | partially_answered | insufficient_data | no_change | out_of_scope | contradictory",
  "findings": [{ "fact_id": "E2.F1" }],
  "evidence": ["E1", "E2", "E3"],
  "hypotheses": [{ "id": "H1", "text": "...", "based_on": ["E2.F1", "E4.F2"], "confidence": "low | medium | high" }],
  "limitations": ["low_sample:E3", "response_rate:E4"],
  "suggested_tests": [{ "id": "T1", "for_hypothesis": "H1", "text": "...", "measure": "..." }],
  "not_investigated": ["..."]
}
```

| 情况 | 停止方式 |
|---|---|
| 证据足够 | 模型提出结束，且至少一条「清楚」信号解释大部分变化，代码才接受 |
| 数据不足 | 主指标 insufficient 立即停，回答「目前的数据不足以判断」并写明差多少样本 |
| 无明显变化 | `compare_periods` 看不出差别，最多再做一次分群确认，回答「没有看到超出波动的变化」 |
| 结果矛盾 | 同一指标两条路径结果不一致，或组内方向与整体相反且主要来自占比变化：列出两边证据，停，置信度低 |
| 达到上限 | 最多 8 次工具调用、2 分钟、成本上限；输出已有部分和未查方向 |
| 超出能力 | 数据未采集或问具体用户：规划阶段停止并说明 |

### I4. 主动信号

1. 确定性指标：固定指标 × ≤ 2 层维度 × 固定时间窗。
2. 代码规则筛选候选：样本达标、信号强度 ≥ 弱、效应超过最小值。
3. 写入 `signals`，按项目 + 检测器 + 指标 + 分组 + 周期末去重。
4. 确定性排序：效应大小 × √样本量 × 新近程度。
5. （以后）快速判断模型只看信号信封，标注「值得深入 / 噪声 / 重复」。
6. 可选深度调查：每项目每周最多自动 1 次。

定时任务不用 Vercel Cron。纯 SQL 检测可用 pg_cron；需要应用代码的部分由杭州服务器 systemd 定时器调用带密钥的内部接口。项目时区变更时清空未处理信号。

### I5. Dashboard 与 Agent 分工

- 始终在 Dashboard 确定性展示：漏斗、反馈分布、接入健康、单维度分群、同期群、激活、订阅状态与生命周期漏斗、对账、信号列表。
- 交给 Agent：多步骤「为什么」调查、临时组合问题、串联多条证据的叙述、假设与实验建议。
- Agent 引用的每个数字都能深链到同样筛选的 Dashboard 页面。

---

## J. 调查示例

**示例一（假设数据）：「最近为什么订阅转化下降？」**

1. `compare_periods(overall_conversion, 近 7 天, 上 7 天)` → E1：8.2% → 7.8%，n = 1,240 / 1,310，弱信号。
2. `breakdown_metric(overall_conversion, platform, 对比)` → E2：iOS 9.1% → 9.0%（看不出差别）；Android 7.6% → 5.2%（清楚），组内变化贡献 90%。
3. `breakdown_metric(overall_conversion, app_version, platform=android)` → E3：2.3.0 为 5.1%（n = 410），2.2.4 为 7.8%（n = 380）。
4. `get_paywall_funnel(android + 2.3.0)` → E4：看到 → 点击下降最多。
5. `get_feedback_reasons(同筛选, 对比)` → E5：「没看懂价值」上升，n = 22，小样本。
6. `get_paywall_context(同筛选)` → E6：付费页前做过核心行为的比例 64% → 41%。
7. 停止：已定位到清楚信号并解释大部分变化。

报告：发现引用 E2–E4、E6；H1（中）：2.3.0 让付费页更早出现，用户未体验核心价值就看到付费页（依据 E4、E6；E5 小样本不作依据）；局限：只有 Android、E5 样本小、相关不等于因果；T1：在 2.3.0 把付费页延后到完成一次核心行为之后，观察看到 → 点击转化。

**示例二（长高一点 2026-09-25 的真实数据）**

`compare_periods` 返回 n = 1，状态 insufficient，且是开发者本人测试。立即停止，回答：「目前的数据不足以判断转化是否下降。本期只有 1 次付费页展示，至少需要 100 次才能开始比较。」

---

## K. 数据库演进（草案，不在本文件中执行）

```sql
-- Phase 7
ALTER TABLE events   ADD COLUMN failure_kind text, ADD COLUMN sdk_version text;
ALTER TABLE feedback ADD COLUMN sdk_version text, ADD COLUMN theme text, ADD COLUMN theme_version text;
CREATE INDEX CONCURRENTLY events_viewed_idx ON events (project_id, occurred_at) WHERE event_name = 'paywall_viewed';

-- Phase 8
CREATE TABLE product_events (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id uuid NOT NULL, anonymous_user_id text NOT NULL, event_key text NOT NULL,
  platform text NOT NULL, app_version text NOT NULL, sdk_version text,
  storage_mode text CHECK (storage_mode IN ('persistent', 'memory')),
  occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, event_id)
);
-- 索引：(project_id, event_key, occurred_at)、(project_id, anonymous_user_id, occurred_at)、(project_id, occurred_at)
CREATE TABLE event_definitions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_key text NOT NULL, display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('core', 'onboarding', 'other')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, event_key)
);

-- Phase 10
CREATE TABLE project_server_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_prefix text NOT NULL, key_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
);
CREATE TABLE subscription_events (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source text NOT NULL, source_event_id text NOT NULL,
  store text NOT NULL, subscription_ref_hash text NOT NULL,
  anonymous_user_id text, event_type text NOT NULL, period_type text, product_id text,
  effective_at timestamptz NOT NULL, expires_at timestamptz, environment text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source, source_event_id)
);
CREATE TABLE subscriptions (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  subscription_ref_hash text NOT NULL, store text NOT NULL, product_id text,
  anonymous_user_id text, status text NOT NULL, will_renew boolean,
  trial_started_at timestamptz, first_paid_at timestamptz, current_period_end timestamptz,
  last_effective_at timestamptz NOT NULL, environment text NOT NULL,
  PRIMARY KEY (project_id, subscription_ref_hash)
);

-- Phase 11
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  question text NOT NULL, status text NOT NULL, answer_status text,
  models jsonb, prompt_version text, tool_catalog_version text, as_of timestamptz NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]', report jsonb, usage jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Phase 12
CREATE TABLE signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  detector text NOT NULL, metric text NOT NULL, segment_key text NOT NULL,
  period_end date NOT NULL, effect jsonb NOT NULL, score numeric NOT NULL,
  status text NOT NULL DEFAULT 'new', judge_label text, agent_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, detector, metric, segment_key, period_end)
);
```

其他列变更：`project_daily_usage` 加拒收计数（Phase 8）；`projects` 加激活规则（Phase 9）；`feedback.survey_type`（出现第二种调查时）；更新 `paylens_delete_expired_rows()` 覆盖新表。

每张新表的必要性：

- `product_events`：行为事件没有付费页 session，放进 `events` 需去掉热表的非空约束。
- `event_definitions`：服务端需知道哪个事件是核心行为。
- `project_server_keys`：服务端 key 必须哈希存储；现有 `project_keys` 按明文查找。
- `subscription_events` + `subscriptions`：前者保证幂等、历史与推导；后者让状态查询与分群足够快，可随时重算。
- `agent_runs`：证据可引用、可复查，是评测数据来源；工具调用放 `steps`，不建 `agent_tool_calls`。
- `signals`：去重、忽略、关联调查。

不建：`user_properties`（不允许属性）、`cohorts`（现算）、分析快照表（先靠 `as_of`）、安装表（先从事件推导，慢了再加）。

共通规则：

- 项目隔离：所有表带 `project_id`，级联删除；查询经 `getOwnedProject`。
- 时区：参数是项目本地日期，代码换算为 UTC 区间查询；信封与调查记录当时时区。
- 保留期：`product_events`、`subscription_events` 跟随 `retention_days`；`agent_runs` 365 天；`signals` 180 天。
- 按用户删除：覆盖 `product_events` 与经 `anonymous_user_id` 关联的订阅行；`ai_reports`、`agent_runs` 只有聚合与脱敏例句，作为文档写明的例外。
- RLS：所有表开启（7.0 起），新表建表时直接开。

---

## L. SDK 演进

- 现有 API 不变：`init`、`track`（4 个事件）、`shouldShowExitSurvey`、`markExitSurveyShown`、`submitFeedback`、`flush`、`PayLensExitSurvey`。
- 新增（全部向后兼容）：Phase 7 `track("purchase_failed", …)`、自动带 `sdk_version`；Phase 8 `trackEvent(key)`、`init({ appOpens: true })`、带 `storage_mode`；Phase 10 `getInstallId()`。
- 不做 `identify(userId)`：接受跨设备与重装后关联丢失，换取不持有账号标识；需要时单独评审。
- 不做 `setSubscriptionState`、`setUserProperties`、自动采集、屏幕追踪。
- 队列：付费页事件与行为事件共用队列、各有上限，满时先丢最旧的行为事件；`event_id` 幂等不变。
- 本地状态加 `stateVersion`，能读旧格式。
- 旧版本兼容：服务端永久接受 V0.1 格式；新字段一律可选；`sdk_version` 为空视为旧版本。
- `pl_sec_` 永远不进 SDK。
- 存储只在内存的安装不参与按人计算的指标，但照常计入按 session 的漏斗。长高一点在 Phase 8、9 前需重打包含原生 AsyncStorage 的开发版。
- SDK 继续不发 npm，接入第二个 App 时再评估。

---

## M. 隐私与安全

- `anonymous_user_id` 是每个安装的随机 UUID（假名），足够留存分析；不引入 `user_id`。
- 允许：登记事件名、平台、版本、付费页版本、产品 id、失败类型、SDK 版本、存储模式、订阅事实（交易号哈希）。
- 禁止：事件属性；身高体重等健康数值、邮箱、手机号、精确位置；设备标识（IDFA、Android ID、OAID）；IP；收入金额；新的自由文本。唯一自由文本仍是退出调查评论（脱敏、≤ 300 字）。
- 送进模型的只有聚合数字和每主题 ≤ 2 条脱敏例句。
- 提示注入：评论只进入主题归类，归类输出限定为固定主题；`app_version`、`paywall_version` 可被任何持有公开 key 的人写入，新数据按字符集严格校验，交给模型时转义。
- 数据投毒：接入健康显示异常；订阅以服务端为准；提供对账。
- PIPL / GDPR 工程风险（非法律意见）：确认 Supabase 区域；AI 供应商在境外同样涉及跨境；长高一点用户为 14 岁以上青少年且为健康类 App，上线行为采集前需更新隐私政策与华为应用市场第三方 SDK 清单；对外开放前需要 DPA。

---

## N. 测试与评测

1. 确定性工具：PGlite 验证脚本 + 手算数据集；分组求和、贡献拆解恒等、时区与夏令时、未满观察期、`as_of` 重跑、样本门槛、孤儿排除、删除无残留。
2. Phase 7 重构前后在现有验证数据上结果完全一致。
3. 订阅状态机：逐条用例、乱序、重复、沙盒、重算与逐条更新一致。
4. SDK：扩展 `verify.ts` 覆盖旧状态迁移、队列优先级、行为事件不碰 session、存储模式。
5. Agent 评测集（合成项目植入原因）：单版本下降、组成变化、纯噪声、样本不足、超出能力、数据矛盾。达标：停止原因正确；找到植入分组；来源不明数字为 0；因果措辞为 0；样本不足场景 100% 回答数据不足；工具调用不超预算。平时用录制的模型输出回放，定期用真实模型跑。
6. 迁移：先在 PGlite 跑完整迁移，再在生产结构副本演练。
7. 性能：100 万事件下每个工具 ≤ 2 秒。

---

## O. 风险

| 风险 | 应对 |
|---|---|
| 独立 App 数据量小，多数分析显示样本不足 | 把「数据不足」当正式答案；按当前流量估算所需时间；Phase 6 继续积累 |
| Supabase 公开表可被读写 | 7.0 先修 |
| 身份不稳定（内存兜底） | `storage_mode` 标记并排除；重打开发版 |
| 范围膨胀 | 每期写清「明确不做」；P 节永不做清单 |
| Vercel 与杭州两套部署、手动运维 | 杭州为唯一生产，Vercel 只做预览；Agent 需长时间运行的 Node 进程 |
| 商店对接复杂 | 第一版只接开发者后端 |
| 多重比较误报 | 样本规则、下钻 ≤ 2 层、注明比较组数 |
| 模型不稳定、成本不可控 | 预算上限、结构化输出、校验、录制回放 |
| 合规（跨境、未成年人、健康类） | 采集前确认区域并更新隐私政策 |
| 长高一点产品价格配置不一致 | 由长高一点自行修复 |

---

## P. 范围审查

1. 不由 PayLens 自己做：票据核验、会员权益发放、A/B 分组与功能开关、归因、崩溃监控、推送与营销、会话录屏、热力图。
2. 接第三方：商店事实经开发者后端或 RevenueCat；AI 走 `AiProvider`；邮件用现成服务；定时任务用系统 cron。
3. 永远不做：任意事件属性与事件浏览器、自定义 SQL 或查询构建器、用户画像与单用户时间线、任意步骤漏斗构建器、路径图 / 桑基图、看板构建器、实时数据流、收入与 LTV 预测、Web SDK 与自动采集。
4. 最易膨胀：事件属性、直连三家商店、身份合并、看板构建器、工具数量、主动推送、多模型路由、在无试用的 App 上做试用分析。
5. 删除：`user_properties`、`cohorts` 表、`agent_tool_calls` 表。推迟：直连商店通知、试用与取消调查、`acquisition_channel`、LLM 判断层、每周邮件、针对 iOS / Android 差异的专门功能（长高一点国内版只有安卓）。

---

## Q. 下一步

1. Phase 7.0：只读确认 Supabase 公开表的 RLS 与 anon / authenticated 权限；确认后开启 RLS（需开发者确认后执行）。
2. Phase 6 继续：长高一点正常使用、积累数据、出第一份报告、做一次 A→B；之后更新 `design-v0.1.md` 状态行。
3. Phase 7：先写单独的细化计划（改动文件、迁移、新旧一致性测试），审核通过再写代码。
