# DSH 0.1.5-rc.2 升级对 `@deepseek-ai/dsh-auto-continue` 的影响评估

> 评估日期：2026-09-11
> 插件基线：`package.json` 锁定 DSH `0.1.1-rc.2`
> 目标 DSH：`/home/ubuntu/deepseek-harness`，`0.1.5-rc.2`（`git describe` = `dsh-v0.1.5-rc.2-139-gc291e7961a`，master）
> 方法：`git diff dsh-v0.1.1-rc.2 HEAD` 源码核对 + 已发布 d.ts 核对 + scratch 副本实测（`typecheck` / `test` / `build`）
> 结论状态：**已实证**（非纯静态推断），实证细节见 §4

---

## 1. 结论摘要

两个版本之间相差 **3225 个 commit**（0.1.1-rc.2 → 0.1.5-rc.2），但插件依赖的公开 API 只有 **2 处硬破坏**，
均为 import 级、不涉及业务逻辑：

| 级别 | 破坏点 | 影响 |
|---|---|---|
| **P0-1** | `@deepseek-ai/dsh-settings` 删除 `installSettingsSection()` / `settingsNamespace()` | host 半体装载期 ESM 解析失败 → 整个插件无法加载 |
| **P0-2** | `@deepseek-ai/dsh-client-runtime` 包被删除 | client 半体 `ClientContext` 类型导入失效（运行时被擦除，升级依赖后 typecheck 失败）、`dsh.client.inject` 指向不存在的包 |
| **P1-1** | 插件把 DSH 包精确锁在 `0.1.1-rc.2` | 现有 semver 区间（`^0.1.0-rc.8` / `0.1.1-rc.2`）**覆盖不到** `0.1.5-rc.2`；不升级则 typecheck 对着旧 d.ts「假绿」 |
| **P1-2** | `dsh.client.inject` 仍列已删除的 runtime | informational 字段，不会崩，但依赖边语义错误 |

**其余全部集成面兼容**：`agent/request-error` 事件与 `RequestErrorAction`、`session/event` 监听、
`LlmFailure` / `createUserMessage` / `UserMessage` / `session.append(..., {surfaceOp:'append'})`、
`ctx.credentials.resolve`、`ctx.webServer.register`、`ctx.webRuntime.trustedHosts`、
`launchEnvironmentOf`、client 侧 `settings.section` slot / `Modal` / 图标 / `TranslateNS` / locale —
形状与语义均未变。

**迁移成本很小**：host 2 处、client 2 处、测试 2 个文件、`package.json` 版本号。
已在 scratch 副本完成并实测通过（§4）。

---

## 2. 破坏性 / 需处理项

### P0-1 `installSettingsSection` / `settingsNamespace` 被硬删除

- **变化**：0.1.1-rc.2 的自由函数 `installSettingsSection(ctx, ns, schema, entry, hooks)` 与品牌工厂
  `settingsNamespace(value)` 在 0.1.5-rc.2 中**整个仓库零命中**，被替换为
  `SettingsProvider.installSection(owner, ns, schema, entry, hooks)` 方法；`ns` 改为字面量类型
  （`Namespace & SettingsNamespaceInput<Namespace>`，内部 `parseSettingsNamespace` 运行时校验）。
- **证据**：
  - 基线 `packages/settings/settings/src/index.ts:863`（`installSettingsSection`）、`:26`（`settingsNamespace`）
  - 现状 `packages/settings/settings/src/index.ts:472`（`installSection`）、`:30-43`（`SettingsNamespaceInput` / `parseSettingsNamespace`）
  - 已发布 `@deepseek-ai/dsh-settings@0.1.5-rc.2` 的 `lib/types/index.d.ts` 亦只有 `installSection`（无旧符号）
  - 移除 commit：`f4e49ccf8f refactor(services): move shared values behind service APIs`
- **关键**：`installSection` 在 0.1.1-rc.2 中**根本不存在**，因此不存在同时兼容两版的写法，必须迁移。
- **影响**：`src/index.ts:8` 是 **value import**；对 0.1.5 host 解析为不存在的命名导出 →
  ESM `SyntaxError: does not provide an export named 'installSettingsSection'`，**插件装载期直接失败**
  （不是降级，是整个 host 半体与 client 半体都不挂载）。`SETTINGS_NAMESPACE = settingsNamespace(...)`
  同样报错。
- **修复**（官方同款，见 `packages/llm/llm-deepseek/src/index.ts:506-513`）：

```ts
import type {} from '@deepseek-ai/dsh-settings'          // 仅为 Context.settings 声明合并

const SETTINGS_NAMESPACE = 'auto-continue' as const

// 原先 installSettingsSection 内部自带 ctx.inject(['settings'])，现在这层 wrapper 必须自己写
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => { this.currentConfig = source },
    onChange: () => { this.reconcileInstances() },
    validate: (value) => validateConfig(value, this.platformNames()),
  })
})
```

> 附带收益：迁移后 host bundle **不再在运行时 import `dsh-settings`**（实测 `lib/index.js` 的
> import 只剩 `@deepseek-ai/cordis` / `dsh-launch-environment` / `dsh-llm` / `schemastery`），
> 因此 `dsh-settings` 可以降为 type-only 依赖，P1-1 里担心的运行时版本偏斜问题随之消失。

### P0-2 `@deepseek-ai/dsh-client-runtime` 包被删除

- **变化**：0.1.5-rc.2 的 `packages/client/` 下不再有 `runtime` 目录；client 包现为
  `connection` / `modules` / `store` / `resources` / `locale` / `ui-*`。浏览器侧 Context 不再由专用包声明，
  而是直接用 cordis 的 `Context`。
- **证据**：
  - npm：`@deepseek-ai/dsh-client-runtime` 的 dist-tags 只到 `next: 0.1.1-rc.2`，**没有 0.1.5 版本**
  - 仓库：`packages/client/` 无 `runtime`；删除提交 `be531688f3 refactor(client): migrate consumers and remove Runtime`；
    全仓库 `grep dsh-client-runtime` 仅命中归档笔记与诊断清单，**没有任何兼容 shim**
  - 官方指南 `docs/cookbook/adding-a-settings-card.zh.md:53` 明确写
    `import type { Context as ClientContext } from '@deepseek-ai/cordis'`
- **影响**：
  - `src/client/index.tsx:11` 的 `import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'`
    在依赖升到 0.1.5 后 typecheck 报 `TS2307: Cannot find module`。
  - **运行时影响较小**：该导入是 `import type`，打包时被擦除 —— 实测 `lib/client.js` 的 external
    requires 只有 `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`，**零处**
    引用 `dsh-client-runtime`。所以当前用 0.1.1 依赖构建出的 client bundle 在 0.1.5 上仍能加载。
  - `package.json` 的 `dsh.client.inject: ['@deepseek-ai/dsh-client-runtime', ...]` 是**陈旧声明**
    （该字段在新版是 informational，不会硬失败，但已无意义）。
  - 连带：换成裸 cordis `Context` 后，`ctx.slots` 的类型声明不再随 `ClientContext` 带入，
    需要显式引入声明方。
- **修复**：

```ts
// src/client/index.tsx
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'  // 提供 Context.slots 声明
import type {} from '@deepseek-ai/dsh-client-locale/client'       // 提供 Context.locale 声明（原有）
```

```jsonc
// package.json
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"]
  }
}
```
- 依据：`Context.slots` 由 `@deepseek-ai/dsh-client-ui-renderer/client` 声明
  （`packages/client/ui-renderer/src/client/index.ts:42-47`）；官方 `ui-theme` 的 client 半体正是用
  `import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'`（`packages/client/ui-theme/src/client/index.ts:18`）。
- 新增依赖：`@deepseek-ai/dsh-client-ui-renderer@0.1.5-rc.2`（type/dev；运行时由 host web bundle 提供 service）。

### P1-1 依赖版本区间与 0.1.5-rc.2 不兼容（semver prerelease 规则）

- **现状**：`package.json` 把 `dsh-launch-environment` / `dsh-llm` / `dsh-settings` 精确锁在
  `0.1.1-rc.2`（dependencies），client 侧 peer 用 `^0.1.0-rc.8`，`cordis` 用 `4.0.1` / `^4.0.0`。
- **实测**：npm semver 下 `satisfies('0.1.5-rc.2', '^0.1.0-rc.8') === false`，
  `satisfies('0.1.5-rc.2', '^0.1.1-rc.2') === false`（跨 prerelease tuple 不匹配）。
  即**现有区间根本覆盖不到 0.1.5-rc.2**，不是「可升可不升」，而是「必须改」。
- **风险**：不改则 `pnpm typecheck` 永远对着 0.1.1 d.ts 通过（假绿），部署时按 host 的 0.1.5 走；
  profile 用 `nodeLinker: hoisted` + `autoInstallPeers: false`，hoist 竞争结果不确定。
- **建议**：全部升到 `0.1.5-rc.2`（npm dist-tag `next`），peer 改 `^0.1.5-rc.2`，
  `cordis` 升到 `4.0.2`（`^4.0.0` 区间本身仍然有效，可不动）。
  迁移后 `dsh-settings` 可移到 `devDependencies`（type-only）。

### P1-2 `dsh.client.inject` 指向已删除的包

- **证据**：该字段在新版被明确定义为 *"Informational package-name dependencies, not Cordis service injection"*
  （`packages/util/package-manifest/src/types.ts:69-82`）；解析器 `packages/client/modules/src/client/manifest.ts:157-176`；
  唯一运行时用途是 graph 行预到达（`packages/client/modules/src/client/system.ts:165-168`），**查不到对应行时静默跳过**。
- **影响**：不会导致启动失败，但依赖边错误、语义陈旧。
- **建议**：`"inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-locale"]`
  （若采纳 P2-1 改用官方 slot 声明，则加 `@deepseek-ai/dsh-client-ui-settings`）。

### P2 观察点（对当前插件无影响，但值得记录）

| 变化 | 证据 | 为何无影响 |
|---|---|---|
| `SurfaceOp.replace` 字段 `start/end` → `startSeq/endSeq`；Session 日志格式升到 V3 | `packages/core/session/src/types.ts:436` vs tag `:378` | 插件只用 `surfaceOp:'append'`（`src/index.ts:356`），append 语义未变 |
| `assistant/message` data 新增必填 `stream` | `packages/core/session/src/types.ts:321-328` | 插件只读 `interrupted` / `message.source.*`，不生产该事件 |
| `SurfaceEventType` **新增 `'system/message'`** | `packages/core/session/src/types.ts:412-414` | 纯增量；但**推翻了本仓库 AGENTS.md 铁律 4**（详见 §6） |
| `LlmRuntime` 基类 `Service` → `TypertRemoteService`，`listProviders` 加 `@Remote` | `packages/llm/llm/src/index.ts:333,468` | `TypertRemoteService extends Service`，调用与返回类型不变 |
| `ctx.llm.listProviders()` 返回 `LlmProviderInfo`（插件中为未使用的 import） | `packages/llm/llm/src/index.ts:469` | 行为不变；可顺手清理死 import |
| client 纯净度门禁新增 `dsh.client.external` 声明字段 | `packages/util/package-manifest/src/types.ts:78-83` | 插件 client 只值导入 `ui-primitives`（baseline）与 react，无需 `external` |
| `settings` 描述符新增 `secrets` 侧车 / `base` / `user` 字段 | `packages/settings/settings/src/index.ts:519-536` | 插件继续用 `describe({redactSecrets})`，`{ns,value,revision}` 仍在 |
| **`tsdown.config.ts` 的 `CLIENT_EXTERNALS` 与新版 baseline 漂移** | 新版 baseline `packages/client/web/src/platform.ts:8-14`；插件 `tsdown.config.ts:25-34` | 当前无实际症状（那些 specifier 都没有 value import，不生成 `require`）；但 `'cordis'` 少了 `@deepseek-ai/` 前缀、仍留着已删除的 `@deepseek-ai/dsh-client-runtime/client`、缺 `dsh-client-store` / `dsh-client-ui-dockkit` —— **一旦将来新增 cordis value import 就会运行时报错**，建议顺手对齐 |
| `Modal.closeLabel` 由可选变必需（非 headless 分支） | `packages/client/ui-primitives/src/Modal.tsx:8-21` | 插件 `InstanceCard.tsx:373-380` 已传 `closeLabel`，无影响 |
| 插件本地重述的 `settings.section` SlotMap 变为冗余 | 官方声明 `packages/client/ui-settings/src/client/contract/slots.ts:54,123-126` | 形状一致，重复成员不报错；可选改为 `import type {} from '@deepseek-ai/dsh-client-ui-settings/client'` 并删本地重述 |

---

## 3. 已确认兼容的集成面（逐条核对）

| 集成面 | 插件用法 | 结论 |
|---|---|---|
| `agent/request-error` waterfall | `ctx.on('agent/request-error', fn, {prepend:true})`，读 `agent/provider/failure/signal`，返回 `{kind:'retry'}` | ✅ payload 与 `RequestErrorAction` 与 tag 逐字相同（`packages/core/agent/src/runtime-types.ts:363` vs tag `:260`） |
| 作用域化事件派发 | 根 ctx 上的监听器 | ✅ **`global: true` 不是必需的**：scope 过滤器对无 tag 的监听器直接放行（`packages/core/scope/src/index.ts:176` `if (tag === undefined) return true`，该文件相对基线无改动；README 原文「Untagged listeners stay global」）；插件由 `cordis.patch.yml` 顶层挂载，未被 `createScope` 打标。与官方 `llm-retry` 同款根注册（`packages/llm/llm-retry/src/index.ts:243`）；`{prepend:true}` 仍有效（`vendor/cordis/src/events.ts:112-117,255`） |
| `session/event` | `ctx.on('session/event', (session, event) => …)` | ✅ 签名一致（`packages/core/session/src/index.ts:72` vs tag `:76`） |
| `assistant/message` 读取 | `data.interrupted`、`message.source.kind==='model'`、`source.provider` | ✅ 字段俱在；`AssistantProvenance.provider` 未变 |
| `LlmFailure` | `message` / `code` / `status` | ✅ 形状逐字相同（`packages/llm/llm/src/types.ts:40-50`） |
| `createUserMessage` / `UserMessage` | `src/notice.ts` | ✅ 签名与根导出未变（`packages/llm/llm/src/message.ts:204`）；`plugin`+`form:'notice'`+`summary` 仍合法 |
| `session.append(..., {surfaceOp:'append'})` | 注入 resumeNotice | ✅ 仅泛型化；append 路径不受 V3 影响 |
| `ctx.credentials.resolve` | `resolve(ref)?.value` | ✅ `ResolvedCredential {value, source}` 未变 |
| `launchEnvironmentOf(ctx).get(name)?.value` | 无 credentials 时回退 | ✅ 未变 |
| `ctx.webServer.register({kind:'prefix', path, handler})` | `/auto-continue/api` | ✅ `WebRoute` 逐字相同（`packages/host/webserver/src/index.ts:38-48`） |
| `ctx.webRuntime.trustedHosts` | trust-fence | ✅ `webRuntime` service 仍在（`packages/bundle/web-app/src/index.ts:231`） |
| `settings` 写入/读取语义 | `get` / `update` / `replace` / `describe` / `validate` | ✅ 全部保留；`SettingsProvider` 抽象面未变（测试子类化仍成立） |
| `role('secret')` 脱敏 | `src/config.ts:70` | ✅ `redact.ts` 两版逐字节相同 |
| client `settings.section` slot | 独立设置选项卡 | ✅ 仍为 `{kind:'list', scope:'root', owner:{close}}`（`packages/client/ui-settings/src/client/contract/slots.ts:54,123-126`），与插件本地声明一致 |
| client `Modal` / `IconChevronDownOutline14` / `IconPlusOutline16` | 卡片 UI | ✅ 仍从 `ui-primitives` 根导出（`src/index.ts` 的 `export * from './icons/index.tsx'`） |
| client `TranslateNS` / `LocaleNamespaceMap` | `locales.ts` / 卡片 props | ✅ `ui-slots` 仍导出；`locale.register/bind` 签名兼容 |
| 插件形态与声明合并 | `Service` 子类、`declare module '@deepseek-ai/cordis'` | ✅ vendor cordis 仅 `4.0.1 → 4.0.2`（`git diff` 只改 version），API 未变 |
| `dsh.bundle.patch` / `cordis.patch.yml` 的 `insert:` | 官方 CLI 挂载 | ✅ `DshBundleManifest {patch}` 未变；`insert` 列表仍被支持（`packages/boot/app-boot/src/index.ts:287,334,340`） |
| client bundle 发现与格式 | `dsh.client` + `window.__ModuleLoader__` | ✅ 仍扫描已启用 Loader entry 的 `dsh.client`（需 `exports["./client"]` 且 `platform:'web'`）；bundle 的 banner/footer/intro 与官方预设逐字一致（官方 `packages/client/tsdown.client.ts:566-568`）；构建产物实测通过（§4） |

---

## 4. 实证验证（scratch 副本）

在 `/tmp/mig-check`（仓库副本，未改动本仓库）把依赖升到 `0.1.5-rc.2` + `cordis@4.0.2`，
按 §2 做最小迁移（host 2 处 / client 2 处 / 测试 2 处），得到：

| 步骤 | 结果 |
|---|---|
| 升级前 typecheck | **7 个错误**，全部集中在 settings 旧 API 与 `dsh-client-runtime`（无其他错误） |
| 迁移后 `pnpm typecheck` | ✅ 0 错误 |
| `pnpm test`（vitest） | ✅ **7 个文件 / 75 用例全部通过**（含 settings 变更语义、`/auto-continue/api` 路由、恢复状态机集成） |
| `pnpm build` | ✅ host `lib/index.js` + client `lib/client.js` 均产出，纯净度门禁无报错 |
| client bundle externals | 只有 `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives`，全部在 `PLATFORM_MODULES` 内；**零处**引用已删除的 `dsh-client-runtime` |
| host bundle imports | 迁移后只 import `@deepseek-ai/cordis` / `dsh-launch-environment` / `dsh-llm` / `schemastery`（`dsh-settings` 已变为 type-only） |

> 说明：vitest 只用 esbuild 转译、不做类型检查，因此即便存在类型错误也能跑通测试 ——
> 这恰好把「类型层破坏」与「运行时破坏」分离开，结论是**只有类型/装载层破坏，运行时行为无回归**。

---

## 5. 迁移清单（已验证可用的最小改动）

```
src/index.ts
  - import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
  + import type {} from '@deepseek-ai/dsh-settings'
  - const SETTINGS_NAMESPACE = settingsNamespace('auto-continue')
  + const SETTINGS_NAMESPACE = 'auto-continue' as const
  - installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config, { … })
  + ctx.inject(['settings'], (settingsCtx) => {
  +   settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, { … })
  + })

src/client/index.tsx
  - import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  + import type { Context as ClientContext } from '@deepseek-ai/cordis'
  + import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'

tests/settings.spec.ts, tests/api.spec.ts
  - import { SettingsProvider, settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
  + import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
  - const NS = settingsNamespace('auto-continue')
  + const NS = 'auto-continue' as const
  - async function waitForNamespace(ctx: Context, ns: SettingsNamespace)
  + async function waitForNamespace(ctx: Context, ns: string)

package.json
  ~ 所有 @deepseek-ai/dsh-* → 0.1.5-rc.2；peer 区间 → ^0.1.5-rc.2；@deepseek-ai/cordis → 4.0.2
  - 移除 @deepseek-ai/dsh-client-runtime
  + 新增 @deepseek-ai/dsh-client-ui-renderer（devDependency，type-only 关系）
  ~ dsh.client.inject: [dsh-client-runtime, dsh-client-locale]
                     → [dsh-client-ui-renderer, dsh-client-locale]
  ~ 可选：dsh-settings 从 dependencies 移到 devDependencies（迁移后已是 type-only）
  ~ 可选：package.json engines 增加 "dsh": "^0.1.5-rc.2"

tsdown.config.ts（可选但对齐，见 §2 P2 表）
  ~ CLIENT_EXTERNALS: 'cordis' → '@deepseek-ai/cordis'
  - 移除 '@deepseek-ai/dsh-client-runtime/client'
  + 补齐 '@deepseek-ai/dsh-client-store'、'@deepseek-ai/dsh-client-ui-dockkit'
```

无需改动的部分：`config.ts` / `state.ts` / `platform.ts` / `platforms/zenmux.ts` / `recovery.ts` /
`notice.ts` / `wire.ts` / `trust-fence.ts` / `client/` 其余文件（业务逻辑零改动）。

**可选跟进**（非阻塞）：`src/trust-fence.ts` 是从 DSH 复刻的旧版，当前官方
`isTrustedApiRequest` 的 Origin 比较已由 `.hostname` 收紧为 `.host`（`packages/client/connection/src/api-request-trust.ts:120`），
且新增了对 `origin: "null"` 的显式拒绝。建议同步以保持一致。

---

## 6. 未覆盖 / 待确认

1. **真实 402 黄金样本仍未核对**（需求 §7 验收第 18 条，延续既有待办）：与本次升级无关，等配额耗尽后处理。
2. ~~**未跑真实 `dsh web` 挂载 e2e**~~ → **已补跑通过**（见 §8）：`pnpm test:e2e` 3 个用例对真实
   `dsh web` 全部通过，覆盖 host 装载、client bundle 无头渲染与设置页交互。
3. **依赖 hoisting 行为未实测**：`dsh plugin add` 后的实际解析（插件自带副本 vs host 提供）未验证；
   迁移到 0.1.5 并把 `dsh-settings` 降为 type-only 后，该风险基本消除。
4. **`AGENTS.md` 铁律 4 已过时**：0.1.5 起 `SurfaceEventType` 已包含 `'system/message'`，
   需求 §8 预留的「系统消息升级」现在具备技术前提。本次不改代码，仅记录。
5. **`LlmProviderInfo` 是未使用的 import**（`src/index.ts:6`），可顺手清理。
6. **`Agent` 由直接 interface 改为模块合并声明**（`packages/core/agent/src/runtime-types.ts:163` 的
   `declare module './types.ts'`）：理论上影响 `payload.agent.session.append(...)` 的解析，
   但 §4 的 scratch `pnpm typecheck` 已 0 错误通过，**实证无需处理**。
7. **`dsh-agent` 0.1.5 新增 peerDependencies `@deepseek-ai/dsh-session-projection` / `@deepseek-ai/dsh-util-values`**：
   插件未安装这两个包；§4 实测在 `skipLibCheck: true` 下不影响编译。仅当 `pnpm install` 出现
   unmet peer 报错时才需补 devDependency。

---

## 7. 建议动作

| 优先级 | 动作 |
|---|---|
| 必做 | 按 §5 迁移 host/client/测试/依赖，然后跑 `pnpm typecheck && pnpm test && pnpm build` |
| 必做 | 更新 `README.md`（DSH 兼容版本）与 `PROGRESS.md`（升级记录、决策） |
| 建议 | 跑一次 `pnpm test:e2e` 对真实 `dsh web` 验证挂载与设置页渲染 |
| 建议 | 同步 `src/trust-fence.ts` 到官方当前实现 |
| 建议 | 修正 `AGENTS.md` 铁律 4（`system/message` 已可用）与死 import |

---

## 8. 落地状态（已执行）

目标版本 **DSH `0.1.5-rc.2`**（npm dist-tag `next`，当时最新已发布；仓库 HEAD 虽领先 139 个 commit
但版本号相同、无对应发布物）。

| 项 | 状态 |
|---|---|
| §5 host/client/测试/依赖迁移 | ✅ 已落地（业务逻辑零改动） |
| `src/trust-fence.ts` 同步官方 | ✅ 已做（Origin 比较收紧为 `.host`） |
| `tsdown.config.ts` `CLIENT_EXTERNALS` 对齐 | ✅ 已做 |
| `README.md` / `PROGRESS.md` / `AGENTS.md` 同步 | ✅ 已做 |
| 死 import `LlmProviderInfo` | ✅ 已清理 |
| `pnpm typecheck` | ✅ 0 错误 |
| `pnpm test` | ✅ 7 文件 / 75 用例 |
| `pnpm build` | ✅ host + client 双半体 |
| 真实 `dsh web` 挂载 | ✅ 见下 |

**真实挂载验证**：`pnpm test:e2e`（`scripts/e2e-mount.sh`）全流程通过——
`pnpm build` + `pnpm pack` → `dsh plugin --profile web add file:<tarball>` 注册进
`dsh.profile.bundles` → 启动真实 `dsh web --port 0` → Playwright 无头 Chromium 断言 **3/3 通过**：
① client bundle 挂载无 `pageerror`、无 `auto-continue` console 错误；
② Settings 面板中「自动续跑」作为**独立选项卡**可见；
③ 点「新增」→ 填 id → 保存 → 卡片出现——覆盖 `/auto-continue/api` 在**新 `installSection` settings
实现**上的写入链路。另经 HTTP 拉取首页确认 `__DSH_BOOT__` 引导图包含
`@deepseek-ai/dsh-auto-continue/client.js`（client bundle 已被模块系统发现并物化）。
