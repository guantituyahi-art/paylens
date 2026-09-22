# PayLens V0.1 设计文档

> 状态：Phase 3 已完成，等待确认后再进入 Phase 4。
> 版本：v0.1-design-r3（2026-09-22）
> 约束：Small but real。V0.1 只有一个使命——帮助独立 App 开发者更清楚地知道：用户为什么没有完成订阅。

## 0. 本轮修订记录（相对初稿）

| # | 修订 | 影响章节 |
|---|---|---|
| 1 | 主漏斗统一按 `paywall_session_id` 计算，不混用 unique user；用户级指标留到未来 | G、E、F |
| 2 | Client Key 改为一个项目多把 key，状态 active / deprecated / revoked；不再"轮换即失效" | E、G、J、C |
| 3 | `projects.timezone`（IANA）成为硬规则：分桶、周期比较、AI Snapshot 全部按项目时区 | E、G、I |
| 4 | AI 收紧：Facts、Key Changes、全部数字/百分比/变化由代码生成；模型只做主题归类、Hypotheses、Suggested Tests 和必要解释 | I |
| 5 | SDK 依赖：AsyncStorage 为 peer dependency；expo-application / expo-crypto 为 optional peer；允许显式传 `appVersion` | H |
| 6 | 样本量门槛定义为"V0.1 产品级保守阈值"，不称统计显著性；小样本时 Dashboard 仍显示确定性统计，只不生成 AI hypotheses | I、C |
| 7 | M 节 11 条 Scope 缩减全部采纳并落入正文 | 全文 |
| 8 | 部署：Phase 0–5 按 Vercel + Supabase，API base URL 可配置，架构不绑定平台；Phase 6 前专项验证中国大陆可达性 | D、K |
| 9 | AI provider 做最小抽象层，V0.1 只实现一个支持 structured output 的供应商 | I |
| 10 | SDK V0.1 不发 npm，仅用于自己的两个 App | H |
| 11 | 三条实现规则：`purchase_success` 是 session 终止态且窗口内优先归为 purchased；无 `paywall_viewed` 的事件保留为 orphan、不进漏斗；仅 `error_code=key_revoked` 停止该 key 重试 | F、G、H |

### 实现规则（Phase 1 起必须遵守）

这三条覆盖前文中较松的表述。漏斗、接入 API 和 SDK 按这里实现。

**1. Session 终止与购买归属**

- `paywall_closed` 和 `purchase_success` 都是 paywall session 的终止状态。SDK 遇到其中任一事件后，不再让后续事件继承该 session。
- 例外只有一个：`paywall_closed` 之后的**归属窗口**（10 分钟，从该 session 最早一条 `paywall_closed.occurred_at` 起算）。窗口内的 `purchase_success` 仍写入同一个 `paywall_session_id`。
- 最终归类互斥，**purchased 优先**：
  - **purchased**：存在 `purchase_success`，且（没有 `paywall_closed`，或 `purchase_success.occurred_at` ≤ 最早 `paywall_closed.occurred_at` + 10 分钟）。先关闭、后在窗口内收到购买，最终仍是 purchased，不得算进 `closed_without_purchase`。
  - **closed_without_purchase**：有 `paywall_closed`，且没有落在上述窗口内的 `purchase_success`。
- 窗口之外的 `purchase_success` 不丢弃，照常入库，但不把该 session 改判为 purchased，也不进入正式漏斗。

**2. 孤儿事件**

- 没有对应 `paywall_viewed` 的 `subscribe_clicked` / `purchase_success` / `paywall_closed` **不得拒绝、不得丢弃**。
- 原样写入 `events`。派生标记为 orphan：该 `paywall_session_id` 在同一 `project_id` 下不存在 `paywall_viewed`。不为此加列。
- orphan 只进入接入健康度（`orphan_sessions` = 这类 session 的个数）。不进入 `sessions` / `clicked` / `purchased` / `closed_without_purchase` / 日分桶 / 回答率分母。
- 挂在 orphan session 上的 feedback 同样入库，可出现在文字反馈列表，但不参与漏斗和回答率。

**3. 永久错误与可重试错误**

接入 API 的 401 必须返回 JSON，且使用固定字段名：

```json
{ "error_code": "key_revoked" }
```

| 情况 | 分类 | SDK 行为 |
|---|---|---|
| HTTP 401 且 `error_code` 为 `key_revoked` | 该 key 的永久错误 | **唯一**会停止这把 key 后续重试的情况：暂停 flush，队列保留在本地，`console.warn`。换成另一把 key 并重新 init 后可以继续发送 |
| 同一次 200 响应里的单条 `rejected` | 该条事件的永久错误 | 丢掉这一条，不重试；同批其余事件不受影响。不停止这把 key |
| HTTP 400（整包无法解析）、413 | 该批 payload 的永久错误 | 丢掉这一批，不按原 body 重试。不停止这把 key，之后的新事件照常发送 |
| 网络错误、超时、408、429、5xx，以及 401 但 `error_code` 不是 `key_revoked`（含 `key_invalid`） | 可重试 | 整批保留，按退避重试 |

退避：1s、2s、4s…上限 5 分钟；尊重 429 的 `Retry-After`（若有）。App 运行中与下次启动都继续可重试错误。不得因为 5xx、429 或断网停止这把 key。

---

## A. 产品理解

### 解决什么问题

独立开发者上线 Paywall 后，看到的只有一个结果："转化率 X%"。这个数字告诉他有问题，但不告诉他问题在哪、为什么。他要么靠猜，要么去接 Mixpanel / PostHog 然后被复杂度淹没。PayLens 只回答一件事：**用户看了订阅页之后，为什么没有付钱。**

### V0.1 的核心价值

把"很多人没付钱"拆成两层可行动的信息：

1. **在哪一步丢的** —— 漏斗：看到 → 点订阅 → 购买成功（按每次 Paywall 展示计）
2. **用户自己说为什么** —— 关闭 Paywall 后一次点击的退出调查

代码算出事实，AI 把事实翻译成"下一步值得测什么"。价值不在于数据多，而在于开发者看完能改一个具体的东西（Paywall 时机、价格展示、价值说明）。

### 最大风险（按判断排序）

1. **数据量太小，结论是噪音。** 独立 App 一周可能只有几十条反馈。38% vs 34% 在 30 个样本下没有意义。如果产品不主动提示"样本不足"，反而会误导决策——这比没有工具更糟。设计上把"样本量门槛"作为一等公民。
2. **调查偏差。** 愿意回答退出调查的人不代表所有流失用户。报告必须始终展示回答率。
3. **接入摩擦。** 开发者忘了发 `paywall_closed`，调查永远不触发，还以为没人流失。需要"接入健康度"。
4. **AI 把相关说成因果。** 靠输出结构 + 代码生成事实来约束，不靠 prompt 祈祷。

---

## B. V0.1 用户流程

### 开发者流程

```text
1. 登录（邮箱 magic link）
2. 创建 Project（名称 + IANA 时区）→ 自动生成第一把 active Client Key
3. 接入引导页：安装 SDK、init、在 Paywall 四个位置各加一行
4. 页面显示"等待第一个事件…" → 收到后变为"已接入 ✓ 最近事件 xx 秒前"
5. 上线后打开 Overview：10 秒内看到漏斗和最大流失点
6. 打开 Feedback：看原因分布 + 用户原话
7. 打开 Insights：点"生成报告"，看 事实 / 推断 / 建议测试
8. 改 App（如延后 Paywall）→ 换 paywall_version = "B" → 回来对比 A vs B
9. 发新版时可新建 key，旧 key 标 deprecated，看着旧版本流量归零后再 revoke
```

### App 最终用户流程

```text
Paywall 显示                     → SDK 发 paywall_viewed（新建 paywall session）
  ├─ 点"订阅"                    → SDK 发 subscribe_clicked
  │    ├─ 系统支付成功            → SDK 发 purchase_success → Paywall 关闭，不出调查
  │    └─ 系统弹窗取消/失败       → 回到 Paywall
  └─ 关闭 Paywall                 → SDK 发 paywall_closed
                                    SDK 本地判断：本 session 无 purchase_success 且不在冷却期
                                    → shouldShowExitSurvey() 为 true → 开发者显示调查
                                         点一个选项（选"其他"才出现输入框）→ 发 feedback
                                         或直接关掉 → 什么都不发
```

调查目标耗时 2–5 秒。默认同一用户 7 天内最多看到一次。

### 数据流程

```text
App (SDK 队列, 批量) ──POST /v1/events, /v1/feedback──▶ Ingestion API
                                                          │ 校验 Client Key 状态、字段、白名单
                                                          │ 按 event_id 幂等写入（重复丢弃）
                                                          ▼
                                                      Postgres (events, feedback)
                                                          │
                            Dashboard 查询（SQL 按 session 聚合，按项目时区分桶）
                                                          ▼
                                            Overview / Feedback 页面
                                                          │
                            点"生成报告" → 代码构建 Snapshot（含 Facts / Key Changes）
                                        → 样本门槛判断 → AI 主题归类 → 代码计数
                                        → AI 生成 Hypotheses / Suggested Tests → 引用校验 → 存 ai_reports
                                                          ▼
                                                     Insights 页面
```

---

## C. 页面信息架构

V0.1 共 **4 个主页面 + 2 个辅助页面**（登录、接入引导）。接入引导不是可选项，它直接决定接入摩擦。

### 全局元素

- 顶部：Project 切换器、开发者菜单
- Overview / Feedback 共用筛选条：**日期范围**（7 天 / 30 天 / 自定义）、**App Version**、**Paywall Version**。选项来自实际收到的数据，不需要预先配置。
- 日期范围按项目时区的自然日解释；包含今天时，今天标记为"数据不完整"。

### 页面 1：接入引导（Onboarding）—— "我怎么开始"

```text
┌──────────────────────────────────────────────┐
│ 接入 PayLens                                 │
│ Client Key (active): pl_pub_xxxxxxxx [复制]  │
│                                              │
│ 1. 安装      pnpm add @paylens/react-native  │
│              + @react-native-async-storage/… │
│ 2. 初始化    PayLens.init({ clientKey })     │
│ 3. 埋 4 个点  （代码片段，可复制）              │
│ 4. 退出调查  （代码片段）                       │
│                                              │
│ 状态: ● 等待第一个事件…   （轮询）              │
│       ✓ 已收到 paywall_viewed  3 秒前          │
│       接入检查: 已见到 4/4 种事件               │
└──────────────────────────────────────────────┘
```

### 页面 2：Overview —— "在哪一步丢的"

```text
┌ 筛选: [最近 7 天 ▾] [App 版本: 全部 ▾] [Paywall: 全部 ▾] ┐
│                                                        │
│  Paywall Sessions  Subscribe Clicked   Purchased        │
│      1,240    ──▶       286      ──▶     137            │
│             23.1%              47.9%                    │
│                    Overall 11.0%                        │
│  （口径：每次 Paywall 展示为一个 session）                │
│                                                        │
│  ⚠ 最大流失点：Paywall → 点击订阅（流失 954 次，76.9%） │
│                                                        │
│  关闭未购买: 1,103    收到反馈: 126 (回答率 11.4%)       │
│                                                        │
│  [折线图：每日 Sessions 与 Overall Conversion]  ← 唯一一张图 │
│                                                        │
│  接入健康: 最近事件 2 分钟前 · 4/4 事件 · 孤儿 session 0  │
└────────────────────────────────────────────────────────┘
```

"最大流失点"由代码判定（绝对流失 session 数最多的那一步）。

### 页面 3：Feedback —— "用户说为什么"

```text
┌ 筛选条（同上）                                        ┐
│ 共 126 条反馈 · 回答率 11.4%                            │
│                                                        │
│ 价格有点高         ████████████  48   38%   ▼ -2pp     │
│ 还想再体验一下     ████████      33   26%   ▲ +9pp     │
│ 免费版已经够用了   ██████        23   18%   ─           │
│ 没看懂 Pro 的价值  ███           14   11%   ─           │
│ 暂时没有需要       █              5    4%   (小样本)    │
│ 支付遇到了问题     █              2    2%   (小样本)    │
│ 其他                              1    1%   (小样本)    │
│               （▲▼ 与上一同长周期对比）                  │
│                                                        │
│ 文字反馈 (23)                        [仅看含文字 ☑]     │
│ ┌ "还没用过导出功能就让我付钱" · 其他 · v1.0.1 · A · 2h │
│ ┌ "一年 ¥198 有点贵，月付可以" · 价格 · v1.0.1 · A · 5h │
│ …（分页）                                               │
└────────────────────────────────────────────────────────┘
```

"时间变化"在 V0.1 用**与上一周期对比的百分点差**表达，不画分原因趋势图。

### 页面 4：Insights —— "所以我该测什么"

```text
┌ [生成报告: 最近 7 天 ▾]  历史报告 ▾                     ┐
│ 报告 · 2026-09-15 ~ 09-21 · 对比 09-08 ~ 09-14 · Asia/Shanghai │
│ 样本: 126 条反馈 / 1,240 sessions   ✓ 达到 V0.1 阈值    │
│                                                        │
│ ■ 事实（代码计算）                                       │
│   F1 整体转化 11.0%，上期 12.3%，-1.3pp                  │
│   F2 最大流失点：Paywall → 点击订阅，流失 954 次          │
│   F3 "还想再体验" 26%（n=33），上期 17%，+9pp            │
│   F4 11 条文字反馈归为主题"未体验核心功能就看到付费页"    │
│ ■ 推断（AI，假设未证实）                                  │
│   H1 Paywall 可能出现过早    依据: F3, F4    信心: 中     │
│ ■ 建议测试（AI）                                         │
│   T1 paywall_version="B"：首次完成一次核心操作后再展示     │
│      衡量：对比 A/B 的 View→Click 与"还想再体验"占比       │
│ ■ 数据说明（代码）                                       │
│   · 回答率 11.4%，回答者不代表全部流失用户                │
│                                                        │
│ [查看本报告的输入数据 ▸]  （展开显示 Snapshot JSON）      │
└────────────────────────────────────────────────────────┘
```

样本不足时：仍显示"事实"与"数据说明"两栏（代码生成），"推断 / 建议测试"栏显示"样本未达到 V0.1 阈值（当前 X 条反馈 / Y sessions，阈值 20 / 100），未调用 AI"。

### 页面 5：Settings —— "基本配置 + 隐私操作"

```text
项目名称 [________]   时区 [Asia/Shanghai ▾]（IANA）

Client Keys                                    [新建 Key]
  pl_pub_a1b2…  "v1.x"   active      最近使用 2 分钟前   [标记 deprecated]
  pl_pub_9z8y…  "v0.9"   deprecated  最近使用 3 天前     [撤销]
  pl_pub_5f4e…  "test"   revoked     撤销于 09-01
  说明：deprecated 仍接受上报，用于观察旧版本流量；revoked 立即拒绝。

数据保留    原始事件保留 365 天后自动删除（V0.1 固定）
删除某个用户的数据   anonymous_user_id [________] [删除]
删除项目全部数据     [危险操作，需输入项目名确认]
```

调查问题 / 选项 / 是否允许文字反馈：**不在后台**，在 SDK 配置里（见 M-2）。

### 页面 6：登录

邮箱 magic link。无注册表单、无密码找回。

---

## D. 技术架构

### 推荐技术栈

```text
语言        TypeScript 全栈（Dashboard、API、SDK 同一个 repo）
Web/API     Next.js（App Router）：页面 + Route Handlers 一体
数据库      PostgreSQL（V0.1 用 Supabase 托管）
认证        Supabase Auth（magic link），封装在 auth 模块后面
ORM/迁移    Drizzle ORM（schema 即 TS，迁移是纯 SQL，聚合查询直接写 SQL）
AI          最小抽象层 `generateStructured(schema, prompt)`，V0.1 只实现一个支持 JSON structured output 的供应商
定时任务    Supabase pg_cron（DB 侧，不依赖部署平台的 cron）
部署        Phase 0–5：Vercel + Supabase；保留 Docker（Next.js standalone + Postgres）路径
SDK         纯 TS 包，无原生代码，Expo Go 可跑
Repo        pnpm workspace：apps/web、packages/sdk、examples/expo-demo
```

### 为什么这样选

- **一个人维护**：Next.js 把页面和 API 放在一个进程、一次部署里。
- **Postgres 足够**：V0.1 数据量是"每天几千条事件"，带索引的 events 表直接 SQL 聚合即可。不需要 ClickHouse、预聚合表、消息队列。数据量到百万级以上再加每日汇总表——明确的、可延后的升级路径。
- **Supabase 免费层**：Postgres + Auth + pg_cron 一站解决，成本 0。
- **Drizzle 而不是 Prisma**：更轻，迁移就是 SQL 文件，能看懂每一次 schema 变更。
- **不选**：Cloudflare Workers + D1、独立 Node/Hono 后端、tRPC/GraphQL、Redis——V0.1 都没有非它不可的场景。

### 不绑定部署平台的具体做法

| 关注点 | 做法 |
|---|---|
| API base URL | SDK `init({ endpoint })` 可配置，默认值来自 SDK 构建时常量；Dashboard 用环境变量 `NEXT_PUBLIC_APP_URL` |
| 平台专有 API | 不使用 Vercel KV / Edge Config / Vercel Cron；定时任务全部在 pg_cron |
| 数据库 | 只依赖 `DATABASE_URL` 连接串；不使用 Supabase 专有扩展（除 pg_cron，它是标准 Postgres 扩展） |
| 认证 | Supabase Auth 调用集中在 `lib/auth.ts`，替换时只改一个文件 |
| 运行时 | Next.js Node runtime（不用 Edge runtime），Docker 可直接跑 |
| 中国大陆可达性 | Phase 6 接真实 App 前专项验证；不可达时把 Web/API 部到国内可达 VPS，同一份代码 |

---

## E. 数据库 Schema

五张业务表 + 一张开发者表。没有 `anonymous_users` 表（见 M-1）。

```sql
-- 开发者：与 Supabase auth.users 一对一，id = auth uid
developers (
  id          uuid PRIMARY KEY,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
)

projects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  developer_id    uuid NOT NULL REFERENCES developers(id),
  name            text NOT NULL,
  timezone        text NOT NULL,                 -- IANA，如 'Asia/Shanghai'；创建时必填，应用层校验合法性
  retention_days  int  NOT NULL DEFAULT 365,
  created_at      timestamptz NOT NULL DEFAULT now()
)
-- INDEX (developer_id)

project_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key            text NOT NULL UNIQUE,           -- 'pl_pub_' + 32 随机字符；公开 key，明文存储
  label          text,                           -- 可选备注，如 'v1.x'
  status         text NOT NULL DEFAULT 'active', -- 'active' | 'deprecated' | 'revoked'
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,                    -- 节流更新：距上次写入 > 5 分钟才更新
  deprecated_at  timestamptz,
  revoked_at     timestamptz
)
-- INDEX (project_id)
-- 应用层约束：每个项目至少保留一把 active key；revoked 不可逆

events (
  id                  bigserial PRIMARY KEY,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id            uuid NOT NULL,             -- 客户端生成，幂等键
  anonymous_user_id   text NOT NULL,             -- SDK 生成的随机 UUID
  paywall_session_id  uuid NOT NULL,             -- 一次 Paywall 展示 = 一个 session；漏斗计数单位
  event_name          text NOT NULL,             -- 应用层白名单
  platform            text NOT NULL,             -- 'ios' | 'android'
  app_version         text NOT NULL,
  paywall_version     text,
  product_id          text,                      -- 仅 subscribe_clicked / purchase_success 可选
  occurred_at         timestamptz NOT NULL,      -- 客户端时间（服务端钳制后）
  received_at         timestamptz NOT NULL DEFAULT now()
)
-- UNIQUE (project_id, event_id)
-- INDEX  (project_id, occurred_at)
-- INDEX  (project_id, event_name, occurred_at)
-- INDEX  (project_id, paywall_session_id)        -- 漏斗按 session 聚合的主索引
-- INDEX  (project_id, anonymous_user_id)         -- 删除某用户

feedback (
  id                  bigserial PRIMARY KEY,
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  feedback_id         uuid NOT NULL,
  anonymous_user_id   text NOT NULL,
  paywall_session_id  uuid NOT NULL,             -- 关联到具体那次 Paywall
  reason_code         text NOT NULL,             -- 稳定编码 ^[a-z_]{2,40}$
  reason_label        text,                      -- 用户实际看到的文案
  comment             text,                      -- ≤300 字，服务端脱敏
  platform            text NOT NULL,
  app_version         text NOT NULL,
  paywall_version     text,
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now()
)
-- UNIQUE (project_id, feedback_id)
-- INDEX  (project_id, occurred_at)
-- INDEX  (project_id, reason_code, occurred_at)
-- INDEX  (project_id, paywall_session_id)
-- INDEX  (project_id, anonymous_user_id)

ai_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  timezone        text NOT NULL,                 -- 生成时的项目时区快照
  period_start    date NOT NULL,                 -- 本地自然日，含
  period_end      date NOT NULL,                 -- 本地自然日，含
  compare_start   date NOT NULL,
  compare_end     date NOT NULL,
  filters         jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL,                 -- 'pending' | 'done' | 'failed' | 'insufficient_data'
  model           text,
  prompt_version  text,
  input_snapshot  jsonb,                         -- 含代码生成的 facts / key_changes
  output          jsonb,                         -- 模型返回并通过校验的部分
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
)
-- INDEX (project_id, created_at DESC)

project_daily_usage (                            -- 日配额计数
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day         date NOT NULL,                     -- UTC 日，仅用于限流，不用于分析
  event_count int  NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day)
)
```

**关系**：developer 1→N project 1→N project_keys / events / feedback / ai_reports。feedback 与 events 不建外键，通过 `paywall_session_id` 精确关联。

**设计说明**

- 不做 `anonymous_users` 表：漏斗按 session，删除用户直接删行，`first_seen` 需要时从 events 派生。
- 不做 `events.properties jsonb`：只需一个可选 `product_id`，显式列更好校验；以后加字段走迁移。
- events 不记录 `key_id`：`project_keys.last_used_at` 已足够判断旧 key 是否还在用。
- `ai_reports.period_*` 用 `date` 而不是 `timestamptz`：报告周期就是"本地自然日"，配合 `timezone` 字段可无歧义还原。

---

## F. Event Schema

### 全部事件（V0.1 固定 4 个）

| 事件 | 何时发送 | 由谁发 | 作用 |
|---|---|---|---|
| `paywall_viewed` | Paywall 真正显示给用户时（不是路由 push 时） | 开发者调用 SDK | 漏斗第 1 步；开启 paywall session |
| `subscribe_clicked` | 用户点击任一购买按钮，进入系统支付流程之前 | 开发者调用 | 漏斗第 2 步 |
| `purchase_success` | IAP 回调确认购买成功后（**恢复购买不发**） | 开发者调用 | 漏斗第 3 步；标记本 session 已转化 |
| `paywall_closed` | Paywall 被关闭/离开时，无论原因 | 开发者调用 | 结束 session；触发调查资格判断 |

**关于 `purchase_started`**：不加。RN + IAP 场景下"点击订阅"和"开始支付"几乎同一时刻。真正有区分度的缺口是"系统弹窗取消 vs 支付报错"，对应 `purchase_failed`，V0.1 由调查选项"支付遇到了问题"从用户视角覆盖，`purchase_failed` 列为 V0.2 第一候选。白名单是应用层一个数组，加事件是一行改动。

### 字段

| 字段 | 必填 | 谁填 | 说明 |
|---|---|---|---|
| `event_id` | 是 | SDK 自动 | UUID，幂等键 |
| `event_name` | 是 | 开发者（通过参数，TS 联合类型） | 白名单 |
| `anonymous_user_id` | 是 | SDK 自动 | 首次 init 生成，存 AsyncStorage；卸载重装会变，接受 |
| `paywall_session_id` | 是 | SDK 自动 | 见下"session 规则" |
| `platform` | 是 | SDK 自动 | `Platform.OS` |
| `app_version` | 是 | SDK：显式 `appVersion` > expo-application > `'unknown'`（并 warn） | ≤ 32 字符 |
| `paywall_version` | 否 | 开发者 | init 设默认，`paywall_viewed` 可单次覆盖，session 内继承；≤ 64 字符 |
| `product_id` | 否 | 开发者 | 仅 `subscribe_clicked` / `purchase_success`；区分月付/年付 |
| `occurred_at` | 是 | SDK 自动 | ISO 8601 UTC |

### Session 规则（SDK 侧）

细则以文首「实现规则」第 1、2 条为准。

- `paywall_viewed` 时新建 session id；session 内后续事件继承。
- session 尚未终止时再次调用 `paywall_viewed` → 忽略并 `console.warn`（防 re-render 造成假 session）。
- `paywall_closed` 与 `purchase_success` 都终止 session。`paywall_closed` 之后，同一 session id 只再保留 10 分钟，专供窗口内的 `purchase_success` 归属；窗口内收到则该 session 最终为 purchased。
- 没有打开的 session 时调用 `subscribe_clicked` / `purchase_success` / `paywall_closed` → SDK 仍要发送：新建一个 session id 并 warn。服务端不得丢弃这些事件，按 orphan 处理（只进健康度，不进漏斗）。

### 服务端时间钳制

`occurred_at` 比 `received_at` 晚 5 分钟以上（未来）或早 7 天以上，一律用 `received_at` 覆盖。手机时钟不可信，离线队列最多积压几天。

### 不收集

IP（处理完即丢，不落库）、设备型号、语言、地区、IDFA/IDFV、任何账号信息。

### Feedback 数据

```json
{
  "feedback_id": "uuid",
  "anonymous_user_id": "…",
  "paywall_session_id": "…",
  "reason_code": "too_expensive",
  "reason_label": "价格有点高",
  "comment": null,
  "platform": "ios",
  "app_version": "1.0.1",
  "paywall_version": "A",
  "occurred_at": "…"
}
```

默认 `reason_code` 集合：

```text
too_expensive | need_more_time | free_is_enough | unclear_value
no_need_now   | payment_issue  | other
```

开发者可自定义文案、增删选项，code 必须匹配 `^[a-z_]{2,40}$`。服务端只按 code 聚合，用 `reason_label` 展示（同一 code 多个 label 时取最近一次）。

---

## G. API 设计

### 公开接入 API（Client Key 认证）

认证：`Authorization: Bearer pl_pub_…`。`active` / `deprecated` 接受。`revoked` 返回 HTTP 401，body 固定为 `{ "error_code": "key_revoked" }`。key 不存在返回 HTTP 401，body 为 `{ "error_code": "key_invalid" }`。响应不回显任何用户数据。错误分类见文首「实现规则」第 3 条。

```text
POST /v1/events
  Body: { "events": [ {…}, … ] }        最多 50 条，body ≤ 64KB
  200: { "accepted": 48, "rejected": [ { "index": 3, "error": "unknown_event_name" } ] }
  401 { "error_code": "key_revoked" | "key_invalid" }   413 太大   429 超出日配额
  语义：逐条校验；合法的 INSERT … ON CONFLICT (project_id, event_id) DO NOTHING；
        部分失败不影响其余；重复提交返回 accepted 但不重复入库。

POST /v1/feedback
  Body: 单条 feedback（见 F）
  200: { "accepted": true }
  校验：comment ≤ 300 字；服务端对邮箱/手机号模式脱敏为 [removed]。

GET  /v1/health → 200
```

没有 `GET /v1/config`（见 M-2）。

### Dashboard API（登录 session 认证）

逻辑契约；读操作可直接用 Server Components 查库。所有接口第一步都是 `getOwnedProject(projectId, userId)`，查不到即 404——项目隔离的唯一入口。

```text
GET    /api/projects
POST   /api/projects              { name, timezone }   → 同时创建第一把 active key
PATCH  /api/projects/:id          { name?, timezone? }

POST   /api/projects/:id/keys     { label? }           → 新 active key
PATCH  /api/projects/:id/keys/:keyId { status: 'deprecated' | 'revoked' }
                                  规则：active→deprecated→revoked 单向；不允许撤销最后一把 active key
GET    /api/projects/:id/keys

DELETE /api/projects/:id/users/:anonymousUserId       删除该用户的 events + feedback
DELETE /api/projects/:id/data                          清空 events / feedback / ai_reports

GET    /api/projects/:id/filters?from&to               出现过的 app_versions / paywall_versions

GET    /api/projects/:id/overview?from&to&app_version?&paywall_version?
  {
    "timezone": "Asia/Shanghai",
    "funnel": { "sessions": 1240, "clicked": 286, "purchased": 137,
                "view_to_click": 0.231, "click_to_purchase": 0.479, "overall": 0.110 },
    "biggest_drop": { "step": "view_to_click", "lost": 954, "lost_rate": 0.769 },
    "closed_without_purchase": 1103,
    "feedback_count": 126, "feedback_response_rate": 0.114,
    "daily": [ { "date": "2026-09-15", "sessions": 180, "purchased": 21, "overall": 0.117, "partial": false }, … ],
    "health": { "last_event_at": "…", "event_names_seen": [...], "orphan_sessions": 0 }
  }

GET    /api/projects/:id/feedback/summary?from&to&…
  本期各 reason 的 count / share + 上一同长周期 share + delta_pp + low_sample 标记
GET    /api/projects/:id/feedback/comments?from&to&…&cursor   含 comment 的反馈，分页 50

POST   /api/projects/:id/reports  { "period": "7d" | "30d", filters? }
GET    /api/projects/:id/reports
GET    /api/projects/:id/reports/:reportId
```

### 漏斗计算的精确定义（写进代码注释与文档）

**计数单位是 paywall session**，不是用户，不是事件。

- **session 归属周期**：以该 session 的 `paywall_viewed`（最早一条）的 `occurred_at` 转成项目时区后落在哪个自然日为准。筛选 `app_version` / `paywall_version` 也取自这条 `paywall_viewed` 事件，保证一个 session 不会被筛选拆开。
- **各步计数**：
  - `sessions` = 周期内有 `paywall_viewed` 的 session 数
  - `clicked` = 其中任意时刻有 `subscribe_clicked` 的 session 数
  - `purchased` = 其中存在落在归属窗口内的 `purchase_success` 的 session 数（见文首实现规则第 1 条：未关闭，或购买时间 ≤ 最早关闭时间 + 10 分钟）
  - `closed_without_purchase` = 其中有 `paywall_closed`、且没有窗口内 `purchase_success` 的 session 数
- **转化率**：`view_to_click = clicked / sessions`，`click_to_purchase = purchased / clicked`，`overall = purchased / sessions`。分母为 0 时返回 null，页面显示"—"。
- **最大流失点**：比较 `sessions - clicked` 与 `clicked - purchased`，取绝对值大者。
- **回答率** = 周期内 feedback 条数 / `closed_without_purchase`（同为 session 口径）。
- **不强制顺序**：不检查 click 前必须有 view。没有 `paywall_viewed` 的事件必须入库并标为 orphan，只计入 health，不进入上面任一漏斗数字，也不用来“补”漏斗。窗口外的 `purchase_success` 同样入库，但不把 session 计为 purchased。
- **日分桶**：`(occurred_at AT TIME ZONE project.timezone)::date`。
- **上一周期**：与查询区间等长、紧邻其前的本地自然日区间。
- **口径说明**：同一用户反复打开 Paywall 会被算多次，得到的是"每次展示的转化率"，通常低于用户口径。用户级指标（unique users）未来单独增加，不与本漏斗混用。

聚合思路（SQL 草图，非实现代码）：

```sql
-- 1) 选出周期内的 session（锚定在 paywall_viewed）
WITH s AS (
  SELECT paywall_session_id, min(occurred_at) AS viewed_at
  FROM events
  WHERE project_id = $1 AND event_name = 'paywall_viewed'
    AND (occurred_at AT TIME ZONE $tz)::date BETWEEN $from AND $to
    AND ($app_version IS NULL OR app_version = $app_version)
    AND ($paywall_version IS NULL OR paywall_version = $paywall_version)
  GROUP BY paywall_session_id
),
-- 2) 只聚合锚到 paywall_viewed 的 session。无 paywall_viewed 的事件不在 s 中，因此不进漏斗。
agg AS (
  SELECT s.paywall_session_id,
         bool_or(e.event_name = 'subscribe_clicked') AS clicked,
         min(e.occurred_at) FILTER (WHERE e.event_name = 'paywall_closed') AS closed_at
  FROM s
  JOIN events e ON e.paywall_session_id = s.paywall_session_id AND e.project_id = $1
  GROUP BY s.paywall_session_id
),
-- 3) purchased 只认归属窗口：未关闭，或购买时间 <= 最早关闭时间 + 10 分钟
f AS (
  SELECT a.paywall_session_id,
         a.clicked,
         a.closed_at IS NOT NULL AS closed,
         EXISTS (
           SELECT 1 FROM events p
           WHERE p.project_id = $1
             AND p.paywall_session_id = a.paywall_session_id
             AND p.event_name = 'purchase_success'
             AND p.occurred_at <= COALESCE(a.closed_at, p.occurred_at) + interval '10 minutes'
         ) AS purchased
  FROM agg a
)
SELECT count(*), count(*) FILTER (WHERE clicked), count(*) FILTER (WHERE purchased),
       count(*) FILTER (WHERE closed AND NOT purchased)
FROM f;
```

---

## H. Expo / React Native 接入设计

### 方案 A vs 方案 B

| 维度 | A：REST API + 示例代码 | B：轻量 RN/Expo SDK |
|---|---|---|
| 实现复杂度 | 低（只有服务端） | 中（约 300–400 行 TS，无原生代码） |
| 接入体验 | 差：匿名 id 持久化、队列、重试、去重、session、调查资格——每个 App 复制一遍，各自写歪 | 好：init + 4 行 |
| 后续维护 | 示例代码复制出去就失控 | 改 SDK 即可；协议演进有落点 |
| 数据安全 | 各 App 自己实现校验/重试，容易漏 | 统一实现，字段由 SDK 填 |
| 版本兼容 | 与 RN 版本无关 | 纯 JS，Expo Go 可用 |
| 开发速度 | 服务端快，每个接入方慢 | 多 2–3 天一次性成本 |

**决定：B，"薄 SDK"。** SDK 只是对 REST 的封装，不含业务解释逻辑；REST 契约（G 节）独立文档化，将来 Flutter / Swift 端按同一契约实现。**V0.1 不发 npm**，用 pnpm workspace 本地包或 git 依赖装进自己的两个 App。

### 依赖设计

| 依赖 | 类型 | 用途 | 缺失时 |
|---|---|---|---|
| `react`, `react-native` | peer | 组件 | — |
| `@react-native-async-storage/async-storage` | **peer（必需）** | 匿名 id、队列、调查冷却期持久化 | init 抛错并给出安装提示 |
| `expo-application` | **optional peer**（`peerDependenciesMeta.optional: true`） | 自动读 `nativeApplicationVersion` | 用显式 `appVersion`；都没有则 `'unknown'` + warn |
| `expo-crypto` | optional peer | `randomUUID` | 退化为 `crypto.randomUUID`（若存在）→ 时间戳 + 随机数 |

运行时用 try-require 探测 optional peer，不做静态 import。SDK 自身 `dependencies` 为空。

### 开发者视角

```ts
import { PayLens } from '@paylens/react-native';

PayLens.init({
  clientKey: 'pl_pub_…',
  appVersion: '1.0.1',           // 可选；不传则尝试 expo-application
  paywallVersion: 'A',           // 可选默认值
  endpoint: 'https://…/v1',      // 可选；默认为 SDK 内置常量
  survey: {                      // 可选；不传用默认 7 个选项（中英文案）
    question: '这次没有升级 Pro 的主要原因是什么？',
    options: [{ code: 'too_expensive', label: '价格有点高' }, /* … */],
    allowComment: true,
    cooldownDays: 7,
  },
});

// Paywall 组件
useEffect(() => { PayLens.track('paywall_viewed'); }, []);     // 真正显示时
onPressSubscribe = () => PayLens.track('subscribe_clicked', { productId });
onPurchaseSuccess = () => PayLens.track('purchase_success', { productId });
onClose = () => {
  PayLens.track('paywall_closed');
  if (PayLens.shouldShowExitSurvey()) setSurveyVisible(true);
};

<PayLensExitSurvey visible={surveyVisible} onClose={() => setSurveyVisible(false)} />
// 想完全自定义 UI：PayLens.submitFeedback(reasonCode, { label, comment })
```

`track` 第一个参数是 TS 联合类型，打错事件名编译报错。

### SDK 内部职责

- **anonymous_user_id**：首次 init 生成 UUID，存 AsyncStorage。
- **paywall session**：见 F 节"Session 规则"。
- **队列**：内存队列 + 持久化到 AsyncStorage；flush 触发：积 10 条 / 每 15 秒 / App 进入后台（AppState）。失败保留重试，最多 500 条，超出丢最旧；批量 POST ≤ 50 条。停止这把 key 的重试**只**发生在响应 `error_code=key_revoked` 时。网络错误、超时、408、429、5xx、以及其他 401 都按文首实现规则第 3 条退避重试。
- **调查资格**：当前 session 已 viewed、已 closed、无 purchase_success，且本地上次展示时间距今 ≥ `cooldownDays`。全部本地判断，无网络请求。
- **失败静默**：任何异常不得让宿主 App 崩溃，只 `console.warn`。
- **自带组件**：纯 RN 原生控件（Modal、Pressable、TextInput），无 UI 库依赖；输入框下固定提示"请勿填写个人信息"。

---

## I. AI 分析架构

### 原则

> 代码负责计算事实，AI 负责解释事实。**所有数字、百分比、变化量、事实句、关键变化句由代码生成；模型不生成任何事实性数字。**

模型只负责三件事：文字反馈的主题归类、Hypotheses、Suggested Tests（以及每条推断的简短解释）。

### 流程

```text
① 代码：构建 Snapshot         漏斗 / 各原因 count & share / 上期对比 / 回答率 / 小样本标记
② 代码：样本门槛判断          不达标 → 存 insufficient_data 报告（含 ①），流程结束，不调模型
③ 模型：评论主题归类          输入 ≤ 100 条评论，输出 {comment_id, theme} 严格 JSON
④ 代码：主题计数              "11 条提到 X" 由代码数出
⑤ 代码：生成 Facts / Key Changes   模板化句子，每条带 id 和 source_keys
⑥ 模型：生成 Hypotheses / Suggested Tests   输入 = Snapshot（含 ⑤），输出严格 JSON
⑦ 代码：引用校验 + 落库       based_on 必须指向存在的 fact id；文本中若出现数字必须能在 Snapshot 找到
```

### 样本量门槛（V0.1 产品级保守阈值）

不是统计显著性检验，是 V0.1 为避免误导而设的保守规则：

- 报告级：`sessions < 100` 或 `feedback_total < 20` → `status = insufficient_data`，不调模型。Dashboard 的确定性统计（漏斗、分布、上期对比）**照常显示**，Insights 页仍显示代码生成的 Facts 与数据说明。
- 原因级：某 reason 本期或上期 `count < 30` → `low_sample: true`，页面标"(小样本)"；其变化不进 Key Changes，模型被禁止把它作为推断依据。
- 阈值是常量，写在一处，未来按真实数据调整。

### ① Snapshot 结构（`ai_reports.input_snapshot`）

```json
{
  "timezone": "Asia/Shanghai",
  "period":  { "start": "2026-09-15", "end": "2026-09-21", "days": 7 },
  "compare": { "start": "2026-09-08", "end": "2026-09-14" },
  "filters": { "app_version": null, "paywall_version": null },
  "thresholds": { "min_sessions": 100, "min_feedback": 20, "min_reason_count": 30, "met": true },
  "funnel": {
    "current":  { "sessions": 1240, "clicked": 286, "purchased": 137,
                  "view_to_click": 0.231, "click_to_purchase": 0.479, "overall": 0.110 },
    "previous": { "sessions": 1105, "clicked": 270, "purchased": 136, "overall": 0.123 },
    "biggest_drop": { "step": "view_to_click", "lost": 954, "lost_rate": 0.769 }
  },
  "feedback": {
    "total": 126, "closed_without_purchase": 1103, "response_rate": 0.114,
    "reasons": [
      { "code": "too_expensive", "label": "价格有点高", "count": 48, "share": 0.38,
        "prev_count": 52, "prev_share": 0.40, "delta_pp": -2, "low_sample": false },
      { "code": "need_more_time", "label": "还想再体验一下", "count": 33, "share": 0.26,
        "prev_count": 22, "prev_share": 0.17, "delta_pp": 9, "low_sample": false }
    ]
  },
  "comment_themes": [
    { "theme": "paywall_too_early", "count": 7, "examples": ["…", "…"] },
    { "theme": "core_feature_not_experienced", "count": 5, "examples": ["…"] }
  ],
  "by_product": [ { "product_id": "pro_annual", "clicked": 190, "purchased": 71 } ],
  "facts": [
    { "id": "F1", "text": "整体转化率 11.0%，上期 12.3%，下降 1.3 个百分点",
      "source_keys": ["funnel.current.overall", "funnel.previous.overall"] },
    { "id": "F2", "text": "最大流失点：Paywall → 点击订阅，流失 954 次（76.9%）",
      "source_keys": ["funnel.biggest_drop"] },
    { "id": "F3", "text": "“还想再体验一下”占 26%（n=33），上期 17%，上升 9 个百分点",
      "source_keys": ["feedback.reasons[need_more_time]"] },
    { "id": "F4", "text": "11 条文字反馈归为主题“未体验核心功能就看到付费页”",
      "source_keys": ["comment_themes[paywall_too_early]", "comment_themes[core_feature_not_experienced]"] }
  ],
  "key_changes": ["F1", "F3"],
  "caveats": [
    "回答率 11.4%，回答者可能不代表全部未购买用户",
    "漏斗按 Paywall 展示次数计算，同一用户多次打开会被计多次"
  ]
}
```

### ⑤ 代码生成 Facts 的规则

固定模板集合，确定性输出，每条带 id：

| 模板 | 触发条件 |
|---|---|
| 整体转化 + 上期 + 变化 | 总是 |
| 最大流失点 | 总是 |
| 各步转化率 + 上期变化 | 总是（两条） |
| 占比最高的原因 | 总是 |
| 某原因变化 ≥ 5pp | `low_sample=false` 且 `|delta_pp| ≥ 5` |
| 主题计数 | 主题 `count ≥ 3` |
| 分产品转化差异 | 有 ≥ 2 个 product_id 且各 `clicked ≥ 30` |
| 回答率 | 总是（进 caveats） |

`key_changes` = 满足"变化"类模板的 fact id 子集。

### ③ 主题归类

- 预置主题：`paywall_too_early`, `core_feature_not_experienced`, `price_too_high_annual`, `price_too_high_monthly`, `want_trial`, `unclear_value`, `payment_error`, `already_has_alternative`, `other`。
- 模型可为无法归类的评论输出新的 snake_case 主题；代码只保留出现 ≥ 2 次的新主题，其余合并 `other`。
- 一次调用处理全部评论（V0.1 < 100 条），代码按 `comment_id` 对齐，缺失记 `other`。
- 模型看到的评论已经过服务端脱敏。

### ⑥ 模型输出结构（`ai_reports.output`）

```json
{
  "hypotheses": [
    { "id": "H1",
      "text": "Paywall 可能出现得过早，用户在体验核心功能前就被要求付费",
      "based_on": ["F3", "F4"],
      "confidence": "medium" }
  ],
  "suggested_tests": [
    { "id": "T1",
      "text": "新增 paywall_version=B：用户完成一次核心操作后再展示 Paywall",
      "for_hypothesis": "H1",
      "measure": "对比 A/B 的 view_to_click 与 need_more_time 占比，各至少 200 sessions" }
  ],
  "notes": "可选，一两句对整体的解释，不得含数字"
}
```

模型**没有** `facts` / `key_changes` 字段可写。

### ⑦ 防 hallucination 手段

1. 模型拿不到原始 events，也不负责写事实——它没有机会算错或编数字。
2. 输出用 JSON Schema 强约束（structured output），字段不对直接拒收。
3. `based_on` 必须全部指向 Snapshot 中存在的 fact id；引用了 `low_sample` 原因对应事实的推断被丢弃。
4. 轻量数字兜底：模型文本中出现的任何数字必须能在 Snapshot 值中找到（±0.1），否则该条丢弃；全部被丢弃则 `failed`。
5. Prompt 硬规则：不得使用"导致 / 因为 / 证明"表述；`confidence` 只允许 low / medium / high；不得建议 Snapshot 中没有数据支持的测试。
6. 保存 Snapshot + `prompt_version` + `model`：任何报告都能回答"当时给模型看了什么"，改 prompt 可用同一 Snapshot 重跑对比。
7. UI 三栏分离：事实（代码）/ 推断（AI）/ 建议测试（AI），每条推断下显示依赖的 fact id。

### AI Provider 抽象

```text
interface AiProvider {
  generateStructured<T>(input: { system: string; user: string; schema: JsonSchema }): Promise<T>
}
```

V0.1 只实现一个支持 JSON structured output 的供应商；供应商名与 key 来自环境变量。不做多供应商路由、不做 fallback。

### 报告周期与触发

- 周期按项目时区的**完整自然日**：`7d` = 截至昨天的 7 个本地自然日，对比 = 再往前 7 天。不含今天。
- 只有 Insights 页手动"生成报告"；同项目 + 同周期 + 同筛选 1 小时内重复点击直接返回已有报告。
- 先同步生成（10–30 秒 + 前端 loading）；超出平台函数时限再改 `pending` + 轮询，schema 已预留 `status`。
- 每周自动生成、邮件推送 = V0.2。

---

## J. 安全与隐私

### 第一版必须做的安全措施

| 项 | 做法 |
|---|---|
| Key 模型 | 只有公开 Client Key（`pl_pub_`），设计上就当它会泄露。一个项目多把 key，状态 active / deprecated / revoked，单向流转。不需要 server secret——V0.1 无服务端到服务端写入；V0.2 接商店 webhook 时再加 `pl_sec_`，那时用哈希存储 |
| Key 生命周期 | 新版本发布 → 新建 key → 旧 key 标 deprecated（仍接受）→ 观察 `last_used_at` → 归零后 revoke。不允许撤销最后一把 active key |
| 伪造事件 | 公开 key 无法根治，接受。缓解：事件名白名单、字段长度/格式校验、批次 ≤ 50、body ≤ 64KB、时间钳制、`paywall_session_id` 必须为 UUID |
| 配额 | 每项目每日事件上限（默认 100k），`project_daily_usage` 计数表，超出 429。不引入 Redis |
| 项目隔离 | 所有 Dashboard 查询经唯一入口 `getOwnedProject(projectId, userId)`；SQL 一律带 `project_id`。若后续用 Supabase 客户端直连再加 RLS 作第二层 |
| 认证分离 | Dashboard API 只接受 session；接入 API 只接受 Client Key |
| 秘密管理 | `DATABASE_URL`、AI key 等只在服务端环境变量；`.env` 入 `.gitignore`，提供 `.env.example` |
| 传输 | 仅 HTTPS |
| 依赖 | 锁 lockfile；SDK 运行时零依赖 |

### 隐私设计

- **最小采集**：见 F 节"不收集"。IP 不落库。
- **anonymous_user_id 是假名而非匿名**：GDPR / PIPL 下仍可能被视为个人信息。工程上准备好：按 id 删除、按项目清空、固定保留期自动删除。三件事 V0.1 都做。
- **保留期**：events / feedback 365 天后由 pg_cron 每日删除；ai_reports 保留（Snapshot 是聚合数据，`comment_themes.examples` 是脱敏后的短句）。
- **文字反馈是最大 PII 风险点**：SDK 输入框提示"请勿填写个人信息"、300 字上限、服务端正则脱敏邮箱/手机号、开发者可 `allowComment: false` 关闭。
- **给开发者的隐私提示（接入文档，非法律意见）**：
  - App Store 隐私标签：Identifiers → User ID（不与用户关联，用于分析）、Usage Data → Product Interaction、若开评论则 User Content → Other User Content。不涉及 ATT（无 IDFA、无跨 App 追踪）。
  - GDPR：分析类处理需要合法基础；隐私政策里应提及 PayLens 作为处理方。
  - PIPL：终端用户在中国大陆而服务器在境外涉及跨境传输，与 D 节部署决策直接相关。
  - 开发者与 PayLens 之间理论上需要 DPA；V0.1 自用先不做，记为对外开放前必做。

---

## K. 开发阶段

每阶段有"完成标准"，做完停下审查。**当前状态：Phase 3 已完成。等待确认后再进入 Phase 4。**

```text
Phase 0  骨架（1–2 天）
  pnpm workspace；Next.js + Drizzle + Supabase 连通；magic link 登录；
  developers / projects / project_keys 表；创建项目（含时区）自动生成第一把 key；.env.example。
  完成标准：能登录、能建项目、库里有 active key；timezone 非法值被拒。

Phase 1  事件进库（2–3 天）
  POST /v1/events；events 表；key 状态校验/去重/时间钳制/日配额；
  SDK 核心：init、track、匿名 id、session 规则、队列、flush、optional peer 探测；
  examples/expo-demo 一个假 Paywall；接入引导页 + "等待第一个事件"。
  完成标准：demo 点四个按钮库里出现四条事件且 session id 一致；重发同一批不重复；
           断网再联网补上；无 paywall_viewed 的后续事件仍入库且可标为 orphan；
           revoked key 返回 401 且 error_code=key_revoked，SDK 只在该错误停止这把 key 的重试；
           5xx / 429 仍重试；不传 appVersion 时能读到 expo-application。

Phase 2  漏斗（2 天）
  按 session 的 overview 查询（时区分桶、最大流失点、孤儿 session、health）；Overview 页；筛选条 + filters。
  完成标准：手工造数据并与手算一致，至少覆盖：一个用户多个 session、关闭后 10 分钟内的 purchase_success 归为 purchased、
           窗口外的 purchase_success 保留但不进漏斗、无 paywall_viewed 的事件保留为 orphan 且不进漏斗；
           切换项目时区后日分桶随之变化。

Phase 3  退出调查（2–3 天）
  POST /v1/feedback；feedback 表；SDK shouldShowExitSurvey + submitFeedback + 自带组件 + 冷却期；
  Feedback 页（分布、上期对比、low_sample 标记、评论列表）。
  完成标准：demo 关闭 Paywall 出现调查，选"其他"才出输入框，7 天内不再出现；
           purchase_success 后不出调查；页面占比正确；评论含邮箱被脱敏。

Phase 4  AI 报告（3 天）
  Snapshot 构建器（含 facts / key_changes 模板、阈值）；AiProvider 抽象 + 一个实现；
  主题归类；Hypotheses/Tests 生成；引用与数字校验；ai_reports；Insights 页。
  完成标准：造数据生成报告，facts 全由代码产出且可回溯；小样本得到 insufficient_data 且仍显示 facts；
           人为让模型输出不存在的 fact id 或错数能被丢弃。

Phase 5  设置与隐私操作（1–2 天）
  Settings 页：时区、key 管理（新建 / deprecated / revoked、last_used_at）、删除用户、清空项目；
  pg_cron 保留期删除；接入文档含隐私提示。
  完成标准：删除某 anonymous_user_id 后两张表无残留；deprecated key 仍可上报并更新 last_used_at；
           不能撤销最后一把 active key。

Phase 6  真实 App 接入与验证（持续 2–4 周）
  前置：专项验证中国大陆网络对接入端点的可达性，不可达则按 D 节切换部署目标（同一份代码）。
  接入两个 App；观察接入健康；累计到阈值；生成第一份报告；
  基于报告做一个真实改动（换 paywall_version）；对比。
  完成标准：能回答"这个工具有没有让我改了一个决定"。这是 V0.1 唯一的成功标准。
```

总量约 12–15 个工作日实现 + 验证期。

---

## L. 风险清单

| 类别 | 风险 | 应对 |
|---|---|---|
| 产品 | 小样本下百分比波动被当成趋势 | 产品级阈值 + low_sample 标记 + 不达标不出 AI 推断 |
| 产品 | 调查回答者偏差 | 回答率始终可见；caveats 必含 |
| 产品 | session 口径转化率"看起来低" | 页面标注口径；文档解释与用户口径的差别 |
| 产品 | 看了报告不行动，闭环不成立 | Phase 6 要求一次真实改动；paywall_version 让前后可比 |
| 产品 | 只有自己一个用户 | V0.1 就是先验证对自己有用 |
| 技术 | 设备时钟错乱 | 时间钳制 + 存 received_at |
| 技术 | 离线/重试导致重复 | 客户端 event_id + 唯一约束 |
| 技术 | re-render 触发多次 paywall_viewed | SDK 忽略 session 内重复 viewed |
| 技术 | 中国大陆不可达 | API base URL 可配置；架构不绑平台；Phase 6 前专项验证 |
| 技术 | 报告同步生成超时 | 先同步；超时改 pending + 轮询，schema 已预留 |
| 数据 | purchase_success 由客户端上报、未验证 | V0.1 接受；V0.2 商店 webhook 校正 |
| 数据 | 漏埋 paywall_closed → 调查不触发、closed 为 0 | 健康度显示事件种类；缺失即警告 |
| 数据 | 漏埋 paywall_viewed → 孤儿 session | 事件保留；只计入健康度，不进漏斗 |
| 数据 | 恢复购买误报为 purchase_success | 文档明确 + demo 示例 |
| 数据 | 卸载重装换 id | 接受，文档说明；漏斗按 session 不受影响 |
| 数据 | 旧版本 App 在 key 撤销后无法上报 | deprecated 过渡态 + last_used_at 观察 |
| 隐私 | 评论含 PII | 提示 + 上限 + 脱敏 + 可关闭 |
| 隐私 | 跨境 / 隐私标签 / 隐私政策遗漏 | 接入文档提示；部署决策 |
| AI | 编造数字、因果化 | 事实全由代码生成；模型只写推断；引用校验；数字兜底 |
| AI | 主题归类不稳定 | 预置主题集 + 新主题 ≥ 2 次才保留；Snapshot 存 examples 便于核对 |
| AI | 推断泛泛而谈 | suggested_tests 必带 measure 与 for_hypothesis |
| 接入 | Expo / AsyncStorage 版本冲突 | 纯 JS、peer dep 宽版本范围；demo 用与 App 相同 Expo 版本 |
| 接入 | 自带调查组件与 App 视觉不搭 | headless `submitFeedback` 兜底 |

---

## M. Scope Review（已确认采纳）

以下 11 条缩减已全部接受并落入正文：

1. **不建 `anonymous_users` 表** —— 漏斗按 session，删用户直接删行。
2. **调查问题 / 选项 / 是否允许文字反馈放在 SDK 配置，不放后台** —— 省掉 `GET /v1/config`、拉取、缓存、离线兜底、配置版本。远程配置为 V0.2 候选。
3. **Settings 不预注册 Paywall Version** —— 后台从数据里读出现过的值。
4. **Feedback 页不画分原因趋势图** —— 用与上一周期的 ±pp 表达。
5. **Overview 只保留一张图** —— 每日 Sessions + Overall Conversion。
6. **不加 `purchase_started`** —— `purchase_failed` 为 V0.2 第一候选。
7. **AI 报告只有手动按钮** —— 定时生成与推送为 V0.2。
8. **不引入 Redis / 专业限流** —— DB 计数表做日配额。
9. **只有一种结构化报告格式**。
10. **Dashboard API 不对外开放**。
11. **平台维度不做筛选器** —— `platform` 列保留。

本轮确认新增（都很小）：`paywall_session_id`（NOT NULL，SDK 自动）、`product_id`、`platform`、接入健康度（含孤儿 session）、样本量门槛、多 key 状态模型、`projects.timezone` 硬规则。

---

## N. 已确认的决策

| 决策 | 结论 |
|---|---|
| 漏斗口径 | 按 paywall session；用户级指标未来单独增加 |
| Client Key | 多 key，active / deprecated / revoked 单向流转 |
| 时区 | `projects.timezone` IANA；分桶、周期、Snapshot 全按项目时区 |
| AI 边界 | Facts / Key Changes / 数字全由代码生成；模型只做主题归类、Hypotheses、Suggested Tests、必要解释 |
| SDK 依赖 | AsyncStorage peer；expo-application / expo-crypto optional peer；`appVersion` 可显式传 |
| 样本门槛 | V0.1 产品级保守阈值；小样本仍显示确定性统计，只不生成 AI 推断 |
| 部署 | Phase 0–5 Vercel + Supabase；base URL 可配置；架构不绑平台；Phase 6 前验证中国大陆可达性 |
| AI Provider | 最小抽象层，V0.1 只实现一个 structured output 供应商 |
| SDK 分发 | V0.1 不发 npm，仅用于自己的两个 App |
| Session 终止 | `paywall_closed` 与 `purchase_success` 都终止 session；窗口内购买最终归 purchased |
| 孤儿事件 | 无 `paywall_viewed` 的事件入库并标记 orphan，只用于接入健康度 |
| 重试 | 仅 `error_code=key_revoked` 停止该 key 重试；网络错误、5xx、429 可重试 |
| 下一步 | Phase 3 已完成，等待确认后再进入 Phase 4 |
