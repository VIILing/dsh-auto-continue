# @deepseek-ai/dsh-auto-continue

DeepSeek Harness 的“配额耗尽自动续跑”插件。当某个 provider 因订阅配额耗尽而返回
配额耗尽错误时（v1 为 ZenMux 的 HTTP 402 `quote_exceeded`），插件会：

1. 识别这类“配额耗尽”错误；
2. 查询该 provider 对应平台的 Platform API，获取配额窗口与重置时间；
3. 在进程内等待配额重置；
4. 等待结束后，让 agent loop **在同一个 turn/step 内**无感重发最后一次失败的请求；
5. 可选地在重发前注入一条 user 角色提示，说明等待时长。

## 三层模型（v2）

```
Platform Adapter（平台模板）
  └─ 实现 PlatformQuotaAdapter 的类，如 "zenmux"（内置清单见 src/platforms/index.ts）
  └─ 自带元信息：label（UI 展示名）、defaultBaseURL（默认端点）、
     optionsSchema（平台专属参数校验）、isExhausted（可选，自定义“耗尽”口径）

Platform Instance（平台实例）
  └─ id: "zenmux-main"（用户定义）
  └─ type: "zenmux"（由哪个模板生成，必填）
  └─ baseURL（可选，实例级端点覆盖）
  └─ options（平台专属参数，结构由所选模板定义）
  └─ managementKeyRef / managementKey、resumeNotice、statsRetry、postResetRetry、resetBufferMs

Provider（DSH 中的 LLM 路由）
  └─ provider-id，如 "zenmux-provider"
  └─ 通过 providerBindings 绑定到某个 platform instance
```

恢复状态、`disabled`、统计查询单飞均按 **platform instance** 键控；同实例的多个
provider 共享同一恢复状态。一个实例只属于一个平台模板，因此**多个平台可以并存**：
端点由模板自带、平台专属参数由模板校验，通用代码不认识任何具体平台。

## 新增一个平台模板

**内置平台**：新建 `src/platforms/<name>.ts` 实现 `PlatformQuotaAdapter`，然后在
`src/platforms/index.ts` 的 `builtinPlatformAdapters()` 里追加一行。状态机、设置、
UI、路由都不需要改动——UI 的平台下拉从 `ctx.quota.platforms()` 读取。

**第三方平台**（不改本插件任何文件）：在自己的插件里注册即可。设计要求（为什么必须做到
"不改动其他代码"，以及接口契约要保证什么）见
[`doc/设计文档/平台模板设计约束.md`](doc/设计文档/平台模板设计约束.md)。

```ts
ctx.inject(['quota'], (c) => c.quota.registerPlatformAdapter(new MyPlatformAdapter()))
```

注册之后：

- `type: <platform>` 的实例（含 `cordis.yml` base 层声明）立刻可用；
- UI 的平台下拉自动出现该模板（数据来自 `/auto-continue/api/platforms.list`）；
- 端点用适配器的 `defaultBaseURL`，或实例级 `baseURL` 覆盖；
- 平台专属参数写在实例的 `options` 里，由适配器 `optionsSchema` 校验。

> 加载期对**尚未注册**的平台类型只告警、不抛错（平台插件可能稍后加载）；
> settings 写入路径是严格的，此时写未知平台类型会直接报错。

## 安装与启用

```yaml
# cordis.yml / patch overlay
- id: auto-continue
  name: '@deepseek-ai/dsh-auto-continue'
  config:
    platformInstances:
      zenmux-main:
        type: zenmux
        managementKeyRef: ZENMUX_MANAGEMENT_API_KEY
        # managementKey: sk-xxxx
        # baseURL: https://proxy.internal   # 可选，覆盖模板默认端点
        # options: {}                       # 可选，平台专属参数
        resumeNotice:
          enabled: false
          template: "因额度限制，本次请求等待了 {hours} 小时 {minutes} 分钟后重新发送。"
        statsRetry:
          initialDelayMs: 60000
          maxDelayMs: 900000
          totalTimeoutMs: 3600000
        postResetRetry:
          delaysMs: [60000, 120000, 240000, 480000, 900000]
        resetBufferMs: 5000
    providerBindings:
      zenmux-provider: zenmux-main
```

默认 `platformInstances: {}`、`providerBindings: {}`（空实例，全部由 UI 新建）。
`platformBaseURL` 可省略：平台端点默认由各自模板的 `defaultBaseURL` 提供。

## 配置字段

### 全局字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `platformBaseURL` | string | `""` | **legacy 全局覆盖**：非空时对所有实例生效（优先级低于实例级 `baseURL`、高于模板 `defaultBaseURL`）。新配置建议留空，改用模板默认端点或实例级 `baseURL` |

### `platformInstances`（map，默认 `{}`）

键为实例 id，建议 lowercase kebab：`^[a-z][a-z0-9-]*$`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `type` | string | **必填** | 平台模板标识（已注册适配器的 `platform`）。不再默认成某个具体平台 |
| `baseURL` | string | 无 | 实例级平台端点覆盖；留空用模板 `defaultBaseURL` |
| `options` | object | `{}` | 平台专属参数；结构由所选模板的 `optionsSchema` 校验 |
| `managementKeyRef` | string | 无 | 管理密钥引用（env/凭据存储引用）。schema 支持，v1 UI 不展示 |
| `managementKey` | string | 无 | 明文管理密钥。`role('secret')`，UI 不回显 |
| `resumeNotice.enabled` | boolean | `false` | 是否在重发前注入提示 |
| `resumeNotice.template` | string | 见默认 | 支持 `{provider}`、`{hours}`、`{minutes}` |
| `statsRetry.initialDelayMs` | number | `60000` | 统计接口失败首次退避 |
| `statsRetry.maxDelayMs` | number | `900000` | 单次退避上限 |
| `statsRetry.totalTimeoutMs` | number | `3600000` | 退避总时长上限 |
| `postResetRetry.delaysMs` | number[] | `[60000,120000,240000,480000,900000]` | 重置后宽容重试等待序列 |
| `resetBufferMs` | number | `5000` | 等待 `resets_at` 的缓冲 |

### `providerBindings`（map，默认 `{}`）

- 键：provider-id（DSH LLM 路由名）。
- 值：platform instance id。
- 一个 provider 只能绑定一个 instance；一个 instance 可被多个 provider 绑定。
- 值为空或未出现在 `platformInstances` 中：配置校验失败。

跨字段校验（fail loud）：实例 id 格式、`type` 为已注册模板（settings 写入路径）、
`managementKeyRef` 与 `managementKey` 互斥、`baseURL` 为 http(s)、
`options` 为普通对象且通过模板 `optionsSchema`、`providerBindings` 指向存在的实例、
`postResetRetry.delaysMs` 非空正整数、`statsRetry` 三字段为正整数。

## Settings 接入

插件通过 `ctx.inject(['settings'], sctx => sctx.settings.installSection(ctx, 'auto-continue', Config, entry, hooks))`
注册 settings namespace `auto-continue`；`cordis.yml` 的 `config` 作为 base 层，UI 修改写入
user 层。`managementKey` 标记 `role('secret')`，线路上不回显。设置变更语义见 `doc/设计文档/配置与设置设计.md` §9。

> DSH `0.1.5` 起，旧自由函数 `installSettingsSection()` / `settingsNamespace()` 已被移除，
> 改用 `SettingsProvider.installSection()`；本插件已按新 API 迁移（见
> `doc/记录/DSH-0.1.5-升级影响评估.md`）。

此外插件注册一个自建的 fenced HTTP 路由 `/auto-continue/api`（`ctx.webServer.register` +
trust-fence），暴露 `settings.get`（脱敏）/ `settings.update`（replace 前回注 secret，实现
密码「留空不修改」）/ `providers.list` / `platforms.list`，供浏览器侧卡片读写设置——不依赖
DSH settings RPC 的命名空间 allowlist。

## 服务与事件

- 服务：`ctx.quota`（`QuotaRuntime`）
  - `status(instanceId)`：获取 instance 状态快照。
  - `isDisabled(instanceId)`：该 instance 是否已放弃自动续跑。
  - `statusForProvider(providerId)`：调试/查询便捷方法。
  - `platforms()`：已注册平台模板的元信息（`{ id, label }[]`，按 id 排序），UI 下拉的数据源。
  - `registerPlatformAdapter(adapter)`：**注册平台模板——第三方新增平台的入口**，返回注销函数。
- 事件：`quota/changed(instanceId, state, affectedProviders)`：按 instance 发布，
  payload 携带 instance id、状态与受影响 provider 列表。

状态快照：

```ts
type QuotaInstanceState =
  | { phase: 'unconfigured' }
  | { phase: 'idle' }
  | { phase: 'checking-stats' }
  | { phase: 'waiting-reset'; resetAt: number }
  | { phase: 'post-reset-retrying'; attempts: number }
  | { phase: 'disabled' }
```

## 平台适配器

插件采用“平台模板 + 通用恢复状态机”结构。任何能提供配额查询接口的 LLM 服务商，
实现 `PlatformQuotaAdapter` 并注册，即可复用同一套恢复流程，**状态机、设置、UI 都不用改**。
平台特有的默认端点、专属参数与“耗尽”口径都由适配器自己声明。
设计规格见 `doc/设计文档/平台适配器设计.md`，硬性要求见 `doc/设计文档/平台模板设计约束.md`：

```ts
interface PlatformQuotaAdapter {
  /** 平台模板标识（= 实例 type）。必填。 */
  readonly platform: string
  /** UI 展示名；缺省回退到 platform。 */
  readonly label?: string
  /** 该平台默认 API 端点；实例 baseURL 可覆盖，全局 platformBaseURL 为 legacy 覆盖。 */
  readonly defaultBaseURL?: string
  /** 平台专属参数（instance.options）的 schema；声明后写入设置时 fail loud 校验。 */
  readonly optionsSchema?: Schema<Record<string, unknown>>

  /** 判断一个 LlmFailure 是否为本平台的“配额耗尽”错误。 */
  matchesQuotaExhausted(failure: LlmFailure): boolean
  /** 请求平台统计接口。上下文含 credential / baseURL / instance / signal。 */
  fetchQuota(context: QuotaFetchContext): Promise<PlatformQuotaSnapshot>
  /** 根据归一化快照计算“重置时刻”（epoch ms）；无法计算时返回 null。 */
  resolveWaitTarget(snapshot: PlatformQuotaSnapshot): number | null
  /** 可选：覆盖通用“耗尽”判定口径。 */
  isExhausted?(snapshot: PlatformQuotaSnapshot): boolean
}

interface QuotaFetchContext {
  readonly credential: string
  readonly baseURL: string
  readonly instance: PlatformInstanceConfig  // 平台专属参数在这里（instance.options）
  readonly signal: AbortSignal
}
```

归一化快照：`{ windows: { name, usagePercentage, remainingFlows, resetsAt }[] }`；
通用“耗尽”判定为 `usagePercentage >= 1 || remainingFlows <= 0`，无法用该口径表达的平台
实现 `isExhausted` 即可。端到端接入验证见 `tests/platforms/contract.spec.ts`。

## Client UI

浏览器侧设置页与 host 同属**单包** `@deepseek-ai/dsh-auto-continue`（源码在 `src/client/`），
注册 **`settings.section`**（id = `auto-continue`），在 Settings 面板中占据**一个独立的顶层选项卡**
（与「General / Models / Plugins」并列，而非内嵌在 Plugins 页里），实现实例列表 + 增删改表单 +
provider 绑定多选（已绑定其它实例的 provider 隐藏）。设置页通过 `/auto-continue/api` 自建路由读写设置。

UI 复用 DSH 设计令牌（`--dsw-alias-*` CSS 变量）与第一方原语（`@deepseek-ai/dsh-client-ui-primitives`
的 `Modal` / 图标），风格对齐官方设置页：实例以**可展开卡片**呈现（标题 + 徽标 + 箭头，展开即编辑），
底部为**虚线「新增」按钮**（同「模型 → 添加提供方」样式），删除走 `Modal` 确认，保存/放弃更改在卡片
页脚。

单包是第三方独立插件的正确形态：DSH 的 client module 系统（`dsh.client`）会**扫描 host loader 条目**的
`package.json` 来发现 client bundle，因此 client 必须与 host 同包声明（参照 DSH-better-sidebar）。

`tsdown.config.ts` 在独立仓库内本地复刻（vendor 逻辑）了 DSH 官方 client bundle 预设（无需依赖
monorepo）：用 `tsdown` + `lightningcss` 产出 `lib/client.js`（`window.__ModuleLoader__.load({id,
factory})` 注册，CSS Module 内联注入 `<style data-plugin>`），host 半体产出 `lib/index.js`。client 的
外部依赖经模块表解析：`react` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives`
等（均为 `PLATFORM_MODULES` 预置模块）。

## 限制

- 仅进程内无感重发，不跨进程重启恢复。
- 不轮询额度，不预停新请求。
- 不处理余额类/账户逾期类错误（v1 ZenMux 中为 `insufficient_credit` / `reject_no_credit`）。
- 不新增 `system/message` surface 事件。
- 不实现 provider 切换（只预留 `quota/changed` 事件与适配器接口）。

## 未来扩展点

1. **Provider 切换**：监听 `quota/changed`，在 `agent/request` 瀑布中改写 provider 路由。
2. **新平台模板**：实现 `PlatformQuotaAdapter` 并注册（`ctx.quota.registerPlatformAdapter`），
   不改恢复状态机；端点、专属参数与“耗尽”口径都由适配器自带（见「新增一个平台模板」）。
3. **系统消息升级**：DSH `0.1.5` 起已支持 `system/message` surface 事件，`resumeNotice`
   可从 user 角色切换为 system 角色（本插件当前仍用 user 角色）。

## 安装与挂载

> 兼容的 DSH 版本：`0.1.5-rc.2`（`package.json` 的 `engines.dsh` 声明为 `^0.1.5-rc.1`）。
> 早于 `0.1.5` 的 DSH 不兼容——`0.1.5` 移除了本插件旧版依赖的 `installSettingsSection`
> 与 `@deepseek-ai/dsh-client-runtime`。

```bash
dsh plugin --profile web add @deepseek-ai/dsh-auto-continue@<version>
# 或 file: tarball（先 pnpm build && pnpm pack）
```

`dsh.bundle.patch`（`cordis.patch.yml`）向 cordis 插件树 `insert` 一行插件挂载，无需改 profile 文件。

## 开发

```bash
pnpm install
pnpm build       # tsc 声明 → lib/types/，tsdown → lib/index.js（host）+ lib/client.js（client）
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest（host 单元/集成，含 /auto-continue/api 路由）
pnpm test:e2e    # 对真实 dsh web 实例跑 Playwright 冒烟（build+pack+挂载+无头渲染）
```
