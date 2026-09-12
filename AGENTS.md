# AGENTS.md — `@deepseek-ai/dsh-auto-continue`

本文件面向在此仓库工作的编程 Agent。开始改动前请先读完本文件，再按需查阅 `doc/` 下的权威文档。

## 1. 项目是什么

DeepSeek Harness（DSH）的**配额耗尽自动续跑**插件。当某个 provider 因订阅配额耗尽而返回
配额耗尽错误（v1 为 ZenMux HTTP 402 `quote_exceeded`）时，插件会：识别错误 → 查询平台配额
统计接口 → 在进程内等待配额重置 → 让 agent loop 在**同一个 turn/step 内**无感重发，并可
选地在重发前注入一条 user 角色提示。

- npm 包名：`@deepseek-ai/dsh-auto-continue`；服务名 `ctx.quota`；事件 `quota/changed`。
- **单包同时承载 host 与 client**（源码分别在 `src/` 与 `src/client/`）。这是刻意的：DSH 的
  client module 系统只扫描 **host loader 条目**的 `package.json` 来发现 client bundle，第三方
  独立插件必须 host+client 同包声明 `dsh.client`（第一方 monorepo 才拆成独立 client 包）。
- 平台模板（Platform Adapter）是一等对象：新增平台 = 实现 `PlatformQuotaAdapter`
  （`matchesQuotaExhausted` / `fetchQuota` / `resolveWaitTarget`，可选 `label` /
  `defaultBaseURL` / `optionsSchema` / `isExhausted`）+ 注册，**不修改状态机、设置与 UI**；
  端点、平台专属参数与「耗尽」口径都由适配器自带，多平台可并存。v1 仅内置 ZenMux 一个模板。

## 2. 权威文档与优先级

`doc/` 按用途分四类：**需求文档 / 设计文档 / 参考文档 / 记录**。

**需求文档**（只写「做什么、为什么、怎样算做到」，不含实现细节）：

1. `doc/需求文档/需求文档.md` — 唯一的需求规格（合并原 v1/v2 需求文档）：目标、功能与非功能
   需求、角色关系、验收标准；技术约定按 §9 对照表拆到设计文档。

**设计文档**（「怎么做」；接口签名与字段随版本演进）：

2. `doc/设计文档/平台模板设计约束.md` — **版本无关的设计要求与思想**：运行目标、模板/实例/
   Provider 关系、接入新平台的两条硬性要求（不影响其他代码 + 用接口契约保证隔离）、不变量清单；
   **改适配器接口或新增平台前先读它**。
3. `doc/设计文档/架构与集成设计.md` — 包与运行形态、模块职责边界、对外服务与事件、与 DSH 的集成点。
4. `doc/设计文档/平台适配器设计.md` — 接口契约具体形态、统一快照、判定链、ZenMux 规格、注册与校验时机。
5. `doc/设计文档/恢复流程设计.md` — 状态机、查询与退避、等待决策、关键流程、提示、可观测性、限制。
6. `doc/设计文档/配置与设置设计.md` — 配置字段与默认值、校验清单、凭据、设置通道、界面、变更生效语义。

**参考文档 / 记录**：

7. `doc/参考文档/DSH插件开发背景知识.md` — DSH / Cordis 插件开发背景（概念、事件模型、扩展点约定）。
8. `doc/记录/DSH-0.1.5-升级影响评估.md` — 框架升级影响评估与已验证的迁移清单；升级 DSH 前先读它。
9. `doc/记录/平台适配器扩展性审查.md` — v3 平台模板一等化改造的由来、探针证据与落地状态。

**约定**：

- 需求与设计冲突时，先改需求并说明，再改设计；实现不得默默偏离需求。
- 需求文档只放需求：出现配置字段表、接口签名、状态机、参数取值等实现细节，应移到设计文档。
- **改动行为后必须同步 `README.md`（使用者视角）与 `PROGRESS.md`（进度/决策）。**

## 3. 常用命令

```bash
pnpm install        # 安装依赖
pnpm typecheck      # tsc --noEmit（含 src 与 tests）
pnpm test           # vitest run：host 单元 + 集成（tests/**/*.spec.ts）
pnpm build          # 先 tsc -p tsconfig.build.json 出 lib/types/，再 tsdown 出 lib/index.js + lib/client.js
pnpm bundle         # 仅 tsdown（host ESM + client browser CJS 双半体）
pnpm pack           # 产出 tarball（用于 dsh plugin add file:...）
pnpm test:e2e       # scripts/e2e-mount.sh：build+pack → 官方 dsh plugin add → 真实 dsh web → Playwright
```

- `pnpm test:e2e` 是**真实端到端**：需要全局 `dsh`（`npm i -g @deepseek-ai/dsh`）与
  Playwright Chromium（`npx playwright install chromium` 及 `install-deps chromium`）。
  它自建 scratch `DSH_HOME`，通过 `dsh plugin --profile web add file:<tarball>` 挂载，然后用
  `--port 0` 启动真实 `dsh web`，最后用 Playwright 无头渲染断言。首次运行或环境缺依赖时会失败，
  不要把它当成纯单元测试。
  若 `~/.cache` 不可写（沙箱/受限环境），用
  `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers npx playwright install chromium` 安装，并以同一环境变量
  运行 `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers pnpm test:e2e`。
- `lib/` 是构建产物且被 `.gitignore` 忽略：**不要编辑、不要提交**。
- 交付/验证前至少跑通 `pnpm typecheck && pnpm test`；触及 client 或 bundle 时再跑 `pnpm build`。

## 4. 目录地图

```
src/
  index.ts             # QuotaRuntime（Service，默认导出）；ctx.quota + quota/changed 声明合并；
                       #   agent/request-error 与 session/event 监听；settings 接入；/auto-continue/api 路由
  config.ts            # v2 Config schema（Schemastery）+ validateConfig 跨字段校验 + 默认值常量
  state.ts             # InstanceRuntimeState / QuotaInstanceState；beginEpisode；computeStatsRetryDelays；parseResetsAt
  platform.ts          # PlatformQuotaAdapter 接口（+ label/defaultBaseURL/optionsSchema/
                       #   isExhausted）、QuotaFetchContext、归一化快照、耗尽判定
  platforms/index.ts   # 内置平台模板清单（新增内置平台在此追加一行）
  platforms/zenmux.ts  # ZenMux 适配器：错误识别、统计抓取、等待目标计算、默认端点
  recovery.ts          # 统计查询单飞 + 指数退避、abortableDelay、decideWaitAction
  notice.ts            # resumeNotice 模板渲染与消息构造（createUserMessage）
  wire.ts              # /auto-continue/api 的 JSON 读写与统一错误信封
  trust-fence.ts       # 自建路由的 DNS-rebinding / 跨站防御
  client/              # 浏览器侧独立设置选项卡（settings.section，id=auto-continue）
    index.tsx / AutoContinueSection.tsx / InstanceCard.tsx / edit-state.ts / api.ts /
    locales.ts / *.module.css   # edit-state.ts = 纯映射逻辑（可单测），卡片只负责渲染
tests/                 # vitest：config / settings / api / client-api / client-edit-state /
                       #   recovery / integration / platforms/zenmux（黄金样本）、
                       #   platforms/contract（第二平台契约）
                       #   platforms/zenmux-402-sample.ts（402 响应体/压平形态常量，非 spec）
tests/fixtures/        # 黄金样本：真实 API 原始响应，逐字节保存
                       #   zenmux-subscription-detail.json（健康账号统计）
                       #   zenmux-subscription-detail-402.json（达到配额上限时的统计）
                       #   zenmux-402-quote-exceeded.json（线上抓取的真实 402 错误响应体）
tests/e2e/             # Playwright：*.e2e.ts（不被 vitest 收集）
scripts/e2e-mount.sh   # e2e 编排
```

## 5. 架构要点（改动前必读）

**三层模型（v2）**：`Platform Adapter`（模板，代码能力）→ `Platform Instance`（实例值：`type`、
`baseURL`、`options`、Key、resumeNotice、statsRetry、postResetRetry、resetBufferMs）→
`Provider`（DSH LLM 路由，经 `providerBindings` 绑定到实例）。一个 provider 只能绑定一个实例；
一个实例可被多个 provider 绑定。全局仅剩 `platformBaseURL`，且已降级为 legacy 覆盖（默认空）。

**运行时判定链**：`agent/request-error` 的 `payload.provider` → `providerBindings[provider]` →
instance → `instance.type` 对应 adapter → `adapter.matchesQuotaExhausted(failure)`。

**平台模板一等化（v3）**：适配器自带 `label`（UI 展示名，经 `platforms.list` 下发）、
`defaultBaseURL`（端点）、`optionsSchema`（校验 `instance.options`）、`isExhausted`（覆盖通用
耗尽口径）。端点解析优先级：`instance.baseURL` → 全局 `platformBaseURL`（legacy，非空时）→
`adapter.defaultBaseURL`；都拿不到 → 告警并 `next()`。UI 平台下拉数据驱动，不为任何平台写死。

**状态维度**：恢复状态、`disabled`、统计查询单飞全部**按 instance 键控**。同实例的多个 provider
共享恢复状态与 `disabled`；一个 provider 未绑定实例 / 实例无 Key / 实例 `disabled` → 直接
`next()`。删除实例不中断 in-flight 等待；绑定变更在**下一次 402 判定**时生效。

**恢复状态机**（`state.ts` + `recovery.ts` + `index.ts`）：`idle` → `checking-stats` →
`waiting-reset`（等 `resetsAt + resetBufferMs`）或 `post-reset-retrying`（宽容退避），统计查询
1 小时退避耗尽 / post-reset 次数耗尽 → `disabled`。收到该实例 provider 的非 interrupted
`assistant/message`（`source.kind === 'model'`）→ 复位 `idle` 并清空 episode 标志。详见 `doc/设计文档/恢复流程设计.md`。

**平台规则只属于适配器**（设计约束全文见 `doc/设计文档/平台模板设计约束.md`）：恢复状态机不得内置任何
平台专属判断（错误正则、窗口名、等待目标算法、默认端点、专属参数、耗尽口径都在适配器里）。
新增平台 = 新适配器 + `registerPlatformAdapter`；内置平台另需在 `platforms/index.ts` 追加一行。
**`config.ts` / client / 状态机里不得出现任何具体平台名或平台专属默认值**；
契约表达不了的需求应扩展契约，而不是在通用层加平台特例。
**加载期与写入期的校验强度不同**：构造期对未知平台类型只告警（平台插件可能稍后加载，
base 层需要能提前声明），settings 写入路径严格抛错。

## 6. 铁律 / 不变量

1. **不改 DSH 其他包**：只允许修改本仓库；不修改、不 vendored-patch DSH 源码。所有集成通过
   公开扩展点（`ctx.on('agent/request-error')`、`ctx.webServer.register`、
   `ctx.settings.installSection`）。
2. **waterfall 语义**：`agent/request-error` 监听器对自己负责的配额错误**短路**（不调用
   `next()`，直接返回 `{kind:'retry'}` 或 `undefined`）；对其他错误必须 `next()`，交给
   `dsh-llm-retry` 等下游。不要吞掉非本插件负责的错误。
3. **一切等待可取消**：所有 `abortableDelay` 必须同时监听 `payload.signal`（turn 中止）与插件
   lifetime `AbortController`；插件卸载时清理全部 timer 与在途任务（用 `ctx.effect`）。
   取消**不得**改变共享状态（不因此置 `disabled`）。
4. **模型可见即落 surface 事件**：本插件只追加 `user/message`，且消息来源标记为 plugin。
   **不要改用 `system/message`**：它是「渲染后的系统提示词」所在节点，框架（`SystemPromptProjection`）
   会把非 in-history 路由（含 ZenMux 走的 pi-ai）上的后续系统节点置空 → 通知静默失效；
   依据见 `doc/设计文档/恢复流程设计.md` §6.1。
5. **凭据安全**：`managementKey` 标记 `role('secret')`，settings 描述符/线路响应中**不回显**；
   UI 留空 = 不修改（host 在 `settings.replace` 前从当前值回注 secret）。日志/事件中不得输出明文
   Key（统计响应打日志前注意脱敏）。
6. **配置 fail loud 且全字段有默认值**：schema 在 `config.ts`；跨字段校验统一走 `validateConfig`，
   同一条规则同时用于 base 层加载与 settings 写入（加载期可传 `deferUnknownPlatforms` 放宽
   “未知平台类型”，其余规则一律抛错）。实例 id 需匹配 `^[a-z][a-z0-9-]*$`；`type` 必填；
   `managementKeyRef` 与 `managementKey` 互斥；`baseURL` 需 http(s)；`options` 需普通对象且
   通过适配器 `optionsSchema`；`providerBindings` 值必须指向存在的实例。
7. **设置读写走自建 fenced 路由**：`/auto-continue/api`（`settings.get` / `settings.update` /
   `providers.list` / `platforms.list`），不走 DSH settings RPC（其 allowlist 不服务第三方
   命名空间）。新增 API 方法时必须做 trust-fence 校验（`isTrustedApiRequest`）并沿用 `wire.ts`
   的成功/错误信封 `{ok:true,value}` / `{ok:false,error:{code,message}}`。
8. **settings 分层语义**：`cordis.yml` 的 `config` 是 base 层，UI 只写 user 层；`platformInstances`
   默认 `{}`，实例应尽量全部落在 user 层以便 UI 真正增删。设置生效语义见 `doc/设计文档/配置与设置设计.md` §9。
9. **单包 host+client**：client 只能在 `src/client/` 且与 host 同包。`tsdown.config.ts` 的 client
   bundle 有 **purity gate**：禁止 Node builtin；非 `CLIENT_EXTERNALS` / `INLINE_SAFE` 的
   `@deepseek-ai/*` 值导入会构建失败。新增外部模块必须同时更新 `CLIENT_EXTERNALS`、
   `package.json` 的 peerDependencies 与 `dsh.client.inject`。
10. **`lib/` 是产物**：不要手工修改或提交。
11. **依赖版本锁定在 DSH `0.1.5-rc.2` 系列**：升级前先读
    `doc/记录/DSH-0.1.5-升级影响评估.md` 并跑全套测试。注意 semver prerelease 规则——
    `^0.1.0-rc.x` 这类旧区间**覆盖不到** `0.1.5-rc.2`。settings 注册必须用
    `ctx.inject(['settings'], sctx => sctx.settings.installSection(...))`；
    client 半体的 Context 类型来自 `@deepseek-ai/cordis`（`dsh-client-runtime` 已删除），
    且需 `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'` 才有 `ctx.slots` 类型。

## 7. 代码规范

- TypeScript strict，ESM，Node ≥ 支持 `AbortSignal.any` / `AbortSignal.timeout` 的版本。
- `verbatimModuleSyntax: true`：类型导入必须写 `import type`；**相对导入带 `.ts` / `.tsx` 扩展名**
  （`allowImportingTsExtensions: true`）。照抄现有文件的导入风格。
- 注释与面向用户文案用中文（`locales.ts` 双语）；代码标识符与日志用英文。保持现有注释密度，
  只在「为什么」不明显处补充。
- 纯逻辑放 `state.ts` / `platform.ts` / `recovery.ts` 的纯函数里，便于单测；I/O 与编排放
  `index.ts`。避免在 `index.ts` 里塞可测试算法。
- 事件名/服务名自带前缀（`quota/changed`、`ctx.quota`）；不占用 DSH 保留名。
- 不要引入未使用的配置字段或死代码；v2 已把 `statsRequestTimeoutMs` 降级为常量
  `STATS_REQUEST_TIMEOUT_MS = 30000`，不要再把它加回 schema。

## 8. 测试规范

- 运行器：vitest（`tests/**/*.spec.ts`，`environment: 'node'`）。e2e 命名为 `*.e2e.ts`，由
  Playwright（`pnpm test:e2e`）单独收集，vitest 默认 include 不会碰到它们。
- 时间相关用例统一用 **fake timers**（`vi.useFakeTimers()` + `vi.setSystemTime(...)` +
  `vi.advanceTimersByTimeAsync(...)`）；真实计时器只用于 `waitForNamespace` 这类需要事件循环
  推进的挂载等待（见 `tests/settings.spec.ts`）。
- 统计接口通过 `vi.stubGlobal('fetch', ...)` 打桩；**绝不访问真实 ZenMux API**。
- 自建路由用例：`ctx.provide('webServer', {register})` 捕获路由 + `ctx.provide('webRuntime', {trustedHosts})`，
  再用 fake req/res 直接调用（见 `tests/api.spec.ts`）。
- 修 bug 时先补一个能复现的失败用例；改行为时同步更新受影响的既有用例。
- **client 纯逻辑**：`src/client/edit-state.ts`（行 ⇄ 编辑态映射）与 `client/api.ts` 的纯函数
  由 `tests/client-edit-state.spec.ts` / `tests/client-api.spec.ts` 单测；**React 组件里不写
  可测逻辑**，卡片行为由 e2e 覆盖。
- **平台契约**：`tests/platforms/contract.spec.ts` 用非内置平台 `demo` 钉死架构承诺
  （base 层可声明未注册平台、独立插件注册、端点三档优先级、`options` 透传与 `optionsSchema`
  校验、`isExhausted` 覆盖、注销生效）。改适配器接口时必须同步更新它。
- **黄金样本**：`tests/fixtures/` 下保存真实 API 原始响应（逐字节，勿改写），由
  `tests/platforms/zenmux.spec.ts` 的「黄金样本」用例钉死字段映射与 402 识别规则。修改适配器
  解析/识别逻辑时必须让这些用例继续通过；若真实响应结构漂移，以样本为准修订映射并同步文档。
  现有样本：健康账号统计、**达到配额上限（402 条件成立）的统计**、**线上抓取的真实 402 错误响应体**
  （`zenmux-402-quote-exceeded.json`，尾部带 `request_id`）；识别回归同时覆盖 JSON 原文、
  `dsh-llm-pi-ai` 压平后的 `402: {json}` 与 `402 <message>` 形态，以及两类余额 402 的负例。
  三型响应体与压平形态集中在 `tests/platforms/zenmux-402-sample.ts`（非 spec，供平台与集成用例共用）；
  余额类两型暂无线上样本，取自 ZenMux 官方错误码参考
  <https://zenmux.ai/docs/guide/advanced/error-codes>。
- 当前基线：`pnpm test` 9 个文件 / 120 用例，`pnpm test:e2e` 3 用例。不要把用例数量当作硬指标，
  但**不得让基线回退**。

## 9. 已知待办与风险

- **框架版本基线**：已升级到 DSH `0.1.5-rc.2`（最新已发布），并在真实 `dsh web` 上通过
  `pnpm test:e2e`（3/3）。升级评估与证据见
  `doc/记录/DSH-0.1.5-升级影响评估.md`；再升级时先读它，避免重复踩 `installSettingsSection` /
  `dsh-client-runtime` 这两类历史坑。
- **黄金样本核对进度**（需求 §7 验收第 17/18 条）：
  - ✅ **统计字段映射已核对**：真实 `subscription/detail` 响应保存在
    `tests/fixtures/zenmux-subscription-detail.json`，由黄金样本用例锁定字段映射与
    `fetchQuota` 全链路（详见 `PROGRESS.md`「黄金样本回归」样本 1）。
  - ✅ **402 识别规则已核对**：**线上抓取的真实 402 响应体**（`quote_exceeded`，逐字节保存在
    `tests/fixtures/zenmux-402-quote-exceeded.json`）与账号达到配额上限时的真实统计响应
    （`tests/fixtures/zenmux-subscription-detail-402.json`，5h 已耗尽 → 等 5h 重置）一起回归；
    压平形态 `402: {json}` 已用真实 `dsh-llm-pi-ai` 的 `normalizeProviderError` /
    `formatProviderError` 实测复现，`quote_exceeded` 命中、`insufficient_credit`/`reject_no_credit`
    不命中。**现有识别规则无需修订**，无残留。
- `dsh-llm-pi-ai` 的错误压平行为可能变化（`failure.message` 可能是人类可读文本，也可能是转义的
  JSON 字符串）；识别逻辑必须同时覆盖两种形态。
- 长等待（5h/7d）依赖本机时钟解析 ISO 时间；实现用分段等待降低定时器漂移风险，改动等待逻辑时
  保持这一性质。
- 等待期间 session 处于 open turn：`ctx.sessions.fork` 会因 `OPEN_TURN` 被拒；这是已知限制，
  不是 bug。

## 10. 提交前自检

- [ ] `pnpm typecheck` 通过；`pnpm test` 通过且无用例回退。
- [ ] 涉及 client/bundle 时 `pnpm build` 通过（purity gate 无报错）。
- [ ] 新增/变更的配置字段有 schema 默认值，并通过 `validateConfig` 校验。
- [ ] 未在通用代码（`config.ts` / `recovery.ts` / `state.ts` / client）里写入任何具体平台名、
      平台专属默认值或平台专属判断。
- [ ] 新增/变更的等待路径可被 `payload.signal` 与 lifetime signal 取消，卸载无残留 timer。
- [ ] 新错误分支返回 `next()` 而非静默吞掉；quota 分支不误伤其他错误。
- [ ] 未泄露明文 Key；settings 响应保持 redacted。
- [ ] 同步更新了 `README.md`（行为/配置）与 `PROGRESS.md`（进度/决策）。
- [ ] 未修改本仓库之外的任何文件。
