# 开发进度：@deepseek-ai/dsh-auto-continue

> 本文件记录 `@deepseek-ai/dsh-auto-continue` 插件的任务规划与实现进度。
> 关联文档：`doc/需求文档/需求文档.md`、`doc/设计文档/`（平台模板设计约束 / 架构与集成 /
> 平台适配器 / 恢复流程 / 配置与设置）、`doc/参考文档/DSH插件开发背景知识.md`。

## 当前状态

**v1 + v2 全部完成，并已升级到 DSH `0.1.5-rc.2`（最新已发布版本）验证通过。**
单包（host + client）独立仓库，含三层模型、instance 键控状态机、
`SettingsProvider.installSection` + 自建 `/auto-continue/api` 路由、
浏览器侧 `settings.section` 独立设置选项卡。
验证：`pnpm typecheck` ✅、`pnpm build` ✅、`pnpm test`（9 文件 / 120 用例）✅、
`pnpm test:e2e`（3 用例，对真实 `dsh web`）✅。

> 框架依赖基线：DSH `0.1.5-rc.2`（升级前为 `0.1.1-rc.2`）。升级影响评估见
> `doc/记录/DSH-0.1.5-升级影响评估.md`。

## 任务列表与进度

图例：`[x]` 已完成，`[~]` 进行中，`[ ]` 待办。

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| 0 | 阅读技术文档与需求文档 | [x] | 已阅读 `doc/参考文档/DSH插件开发背景知识.md` 与需求文档 |
| 1 | 编写进度 PROGRESS.md | [x] | 本文件 |
| 2 | 搭建包骨架 | [x] | `package.json` / `tsconfig.json` / `vitest.config.ts` / `.gitignore` |
| 3 | 实现 `src/config.ts` | [x] | Config schema（Schemastery）与 provider 配置解析、fail loud 校验 |
| 4 | 实现 `src/platform.ts` | [x] | `PlatformQuotaAdapter` 接口、归一化快照类型、窗口耗尽判定 |
| 5 | 实现 `src/state.ts` | [x] | `ProviderRuntimeState`、公开状态快照、`computeStatsRetryDelays`、`parseResetsAt` |
| 6 | 实现 `src/platforms/zenmux.ts` | [x] | ZenMux 适配器：错误识别、统计抓取、等待目标计算 |
| 7 | 实现 `src/notice.ts` | [x] | resumeNotice 消息构造（`createUserMessage`）与模板渲染 |
| 8 | 实现 `src/recovery.ts` | [x] | 统计查询单飞+退避、可取消等待、`decideWaitAction` 决策 |
| 9 | 实现 `src/index.ts` | [x] | `QuotaRuntime` 服务（默认导出）、`ctx.quota` 与 `quota/changed` 声明合并 |
| 10 | 编写单元/集成测试 | [x] | 3 个测试文件、46 个用例全部通过 |
| 11 | 安装依赖并构建/类型检查 | [x] | `pnpm install` + `tsc` 编译 + `tsc --noEmit` 通过 |
| 12 | 运行测试并修复 | [x] | `vitest run`：3 passed / 46 passed |
| 13 | 编写 README.md | [x] | 配置方式、示例 overlay、限制与未来扩展点 |

## 最终验证结果

- 类型检查：`tsc -p tsconfig.json --noEmit` ✅
- 构建：`tsc -p tsconfig.json` 输出到 `lib/` ✅
- 测试：`vitest run` → **3 个测试文件、46 个用例全部通过** ✅
- 冒烟：从构建产物 `lib/index.js` 加载 `QuotaRuntime`，`ctx.quota` 服务可用 ✅

## 关键实现决策记录

- **插件形态**：`Service` 子类（默认导出），服务名 `ctx.quota`，`static Config` 指向 Schemastery schema。
- **依赖注入**：`credentials` 为可选依赖（用 `ctx.get('credentials')` 探测），无硬性 `static inject`；恢复监听器挂载在根 ctx（未加 scope 标签，因此接收所有 agent 的 `agent/request-error`）。
- **错误识别**：只调用 provider 对应平台适配器的 `matchesQuotaExhausted`，恢复状态机不内置平台规则（§9.1）。
- **等待目标**：`resolveWaitTarget` 返回“重置时刻”epoch ms（不含 buffer）；恢复状态机加 `resetBufferMs` 得到最终等待时刻。
- **首次错误 vs 重入**：`idle` 进入为“新 episode”（重置 `episodeWaitedReset` / `noticeAppended` / `postResetAttempts`）；其它 phase 进入视为同一 episode 的延续。
- **统计查询单飞**：`statsFlight` 单飞；查询由插件 lifetime 信号 + 单次请求超时（`statsRequestTimeoutMs`）控制，不被单个 turn 信号取消（因跨调用方共享）。
- **成功复位**：监听 `session/event`，当某 provider 处于 `waiting-reset`/`post-reset-retrying` 时收到非 interrupted 的 `assistant/message`（`message.source.kind === 'model'`）即复位为 `idle` 并清空 episode 标志。

## 依赖清单（最终）

- peer：`@deepseek-ai/cordis`
- runtime：`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-launch-environment`、`@deepseek-ai/dsh-llm`（`createUserMessage` 用于 notice）
- type/dev：`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-llm`
- dev：`typescript`、`vitest`、`@types/node`

> 说明：需求 §5.1 将 `dsh-llm` 标为 type，但 `resumeNotice` 需要 `createUserMessage`（运行时）来生成合法 `UserMessage`，故将 `dsh-llm` 作为运行时依赖。`dsh-credentials` 仅用于类型（`CredentialRef` 类型 + `ctx.credentials` 声明合并），不产生运行时导入。

## 模块结构

```
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsdown.config.ts        # host（ESM node）+ client（browser CJS）双半体构建（vendor 逻辑）
├── cordis.patch.yml        # dsh.bundle.patch：insert 插件挂载行
├── vitest.config.ts
├── README.md
├── PROGRESS.md
├── doc/
│   ├── 需求文档/需求文档.md（原 v1 + v2 补充，后已合并）
│   └── 参考文档/DSH插件开发背景知识.md
├── src/
│   ├── index.ts            # QuotaRuntime；installSettingsSection + 自建 /auto-continue/api 路由
│   ├── config.ts           # v2 Config schema + validateConfig
│   ├── state.ts            # InstanceRuntimeState（按 instance 键控）
│   ├── platform.ts         # PlatformQuotaAdapter 接口与归一化类型
│   ├── platforms/zenmux.ts # ZenMux 适配器
│   ├── recovery.ts         # 恢复状态机
│   ├── notice.ts           # resumeNotice 消息构造
│   ├── wire.ts             # /auto-continue/api JSON 读写辅助
│   ├── trust-fence.ts      # DNS-rebinding / 跨站防御
│   └── client/             # 浏览器侧独立设置选项卡（settings.section）
│       ├── index.tsx       #   入口：inject + slot 注册
│       ├── AutoContinueSection.tsx   # 父：标题/简介/卡片列表/新增按钮
│       ├── InstanceCard.tsx #   子：可展开卡片 + 表单字段 + 删除确认
│       ├── AutoContinueSection.module.css  # 设计令牌样式
│       ├── css-modules.d.ts #   CSS Module 类型声明
│       ├── api.ts          #   自建路由 fetch + 编辑/解绑纯函数
│       └── locales.ts      #   zh/en
└── tests/
    ├── config.spec.ts
    ├── settings.spec.ts
    ├── api.spec.ts
    ├── client-api.spec.ts
    ├── platforms/zenmux.spec.ts
    ├── recovery.spec.ts
    └── integration.spec.ts
```

---

## v2 补充（instance 三层模型 + 设置 UI）

> 依据需求文档（当时为 v2 补充文档，现已合并进 `doc/需求文档/需求文档.md`）。

### v2 任务进度

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| V1 | 研究 settings / installSettingsSection / role(secret) / client UI 契约 | [x] | 确认 `installSettingsSection`、`SettingsScope`、`settings.plugin.item` slot 等 API |
| V2 | 重构 `src/config.ts` 为三层结构 | [x] | `platformBaseURL` + `platformInstances` + `providerBindings`；`validateConfig` 跨字段校验 |
| V3 | 重构 `src/state.ts` 为 instance 维度 | [x] | `InstanceRuntimeState` / `QuotaInstanceState` |
| V4 | 调整 `src/recovery.ts`（按 instance 的 statsRetry/超时） | [x] | `FetchStatsOptions` 改为接收 `statsRetry` + `statsRequestTimeoutMs` |
| V5 | 重构 `src/index.ts`：instance 键控 + installSettingsSection + 事件按 instance | [x] | `status/isDisabled/statusForProvider`；`quota/changed(instanceId, state, providers)` |
| V6 | 更新单元/集成测试 | [x] | 新增 `tests/config.spec.ts`；重写 `tests/integration.spec.ts`；新增 `tests/settings.spec.ts`（settings 变更语义） |
| V7 | 构建/类型检查/测试 | [x] | 最终 68 用例全部通过 |
| V8 | client 侧 UI | [x] | 单包 `src/client/`（index.tsx + AutoContinueCard.tsx + api.ts + locales.ts），vendor tsdown clientBundle 编译 |
| V9 | 更新 README / PROGRESS | [x] | 本文件与 README 已更新为 v2 |
| V10 | Playwright UI 冒烟 + 文档收尾 | [x] | `tests/e2e/`（3 用例）+ `scripts/e2e-mount.sh`；本文件与 README 最终核对 |

### v2 关键决策

- **三层模型**：Platform Adapter（模板，代码级能力）→ Platform Instance（实例值）→ Provider（绑定）。
- **状态维度**：恢复状态、`disabled`、统计单飞全部按 instance 键控；`handleRequestError` 走
  `provider → providerBindings[provider] → instance → instance.type 对应 adapter`。
- **字段归属**：`resumeNotice`/`statsRetry`/`postResetRetry`/`resetBufferMs`/`managementKey*` 进实例；
  `platformBaseURL` 留全局；`statsRequestTimeoutMs` 从 v2 配置中移除，改为常量 `STATS_REQUEST_TIMEOUT_MS = 30000`。
- **Settings 接入**：`installSettingsSection(ctx, 'auto-continue', Config, entry, { setSource, onChange, validate })`；
  `managementKey` 标记 `role('secret')`；`validateConfig` 同时用于 base 层 fail-loud 与 settings 写入校验。
- **事件**：`quota/changed(instanceId, state, affectedProviders)`；`affectedProviders` 由 `providerBindings` 反查。
- **设置生效语义**：`currentConfig` thunk 实时读取；in-flight 等待不中断；新增/删除/改绑定在下一次 402 判断时生效。

### v2 验证结果（最终）

- 类型检查：`pnpm typecheck`（`tsc --noEmit`）✅
- 构建：`pnpm build`（`tsc -p tsconfig.build.json` 出声明 + `tsdown` 出 host/client 双半体）✅
- 单元/集成测试：`pnpm test`（`vitest run`）→ **7 个测试文件、71 个用例全部通过** ✅
- settings 变更语义：内存版 `SettingsProvider` + `installSettingsSection` 集成验证（新增实例/绑定、解绑、删除实例后 in-flight 等待不中断、跨字段校验拒绝写入）✅
- UI 冒烟：`pnpm test:e2e`（Playwright 对真实 `dsh web`）→ **3 个用例全部通过** ✅

### 依赖清单（v2 新增）

- host runtime 新增：`@deepseek-ai/dsh-settings`（`installSettingsSection` / `settingsNamespace`）、`@deepseek-ai/dsh-host-webserver`（`ctx.webServer.register` 自建路由）。
- client 新增：`@deepseek-ai/dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`（`Modal`/图标）、`dsh-client-locale` + `react`/`react-dom` + `tsdown`/`lightningcss`（构建期）。

### 独立仓库构建 client UI（已实现，推翻此前 blocked 结论）

参照 `DSH-better-sidebar`（/home/ubuntu/DSH-better-sidebar），在**独立仓库内本地复刻（vendor 逻辑）**
了 monorepo 的 `clientBundle()` 预设，无需依赖 monorepo 源码：

- 根 `tsdown.config.ts` 本地实现 `clientBundle` / `purityGatePlugin` / `makeCssPlugin` / `injectTag`，
  硬编码 `CLIENT_EXTERNALS`（react/cordis/`@deepseek-ai/dsh-client-ui-slots`/`@deepseek-ai/dsh-client-ui-primitives`/`dsh-client-runtime/client` 等）与 `INLINE_SAFE` 正则，
  并以 `window.__ModuleLoader__.load({id, factory})` CJS 壳注册 bundle。
- 产物：`lib/index.js`（host，ESM node）+ `lib/client.js`（client，browser CJS）+ `lib/types/`（声明）。

### 单包架构（host + client 同包，重要修正）

经查 DSH client module 系统源码（`packages/client/modules/src/index.ts`）确认：**client bundle 由
`dsh.client` 声明发现，且只扫描 host loader 条目**。因此第三方独立插件必须是「host + client 单包」
（client 与 host 同包声明 `dsh.client`），而非 v2 文档 §7 写的「独立 client 包」——后者只适用于第一方
monorepo（client 包被显式编入 web-app bundle）。故将 client 并入根包 `src/client/`，与 DSH-better-sidebar 一致。

- 根 `package.json`：`dsh.client`（platform web + inject）+ `dsh.bundle.patch`（`cordis.patch.yml`）+ `./client` 导出。
- `cordis.patch.yml`：`insert` 一行 `name: '@deepseek-ai/dsh-auto-continue'`，经 `dsh plugin add` 挂载。
- 源码结构：host 在 `src/`，client 在 `src/client/`；`tsdown` 打包，`tsc -p tsconfig.build.json` 出声明。

### 差异决策落地

- 差异 1（UI 槽位）：`settings.section`（id = `auto-continue`）独立设置选项卡，与「General / Models / Plugins」
  并列；本地补 `SlotMap`/`LocaleNamespaceMap` 声明。（早期曾用 `settings.plugin.item` 卡片内嵌于 Plugins 页，
  后按用户反馈改为独立选项卡，见下文「UI 修正」。）
- 差异 2（设置读写）：自建 fenced 路由 `/auto-continue/api`（`settings.get`/`settings.update`/`providers.list`），
  走 `ctx.webServer.register` + `trust-fence`（DNS-rebinding 防御），不走 DSH settings RPC allowlist；`managementKey` 密码留空不修改（replace 前从当前值回注 secret）。
- 差异 3（host 注册）：保持 `installSettingsSection` 不变。

### UI 冒烟测试（Playwright，对真实 DSH 实例）

`pnpm test:e2e`（`scripts/e2e-mount.sh`）跑真实冒烟：`pnpm build` + `pnpm pack` →
官方 `dsh plugin --profile web add file:<tarball>` → 启动真实 `dsh web`（`--port 0`）→
Playwright 无头 Chromium 渲染：

- `tests/e2e/mount.e2e.ts` 断言：① client bundle 挂载无 `pageerror`、无 `auto-continue` console 错误；
  ② 导航「Settings → Auto-continue（独立选项卡）」后 `[data-dsh-auto-continue]` 设置页可见。
- 首次运行需 `npx playwright install chromium` + `npx playwright install-deps chromium`（系统库）。
- **3 个 e2e 用例均通过**（对 DSH 0.1.1-rc.2 真实实例）。

### UI 修正（用户测试反馈后）

1. **独立设置选项卡**：早期把设置做成了 `settings.plugin.item`（keyed slot），被内嵌进
   「Settings → Plugins → Plugin configuration」内容页。改为注册 `settings.section`
   （id = `auto-continue`，order 30），在 Settings 面板获得与「General / Models / Plugins」
   并列的独立顶层选项卡；设置内容由 `locale: 'auto-continue'` 自动注入 `t` 座位。
   - 组件 `AutoContinueCard.tsx` → `AutoContinueSection.tsx`，加标题/简介文案。
   - 本地 `SlotMap` 声明从 `settings.plugin.item` 改为 `settings.section`（owner = `{ close }`）。
2. **保存报「section must be a plain object」**：client `api.ts` 的 `updateSettings` 误把
   载荷放在 `patch` 键下，而 host 路由读取的是 `section` 键，导致 `section` 恒为 undefined。
   改为发送 `{ section, expectedRevision }`；新增 `tests/client-api.spec.ts` 锁定该载荷形状
   （并覆盖 `buildInstanceEdit`/`buildInstanceDelete` 的 `managementKeyRef` 保留与解绑语义）。
3. e2e 第二条用例从「Plugins → Plugin configuration」改为直接断言独立选项卡可见。

### UI 美化（卡片列表 + 新增按钮，用户反馈后）

按用户要求对齐 DSH 官方设置页视觉（`ui-settings-plugins` 的卡片列表/展开效果 + `ui-settings-models`
的「添加提供方」按钮）：

- **卡片列表 + 展开**：`AutoContinueCard.tsx` 拆为 `AutoContinueSection.tsx`（父：标题/简介/卡片列表/
  新增按钮）+ `InstanceCard.tsx`（子：可展开卡片，标题 + 密钥/提示徽标 + 箭头，展开即编辑，页脚
  保存/放弃更改/删除）。每张卡片持有独立 `open` 与草稿状态；保存成功后父级 bump `saveNonce` 使卡片
  重挂载 → 自动收起并回种为持久化值。
- **删除确认**：弃用 `window.confirm`，改用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`。
- **新增按钮**：底部虚线「+ 新增」按钮（`1px dashed var(--dsw-alias-border-l3)`，同「添加提供方」）。
- **样式**：新增 `AutoContinueSection.module.css`，全部颜色走 `--dsw-alias-*` 设计令牌（自动适配明暗主题），
  表单字段复刻 `ValueField`/`SecretField` 的标签 + 输入框 + hint 布局；错误色用 `--dsw-alias-state-error-primary`
  （注：官方 `fields.module.css` 引用的 `--dsw-alias-label-error` 实际未定义，本插件已改用正确的 state 令牌）。
- **依赖**：client 新增 peer `@deepseek-ai/dsh-client-ui-primitives`（已列入 `CLIENT_EXTERNALS`，运行时由
  `PLATFORM_MODULES` 模块表解析）；新增 `src/client/css-modules.d.ts` 类型声明。
- **e2e**：新增第三条用例「点新增 → 填 id → 保存 → 断言卡片出现」，覆盖卡片交互与保存链路（`section` 载荷）。

---

## 黄金样本回归（v1 §1.3 / §18-8 / §18-18）

### 样本 1：健康账号的统计响应（§8.3 字段映射）

需求方提供了真实 ZenMux 统计接口响应样本（一次真实
`GET https://zenmux.ai/api/v1/management/subscription/detail` 的原始 JSON），
已逐字节保存为 `tests/fixtures/zenmux-subscription-detail.json`，并在
`tests/platforms/zenmux.spec.ts` 新增 4 个「黄金样本」回归用例：

- **§8.3 字段映射**：`data.quota_5_hour` → 窗口 `5h`、`data.quota_7_day` → 窗口 `7d`；
  `usage_percentage` / `remaining_flows` / `resets_at` 原样映射，与真实样本逐字段一致。
- **额外字段容忍**：真实响应携带 `plan` / `currency` / `base_usd_per_flow` / `account_status`
  等本插件不消费的字段，且 `quota_monthly` 只有上限、无 `usage_percentage`——映射不受影响。
- **等待目标**：真实样本两窗口均未耗尽 → `resolveWaitTarget` 取 `5h.resets_at`
  （§10.2「7d 未耗尽 → 5h resetsAt」规则）。
- **`fetchQuota` 全链路**：请求 URL（`/api/v1/management/subscription/detail`）与
  `Authorization: Bearer <key>` 请求头正确，真实响应体可归一化为快照。

### 样本 2：达到配额上限（402 条件成立）的统计响应（§5.2）

需求方提供了账号**真实达到订阅配额上限**时抓取的同一接口原始响应（`curl` 直接落盘，
`tests/fixtures/zenmux-subscription-detail-402.json`，逐字节保存），新增回归用例 5 条：

- **耗尽判定**：真实样本 `quota_5_hour` 为 `usage_percentage=1`、`remaining_flows=0` → 已耗尽；
  `quota_7_day`（`0.4752` / `111.78`）未耗尽。此前的样本账号额度健康，**从未覆盖耗尽分支**。
- **等待目标**：7d 未满 → 取 5h `resets_at`（`2026-09-12T11:02:38Z`）。样本里这个时刻恰好**晚于**
  7d 的 `resets_at`（`08:48:40Z`），所以该样本本身无法区分「取 5h」与「取 max(5h, 7d)」；
  用例把真实数据上的等待目标钉死为 5h 的重置时刻，`max` 语义的区分仍由 §5.2 的规则用例
  （7d 满 / 5h 未满 → 7d）负责。
- **决策链**：真实快照经 `decideWaitAction` 得到 `waiting-reset`，目标 = `5h resets_at + resetBufferMs`。
- **字段映射 / `fetchQuota` 全链路**：与样本 1 同款断言（URL 与 `Authorization: Bearer` 请求头正确）。
- **端到端**：`tests/integration.spec.ts` 另加 1 条「真实 402 文案 + 真实耗尽统计 → 等到 5h 重置后
  `{kind:'retry'}`」，把识别、查询、等待决策串起来跑一遍（fake timers）。

### 样本 3：真实 402 错误响应（§9.3 识别规则 / §18-18）

需求方提供了**线上抓取的真实 402 错误响应体**（`quote_exceeded`，尾部带
` (request_id: 31ee1011fc2e41188c272af95b69311f)`），已逐字节保存为
`tests/fixtures/zenmux-402-quote-exceeded.json`；余额类两型（`insufficient_credit` /
`reject_no_credit`）暂无线上样本，响应体逐字取自 ZenMux 官方错误码参考
（<https://zenmux.ai/docs/guide/advanced/error-codes>）。响应体与压平形态集中在
`tests/platforms/zenmux-402-sample.ts`，供平台与集成用例共用；核对要点（新增回归用例 6 条）：

- **样本自校验**：真实响应体的 `code` / `type` / `message`（含 request_id 后缀）逐字段断言。
- **`quote_exceeded` 命中**：原始字节（含结尾换行）、JSON 原样、`dsh-llm-pi-ai`
  `formatProviderError` 压平后的 `402: {json}`、以及 SDK 已把 body 折进 `error.message` 的
  `402 <message>` 都命中；`failure.status` 缺失（真实链路里 pi-ai 的 failure 只有
  `message`/`code`）同样命中。**压平形态已用真实 `dsh-llm-pi-ai` 的
  `normalizeProviderError` / `formatProviderError` 实测复现**，确认线上 402 的
  `failure.message` 就是 `402: {json}`。
- **命中裸 message**：不带 JSON 包裹的官方文案也命中。
- **尾部 `request_id` 不影响识别**：去掉 ` (request_id: …)` 后仍命中。
- **余额类 402 不命中**：`insufficient_credit` / `reject_no_credit` 两型在多种形态下均判为不处理
  （注意 pi-ai 自己会把 `insufficient_credit` 也归类为 `QUOTA`，本插件不依赖 `failure.code`，
  因此不会被带偏）。
- **只认语义不认外壳**：三型 402 的 JSON 外壳相同（`{"error":{"code":"402",...}}`），
  仅凭 `code=402` 不足以判定。
- **结论**：既有识别规则（`quote_exceeded` 子串、`subscription quota limit/exhausted`、
  `reached your subscription quota limit`、`"type":"quote_exceeded"`）**无需修订**即覆盖线上文案。

### 结论与剩余

- ✅ §8.3 统计字段映射已用真实样本核对通过（§18-8「样本到位后必须通过」→ 已通过）。
- ✅ §9.3 的 402 识别规则已用**线上抓取的真实 402 响应体** + 真实耗尽统计核对通过（§18-18 → 已通过）。
- ✅ 无残留：此前「缺逐字节 402 HTTP 响应体」的缺口已由 `chat_402.bin` 补齐并逐字节入库。

验证：`pnpm typecheck` ✅、`pnpm test` → **9 个测试文件、120 个用例全部通过** ✅。

---

## DSH 0.1.5-rc.2 升级迁移

> 依据 `doc/记录/DSH-0.1.5-升级影响评估.md`（含逐条证据与实证结果）。
> 目标版本：DSH `0.1.5-rc.2`（npm dist-tag `next`，当时的**最新已发布**版本）。

### 迁移内容

| 项 | 改动 |
|---|---|
| host settings 接入 | `installSettingsSection(ctx, ns, …)` → `ctx.inject(['settings'], sctx => sctx.settings.installSection(ctx, 'auto-continue', …))`；`settingsNamespace('auto-continue')` → 字面量 `'auto-continue' as const`（0.1.5 删除了这两个导出，且 `installSection` 在 0.1.1 中不存在，无兼容写法） |
| client 上下文 | `import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'` → `import type { Context as ClientContext } from '@deepseek-ai/cordis'` + `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'`（后者提供 `ctx.slots` 声明；`dsh-client-runtime` 整包被删除） |
| 依赖 | 全部 DSH 包 `0.1.1-rc.2` → `0.1.5-rc.2`；`cordis` `4.0.1` → `4.0.2`；peer 区间 `^0.1.0-rc.8` → `^0.1.5-rc.2`；移除 `dsh-client-runtime`，新增 `dsh-client-ui-renderer` |
| `dsh-settings` 依赖类型 | 迁移后 host 不再 value-import `dsh-settings`（只剩 `import type {}` 声明合并），从 `dependencies` 移到 `devDependencies` |
| manifest | `dsh.client.inject` → `["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"]`；新增 `engines.dsh: "^0.1.5-rc.1"` |
| 构建 | `tsdown.config.ts` 的 `CLIENT_EXTERNALS` 对齐 0.1.5 baseline（`'cordis'` → `'@deepseek-ai/cordis'`，移除 `dsh-client-runtime/client`，补 `dsh-client-store` / `dsh-client-ui-dockkit`） |
| trust-fence | 同步官方 0.1.5：Origin 比较由 `.hostname` 收紧为 `.host`（端口必须一致），`"null"` opaque origin 经解析失败被拒 |
| 测试 | 两个 spec 移除 `settingsNamespace` 用法；`waitForNamespace` 形参 `SettingsNamespace` → `string` |
| `pnpm-workspace.yaml` | pnpm 在安装新 rc 依赖时自动追加 `minimumReleaseAgeExclude`（20 个 `@deepseek-ai/*@0.1.5-rc.2`）——这是 pnpm 供应链「最短发布年龄」策略要求的豁免，**必须保留**，否则 `pnpm install` 会被 rc 版本的新鲜度拦截 |

**业务逻辑零改动**：`config.ts` / `state.ts` / `platform.ts` / `platforms/zenmux.ts` / `recovery.ts` /
`notice.ts` / `wire.ts` 及 client 其余文件均未改。

### 关键决策

- **不追求双版本兼容**：`installSection` 在 0.1.1 中不存在，`installSettingsSection` 在 0.1.5 中被硬删除，
  两者无交集，因此直接迁移而非做兼容 shim。
- **升级到最新已发布版本**：npm 上 `0.1.5-rc.2` 为最新（`next` 标签），仓库 HEAD 虽领先 139 个 commit
  但版本号相同、无对应发布物，故以 `0.1.5-rc.2` 为准。
- **同步 trust-fence**：该文件是从 DSH 复刻的，保持与官方一致比保持旧行为更安全。

### 升级后验证

- `pnpm typecheck` ✅（升级前对着 0.1.5 有 7 个错误，迁移后 0 错误）
- `pnpm test` ✅ **7 个测试文件、75 个用例全部通过**
- `pnpm build` ✅ host `lib/index.js` + client `lib/client.js`；client bundle 仅 require
  `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`（均在 0.1.5 `PLATFORM_MODULES` 内）
- 真实 `dsh web` 挂载 ✅：`pnpm test:e2e`（`scripts/e2e-mount.sh`）全流程通过——
  `pnpm build` + `pnpm pack` → `dsh plugin --profile web add file:<tarball>` 注册进
  `dsh.profile.bundles` → 启动真实 `dsh web --port 0` → Playwright 无头 Chromium 断言：
  ① client bundle 挂载无 `pageerror`；② Settings →「自动续跑」独立选项卡可见；
  ③ 点「新增」→ 填 id → 保存 → 卡片出现（覆盖 `/auto-continue/api` 的新 settings 写入链路）。
  另外 HTTP 拉取首页确认 `__DSH_BOOT__` 引导图包含 `@deepseek-ai/dsh-auto-continue/client.js`。
  > 运行前提：`npx playwright install chromium` + `npx playwright install-deps chromium`
  > （后者需 root；本机已装）。裸机/沙箱下如 `~/.cache` 不可写，用
  > `PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers` 安装并运行。

### 未覆盖

- （已消除）真实 402 识别规则核对：见「黄金样本回归」样本 2/3，现已完成且无残留
  （真实 402 响应体已逐字节入库）。

---

## 平台适配器扩展性审查（2026-09-11）

用户提问：是否实现了针对不同 Platform 的接口，新接入一个 Platform 是否只需实现几个固定方法。

- 产出 `doc/记录/平台适配器扩展性审查.md`；方法为静态审查 + **5 个实测探针**（临时 spec，跑完已删除，
  未改动测试基线：仍是 7 文件 / 75 用例）。
- **结论（已实证）**：
  - ✅ 「恢复状态机平台无关」成立——只实现接口 3 方法的最小 `acme` 适配器，经
    `registerPlatformAdapter`（甚至由独立插件 `ctx.inject(['quota'])` 注册）即可跑通
    「402 → 查统计 → 等待 → `{kind:'retry'}`」全链路，核心文件零改动。
  - ❌ 「只需实现几个固定方法即可接入」不成立，差 4 处：P0-1 全局唯一 `platformBaseURL`
    （两个平台无法各持端点）、P0-2 base 层校验早于注册（`cordis.yml` 无法声明新平台）、
    P0-3 client 下拉与文案硬编码 zenmux 且无 `platforms.list`、P1-1 `fetchQuota` 拿不到实例配置
    （平台专属参数无通路）。
- **文档偏差**：旧 v1 §19.2 / README「未来扩展点」/ AGENTS.md §1 的「只需实现并注册」属过度承诺；
  旧 v2 §2.1「platform URL 由平台模板决定」与实现不符。审查当时给出改写建议；**随后在 v3 改造中
  已一并修正**（见本文件「平台模板一等化（v3）」与「文档重组」两节）。
- **决策**：本次只审查、只落文档，不动接口与 UI；§7 的 6 项改造（baseURL 下沉、接口扩容、
  注册时机、`platforms.list`、契约测试、未知字段 fail loud）待用户确认后再实施。

---

## 平台模板一等化（v3，2026-09-11）

用户确认按审查报告 §7 的目标实施：**让「新增一个平台 = 实现 PlatformQuotaAdapter + 注册」
真正成立，但不接入任何具体新提供商。**

### 改了什么

| 改造项 | 落地内容 |
|---|---|
| 接口扩容（`platform.ts`） | 适配器新增可选元数据 `label`（UI 展示名）、`defaultBaseURL`（默认端点）、`optionsSchema`（平台专属参数校验）、`isExhausted`（覆盖通用耗尽口径）；`fetchQuota(credential, baseURL, signal)` 改为 `fetchQuota(context)`，context 携带 `credential` / `baseURL` / `instance` / `signal` |
| 端点归属 | 新增实例级 `baseURL`；全局 `platformBaseURL` 默认值改为 `''`（legacy 覆盖）。解析优先级：`instance.baseURL` → 全局非空值 → `adapter.defaultBaseURL`；都拿不到则告警并 `next()`。**多平台因此可并存** |
| 平台专属参数 | 实例新增 `options`（schema `dict(any)`，默认 `{}`），经 `validateConfig` 的 `validateOptions` 钩子交给适配器 `optionsSchema` 校验（fail loud） |
| 注册时机 | 构造期对未知平台类型**只告警**（`deferUnknownPlatforms`），因为平台适配器可能由稍后加载的插件注册、base 层需要能提前声明；settings 写入路径仍严格抛错 |
| 注册入口 | `registerPlatformAdapter` 明确为第三方入口（独立插件 `ctx.inject(['quota'], c => c.quota.registerPlatformAdapter(adapter))`，实测零核心改动）；新增 `ctx.quota.platforms()` 返回 `{id,label}[]` |
| UI 数据驱动 | 新增 `/auto-continue/api/platforms.list`；client 平台下拉改为渲染该列表（不再写死 `zenmux`），新增「平台端点（可选）」与「平台专属参数（JSON）」字段，密钥提示文案去掉 ZenMux 字样 |
| 内置平台清单 | 新增 `src/platforms/index.ts` 的 `builtinPlatformAdapters()`；`index.ts` 不再硬编码 `adapters.set('zenmux', ...)` |
| 契约回归 | 新增 `tests/platforms/contract.spec.ts`（8 用例），用非内置平台 `demo` 钉死上述全部承诺 |

### 有意为之的行为变更（破坏性）

1. **实例 `type` 必填**：schema 去掉 `default('zenmux')`。此前省略 `type` 会静默变成 zenmux；
   现在 schema 直接报错（`type missing required value`）。UI 始终写入 `type`，v1/v2 文档示例也都有。
2. **全局 `platformBaseURL` 默认值 `'https://zenmux.ai'` → `''`**：zenmux 官方地址移入
   `ZenMuxAdapter.defaultBaseURL`。既有用户若未显式设置该字段，行为**不变**（仍请求 zenmux.ai）；
   若显式设置过，仍按 legacy 全局覆盖生效（且与适配器默认不一致时打一条 warn）。
3. **移除导出常量** `DEFAULT_PLATFORM` / `DEFAULT_PLATFORM_BASE_URL`（平台知识不再留在 `config.ts`）。

### 验证

- `pnpm typecheck` ✅ 0 错误
- `pnpm test` ✅ **9 个文件 / 108 用例**（原 7 文件 / 75 用例；新增 contract 8 例 + config/api/client-api/zenmux 若干）
- `pnpm build` ✅ host `lib/index.js` + client `lib/client.js`（purity gate 无报错）
- `pnpm test:e2e` ✅ 3/3（真实 `dsh web`：bundle 挂载、设置独立选项卡、新增实例保存）
  > 本次 e2e 曾因 Playwright 浏览器缺失（`chromium_headless_shell-1234` 不在默认 cache）失败，
  > 用 `npx playwright install chromium` 装好即可；与代码改动无关。

### 未做（明确留在范围外）

- 不接入任何具体新平台（按要求）；`demo` 仅存在于测试中。
- UI 不渲染适配器 `optionsSchema` 的结构化表单，平台专属参数用通用 JSON 输入框编辑。
- `platforms.list` 不下发 `defaultBaseURL`（UI 用「留空即默认」表达，不需要知道具体值）。

### 文档同步

- **新增 `doc/设计文档/平台模板设计约束.md`**：**版本无关的设计约束文档**（运行目标；模板 / 实例 /
  Provider 的关系；接入新平台的两条硬性要求——不影响其他代码、用接口契约保证规范与隔离；
  10 条可验收不变量）。只写设计要求与思想，不写接口签名/字段/文件位置等会随版本变化的内容；
  已登记进 `AGENTS.md` §2 的文档优先级列表。
- `README.md`：三层模型、新增平台教程、配置字段表（`type` 必填 / `baseURL` / `options` /
  `platformBaseURL` 语义）、适配器接口、服务与扩展点。
- `AGENTS.md`：§1 平台一等化、§4 目录（`platforms/index.ts`、contract 测试）、§5 端点解析优先级与
  校验强度差异、§6 铁律 6/7 与自检项、§8 基线 8 文件 / 95 用例。
- 需求文档（旧 v1 / v2 补充）：接口、元信息、全局字段与 `type` 必填等已更新；
  **这两份文档随后已合并为 `doc/需求文档/需求文档.md`，技术内容拆入 `doc/设计文档/`**。
- `doc/记录/平台适配器扩展性审查.md`：补「落地状态」，§5 各缺口标注已解。

---

## 文档重组（2026-09-11）

用户要求整理 `doc/`：按用途分类，并把「需求」与「需求衍生出的技术配置」拆开。

### 目录结构

```
doc/
  需求文档/需求文档.md            # 唯一需求规格（合并原 v1 + v2 补充）
  设计文档/
    平台模板设计约束.md           # 版本无关的设计要求与思想（不变量）
    架构与集成设计.md             # 包/模块/服务/事件/集成点
    平台适配器设计.md             # 接口契约、统一快照、ZenMux 规格、注册与校验时机
    恢复流程设计.md               # 状态机、退避与等待、关键流程、提示、限制
    配置与设置设计.md             # 字段与默认值、校验、凭据、设置通道、界面、变更语义
  参考文档/DSH插件开发背景知识.md
  记录/DSH-0.1.5-升级影响评估.md
  记录/平台适配器扩展性审查.md
```

### 关键决策

1. **需求与技术分离**：需求文档只保留「做什么、为什么、怎样算做到」（目标、FR/NFR、角色关系、
   验收标准）与一张「需求 → 设计」对照表；配置字段表、接口签名、状态机、参数取值全部移入设计文档。
   此前 v2 补充文档把详细配置要求（§3.1）混在需求里，是本次整理的直接动因。
2. **合并两份需求文档**：原 v1 文档与原 v2 补充文档合并为一份 `需求文档.md`；冲突处以 v2/v3 为准。
   旧章节号不再有效，文档内提供**旧号 → 新位置**的对照表（§9.2），以便 `PROGRESS.md` 与
   `doc/记录/` 中的历史引用仍可追溯。
3. **设计文档分层**：`平台模板设计约束.md` 是**版本无关的思想/约束**层（不写接口签名与字段）；
   其余四份是**当前技术设计**层，允许随版本变化。改接口先看约束层，再看适配器设计。
4. **非需求/设计文档归入两类**：框架背景知识属长期参考 → `参考文档/`；升级影响评估与扩展性审查
   属一次性结论 → `记录/`。
5. 全仓库交叉引用同步更新：`AGENTS.md` §2 文档优先级列表重写为四类九篇；`README.md`、
   `PROGRESS.md`、两份记录文档、参考文档中的旧路径与旧章节引用一并修正。

> 本次仅文档整理，未改动任何源码与测试；测试基线仍为 9 文件 / 108 用例。

---

## resumeNotice 与 system/message 调查（2026-09-11）

立项事项：「把 `resumeNotice` 从 user 角色升级为 `system/message`」（需求 §8 未来预留项）。

**调查方法**：读 DSH 源码（`dsh-agent-loop` 的系统提示词投影、`dsh-session` 的 surface 校验、
`dsh-llm` 的消息工厂、一方插件 `agent-instructions` / `tool-skill` 的注入方式）+ 全仓检索
`systemPromptUpdate` 声明方。

**结论：不做。`system/message` 是「渲染后的系统提示词」槽位，不是插件通知通道。**

1. `SystemPromptProjection.project()`（`packages/core/agent-loop/src/runtime-context.ts`）把**所有**
   存活的 `system/message` 节点纳入管理；当路由不支持 in-history 更新、新系列开始或渲染为空时，
   会把所有非首节点 `replace(seq, '')` **置空**（置空节点不产生 wire message）。
2. `inHistory` 取决于路由是否声明 `systemPromptUpdate: 'in-history'`；0.1.5 中**只有 `llm-deepseek`
   声明**，ZenMux 走的 `llm-pi-ai` 没有 → 我们的通知会被静默置空，**在目标平台上根本到不了模型**。
3. 框架给插件注入合成上下文的公开入口是 user 角色（`Agent.inject(input: UserMessage)`）；一方插件
   （AGENTS.md / 文件变更通知 / 技能内容）都用 **user 角色 + 调用方自带的 `<system-reminder>` 包裹**。
4. 客户端轨迹界面会把追加的 `system/message` 显示为「系统提示词已更新」，语义不符。

**决策**：保持现状——`user/message` + `plugin` 来源（`source.kind === 'plugin'`），**代码零改动**；
若将来需要更强的「系统级」观感，正确做法是把说明包进 `<system-reminder>`（与一方插件一致），
而不是借用 `system/message`。

**文档同步**：`doc/设计文档/恢复流程设计.md` 新增 §6.1（完整依据）、需求 §3 非目标与 §8 未来预留
改为「已调查，结论为不采用」、`AGENTS.md` 铁律 4 改为「不要改用 `system/message`」、
`README.md` 限制与未来扩展点同步、`doc/参考文档/DSH插件开发背景知识.md` 更新该条表述、
`doc/记录/DSH-0.1.5-升级影响评估.md` 增补 §6.1 并修正原「技术前提已具备」的判断。

> 本次仅文档与结论变更，未改动源码与测试；测试基线仍为 9 文件 / 108 用例。
