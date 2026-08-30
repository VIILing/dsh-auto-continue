# 开发进度：@deepseek-ai/dsh-auto-continue

> 本文件记录 `@deepseek-ai/dsh-auto-continue` 插件的任务规划与实现进度。
> 关联文档：`doc/DSH插件开发背景知识.md`、`doc/dsh-auto-continue-需求文档.md`、
> `doc/dsh-auto-continue-需求文档-v2-补充.md`。

## 当前状态

**v1 + v2 全部完成并验证通过。** 单包（host + client）独立仓库，含三层模型、
instance 键控状态机、`installSettingsSection` + 自建 `/auto-continue/api` 路由、
浏览器侧 `settings.plugin.item` 卡片。验证：`pnpm typecheck` ✅、`pnpm build` ✅、
`pnpm test`（68 用例）✅、`pnpm test:e2e`（2 用例，对真实 `dsh web`）✅。

## 任务列表与进度

图例：`[x]` 已完成，`[~]` 进行中，`[ ]` 待办。

| # | 任务 | 状态 | 说明 |
|---|---|---|---|
| 0 | 阅读技术文档与需求文档 | [x] | 已阅读 `doc/DSH插件开发背景知识.md` 与 `doc/dsh-auto-continue-需求文档.md` |
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
│   ├── DSH插件开发背景知识.md
│   ├── dsh-auto-continue-需求文档.md
│   └── dsh-auto-continue-需求文档-v2-补充.md
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
│   └── client/             # 浏览器侧卡片（settings.plugin.item）
│       ├── index.tsx       #   入口：inject + slot 注册
│       ├── AutoContinueCard.tsx
│       ├── api.ts          #   自建路由 fetch + 编辑/解绑纯函数
│       └── locales.ts      #   zh/en
└── tests/
    ├── config.spec.ts
    ├── settings.spec.ts
    ├── api.spec.ts
    ├── platforms/zenmux.spec.ts
    ├── recovery.spec.ts
    └── integration.spec.ts
```

---

## v2 补充（instance 三层模型 + 设置 UI）

> 依据 `doc/dsh-auto-continue-需求文档-v2-补充.md`。v2 与 v1 冲突处以 v2 为准。

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
| V10 | Playwright UI 冒烟 + 文档收尾 | [x] | `tests/e2e/`（2 用例）+ `scripts/e2e-mount.sh`；本文件与 README 最终核对 |

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
- 单元/集成测试：`pnpm test`（`vitest run`）→ **6 个测试文件、68 个用例全部通过** ✅
- settings 变更语义：内存版 `SettingsProvider` + `installSettingsSection` 集成验证（新增实例/绑定、解绑、删除实例后 in-flight 等待不中断、跨字段校验拒绝写入）✅
- UI 冒烟：`pnpm test:e2e`（Playwright 对真实 `dsh web`）→ **2 个用例全部通过** ✅

### 依赖清单（v2 新增）

- host runtime 新增：`@deepseek-ai/dsh-settings`（`installSettingsSection` / `settingsNamespace`）、`@deepseek-ai/dsh-host-webserver`（`ctx.webServer.register` 自建路由）。
- client 新增：`@deepseek-ai/dsh-client-runtime`、`dsh-client-ui-slots`、`dsh-client-locale` + `react`/`react-dom` + `tsdown`/`lightningcss`（构建期）。

### 独立仓库构建 client UI（已实现，推翻此前 blocked 结论）

参照 `DSH-better-sidebar`（/home/ubuntu/DSH-better-sidebar），在**独立仓库内本地复刻（vendor 逻辑）**
了 monorepo 的 `clientBundle()` 预设，无需依赖 monorepo 源码：

- 根 `tsdown.config.ts` 本地实现 `clientBundle` / `purityGatePlugin` / `makeCssPlugin` / `injectTag`，
  硬编码 `CLIENT_EXTERNALS`（react/cordis/`@deepseek-ai/dsh-client-ui-slots`/`dsh-client-runtime/client` 等）与 `INLINE_SAFE` 正则，
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

- 差异 1（UI 槽位）：`settings.plugin.item` 卡片（key = `auto-continue`），轻量 UI；本地补 `SlotMap`/`LocaleNamespaceMap` 声明。
- 差异 2（设置读写）：自建 fenced 路由 `/auto-continue/api`（`settings.get`/`settings.update`/`providers.list`），
  走 `ctx.webServer.register` + `trust-fence`（DNS-rebinding 防御），不走 DSH settings RPC allowlist；`managementKey` 密码留空不修改（replace 前从当前值回注 secret）。
- 差异 3（host 注册）：保持 `installSettingsSection` 不变。

### UI 冒烟测试（Playwright，对真实 DSH 实例）

`pnpm test:e2e`（`scripts/e2e-mount.sh`）跑真实冒烟：`pnpm build` + `pnpm pack` →
官方 `dsh plugin --profile web add file:<tarball>` → 启动真实 `dsh web`（`--port 0`）→
Playwright 无头 Chromium 渲染：

- `tests/e2e/mount.e2e.ts` 断言：① client bundle 挂载无 `pageerror`、无 `auto-continue` console 错误；
  ② 导航「Settings → Plugins → Plugin configuration」后 `[data-dsh-auto-continue]` 卡片可见。
- 首次运行需 `npx playwright install chromium` + `npx playwright install-deps chromium`（系统库）。
- **2 个 e2e 用例均通过**（对 DSH 0.1.1-rc.2 真实实例）。
