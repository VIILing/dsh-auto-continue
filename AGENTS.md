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
- 目标平台：v1 仅适配 ZenMux；插件架构是「平台适配器（模板）+ 通用恢复状态机」，新增平台
  只需实现 `PlatformQuotaAdapter` 并注册，不修改状态机。

## 2. 权威文档与优先级

需求冲突时按以下顺序取信（后写者优先）：

1. `doc/DSH插件开发背景知识.md` — DSH / Cordis 插件开发背景（概念、事件模型、扩展点约定）。
2. `doc/dsh-auto-continue-需求文档.md` — v1 需求（恢复状态机、错误识别、等待目标等算法）。
3. `doc/dsh-auto-continue-需求文档-v2-补充.md` — **v2 增量，与 v1 冲突时以本文档为准**
   （三层模型 `platformInstances` + `providerBindings`、settings 接入、UI）。
4. `doc/DSH-0.1.5-升级影响评估.md` — 框架升级（0.1.1-rc.2 → 0.1.5-rc.2）影响评估、破坏点与
   已验证的迁移清单；升级 DSH 依赖前先读它。
5. `README.md` — 面向使用者的当前配置与行为说明。
6. `PROGRESS.md` — 实现进度与关键决策记录。

**改动行为后必须同步 `README.md`；完成里程碑/决策后必须更新 `PROGRESS.md`。** 需求文档是规格，
不要为实现方便而悄悄偏离；确有必要偏离时，先改文档并在 `PROGRESS.md` 记录理由。

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
  platform.ts          # PlatformQuotaAdapter 接口、归一化快照、窗口耗尽判定
  platforms/zenmux.ts  # ZenMux 适配器：错误识别、统计抓取、等待目标计算
  recovery.ts          # 统计查询单飞 + 指数退避、abortableDelay、decideWaitAction
  notice.ts            # resumeNotice 模板渲染与消息构造（createUserMessage）
  wire.ts              # /auto-continue/api 的 JSON 读写与统一错误信封
  trust-fence.ts       # 自建路由的 DNS-rebinding / 跨站防御
  client/              # 浏览器侧独立设置选项卡（settings.section，id=auto-continue）
    index.tsx / AutoContinueSection.tsx / InstanceCard.tsx / api.ts / locales.ts / *.module.css
tests/                 # vitest：config / settings / api / client-api / platforms/zenmux / recovery / integration
tests/fixtures/        # 黄金样本：真实 API 原始响应（如 zenmux-subscription-detail.json），逐字节保存
tests/e2e/             # Playwright：*.e2e.ts（不被 vitest 收集）
scripts/e2e-mount.sh   # e2e 编排
```

## 5. 架构要点（改动前必读）

**三层模型（v2）**：`Platform Adapter`（模板，代码能力）→ `Platform Instance`（实例值：Key、
resumeNotice、statsRetry、postResetRetry、resetBufferMs）→ `Provider`（DSH LLM 路由，经
`providerBindings` 绑定到实例）。一个 provider 只能绑定一个实例；一个实例可被多个 provider 绑定。
`platformBaseURL` 是唯一保留在全局的字段。

**运行时判定链**：`agent/request-error` 的 `payload.provider` → `providerBindings[provider]` →
instance → `instance.type` 对应 adapter → `adapter.matchesQuotaExhausted(failure)`。

**状态维度**：恢复状态、`disabled`、统计查询单飞全部**按 instance 键控**。同实例的多个 provider
共享恢复状态与 `disabled`；一个 provider 未绑定实例 / 实例无 Key / 实例 `disabled` → 直接
`next()`。删除实例不中断 in-flight 等待；绑定变更在**下一次 402 判定**时生效。

**恢复状态机**（`state.ts` + `recovery.ts` + `index.ts`）：`idle` → `checking-stats` →
`waiting-reset`（等 `resetsAt + resetBufferMs`）或 `post-reset-retrying`（宽容退避），统计查询
1 小时退避耗尽 / post-reset 次数耗尽 → `disabled`。收到该实例 provider 的非 interrupted
`assistant/message`（`source.kind === 'model'`）→ 复位 `idle` 并清空 episode 标志。详见 v1 §10–§13、
§12。

**平台规则只属于适配器**：恢复状态机不得内置任何平台专属判断（错误正则、窗口名、等待目标
算法都在 `platforms/zenmux.ts`）。新增平台 = 新适配器 + `registerPlatformAdapter`。

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
4. **模型可见即落 surface 事件**：本插件只追加 `user/message`。
   （注：DSH `0.1.5` 起 `SurfaceEventType` 已包含 `system/message`，v1 §19.3 预留的
   「系统消息升级」已具备技术前提；本插件当前仍用 user 角色，未跟进。）
5. **凭据安全**：`managementKey` 标记 `role('secret')`，settings 描述符/线路响应中**不回显**；
   UI 留空 = 不修改（host 在 `settings.replace` 前从当前值回注 secret）。日志/事件中不得输出明文
   Key（统计响应打日志前注意脱敏）。
6. **配置 fail loud 且全字段有默认值**：schema 在 `config.ts`；跨字段校验统一走 `validateConfig`，
   同一条规则同时用于 base 层加载与 settings 写入。实例 id 需匹配 `^[a-z][a-z0-9-]*$`；
   `managementKeyRef` 与 `managementKey` 互斥；`providerBindings` 值必须指向存在的实例。
7. **设置读写走自建 fenced 路由**：`/auto-continue/api`（`settings.get` / `settings.update` /
   `providers.list`），不走 DSH settings RPC（其 allowlist 不服务第三方命名空间）。新增 API 方法
   时必须做 trust-fence 校验（`isTrustedApiRequest`）并沿用 `wire.ts` 的成功/错误信封
   `{ok:true,value}` / `{ok:false,error:{code,message}}`。
8. **settings 分层语义**：`cordis.yml` 的 `config` 是 base 层，UI 只写 user 层；`platformInstances`
   默认 `{}`，实例应尽量全部落在 user 层以便 UI 真正增删。设置生效语义见 v2 §4.1。
9. **单包 host+client**：client 只能在 `src/client/` 且与 host 同包。`tsdown.config.ts` 的 client
   bundle 有 **purity gate**：禁止 Node builtin；非 `CLIENT_EXTERNALS` / `INLINE_SAFE` 的
   `@deepseek-ai/*` 值导入会构建失败。新增外部模块必须同时更新 `CLIENT_EXTERNALS`、
   `package.json` 的 peerDependencies 与 `dsh.client.inject`。
10. **`lib/` 是产物**：不要手工修改或提交。
11. **依赖版本锁定在 DSH `0.1.5-rc.2` 系列**：升级前先读
    `doc/DSH-0.1.5-升级影响评估.md` 并跑全套测试。注意 semver prerelease 规则——
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
- **黄金样本**：`tests/fixtures/` 下保存真实 API 原始响应（逐字节，勿改写），由
  `tests/platforms/zenmux.spec.ts` 的「黄金样本」用例钉死字段映射。修改适配器解析逻辑时必须
  让这些用例继续通过；若真实响应结构漂移，以样本为准修订映射并同步文档。
- 当前基线：`pnpm test` 7 个文件 / 75 用例，`pnpm test:e2e` 3 用例。不要把用例数量当作硬指标，
  但**不得让基线回退**。

## 9. 已知待办与风险

- **框架版本基线**：已升级到 DSH `0.1.5-rc.2`（最新已发布），并在真实 `dsh web` 上通过
  `pnpm test:e2e`（3/3）。升级评估与证据见
  `doc/DSH-0.1.5-升级影响评估.md`；再升级时先读它，避免重复踩 `installSettingsSection` /
  `dsh-client-runtime` 这两类历史坑。
- **黄金样本核对进度**（v1 §1.3 / §18-8）：
  - ✅ **统计字段映射已核对**：真实 `subscription/detail` 响应保存在
    `tests/fixtures/zenmux-subscription-detail.json`，由黄金样本用例锁定 §8.3 映射与
    `fetchQuota` 全链路（详见 `PROGRESS.md`「黄金样本回归」）。
  - ⏳ **402 识别正则仍待真实 402 样本核对**（§9.3）：当前样本账号额度健康，无法构造真实 402。
    拿到真实 `quote_exceeded` 响应后补一次回归，必要时按真实样本修订 `platforms/zenmux.ts`
    正则与 v1 §9.3。
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
- [ ] 新增/变更的等待路径可被 `payload.signal` 与 lifetime signal 取消，卸载无残留 timer。
- [ ] 新错误分支返回 `next()` 而非静默吞掉；quota 分支不误伤其他错误。
- [ ] 未泄露明文 Key；settings 响应保持 redacted。
- [ ] 同步更新了 `README.md`（行为/配置）与 `PROGRESS.md`（进度/决策）。
- [ ] 未修改本仓库之外的任何文件。
