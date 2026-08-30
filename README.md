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
  └─ type: "zenmux"（v1 仅内置 zenmux 一个模板）

Platform Instance（平台实例）
  └─ id: "zenmux-main"（用户定义）
  └─ type: "zenmux"（由哪个模板生成）
  └─ managementKeyRef / managementKey、resumeNotice、statsRetry、postResetRetry、resetBufferMs

Provider（DSH 中的 LLM 路由）
  └─ provider-id，如 "zenmux-provider"
  └─ 通过 providerBindings 绑定到某个 platform instance
```

恢复状态、`disabled`、统计查询单飞均按 **platform instance** 键控；同实例的多个
provider 共享同一恢复状态。

## 安装与启用

```yaml
# cordis.yml / patch overlay
- id: auto-continue
  name: '@deepseek-ai/dsh-auto-continue'
  config:
    platformBaseURL: https://zenmux.ai
    platformInstances:
      zenmux-main:
        type: zenmux
        managementKeyRef: ZENMUX_MANAGEMENT_API_KEY
        # managementKey: sk-xxxx
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

## 配置字段

### 全局字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `platformBaseURL` | string | `"https://zenmux.ai"` | 平台 API base URL。v1 全局唯一，不在实例中 |

### `platformInstances`（map，默认 `{}`）

键为实例 id，建议 lowercase kebab：`^[a-z][a-z0-9-]*$`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `type` | string | `"zenmux"` | 平台模板标识。v1 仅 `zenmux` |
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

跨字段校验（fail loud）：实例 id 格式、`type` 为已注册模板、`managementKeyRef` 与
`managementKey` 互斥、`providerBindings` 指向存在的实例、`postResetRetry.delaysMs`
非空正整数、`statsRetry` 三字段为正整数。

## Settings 接入

插件通过 `installSettingsSection(ctx, 'auto-continue', Config, entry, hooks)` 注册
settings namespace `auto-continue`；`cordis.yml` 的 `config` 作为 base 层，UI 修改写入
user 层。`managementKey` 标记 `role('secret')`，线路上不回显。设置变更语义见需求 v2 §4.1。

此外插件注册一个自建的 fenced HTTP 路由 `/auto-continue/api`（`ctx.webServer.register` +
trust-fence），暴露 `settings.get`（脱敏）/ `settings.update`（replace 前回注 secret，实现
密码「留空不修改」）/ `providers.list`，供浏览器侧卡片读写设置——不依赖 DSH settings RPC
的命名空间 allowlist。

## 服务与事件

- 服务：`ctx.quota`（`QuotaRuntime`）
  - `status(instanceId)`：获取 instance 状态快照。
  - `isDisabled(instanceId)`：该 instance 是否已放弃自动续跑。
  - `statusForProvider(providerId)`：调试/查询便捷方法。
  - `registerPlatformAdapter(adapter)`：注册平台模板（未来扩展）。
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

插件采用“平台模板 + 通用恢复状态机”结构。任何能提供配额统计接口的 LLM 服务商，
实现 `PlatformQuotaAdapter` 并调用 `ctx.quota.registerPlatformAdapter(adapter)` 注册，
即可复用同一套恢复流程。

```ts
interface PlatformQuotaAdapter {
  readonly platform: string
  matchesQuotaExhausted(failure: LlmFailure): boolean
  fetchQuota(credential: string, baseURL: string, signal: AbortSignal): Promise<PlatformQuotaSnapshot>
  resolveWaitTarget(snapshot: PlatformQuotaSnapshot): number | null
}
```

## Client UI

浏览器侧设置卡片与 host 同属**单包** `@deepseek-ai/dsh-auto-continue`（源码在 `src/client/`），
注册 `settings.plugin.item`（key = `auto-continue`），实现实例卡片列表 + 增删改表单 +
provider 绑定多选（已绑定其它实例的 provider 隐藏）。卡片通过 `/auto-continue/api` 自建路由读写设置。

单包是第三方独立插件的正确形态：DSH 的 client module 系统（`dsh.client`）会**扫描 host loader 条目**的
`package.json` 来发现 client bundle，因此 client 必须与 host 同包声明（参照 DSH-better-sidebar）。

`tsdown.config.ts` 在独立仓库内本地复刻（vendor 逻辑）了 DSH 官方 client bundle 预设（无需依赖
monorepo）：用 `tsdown` + `lightningcss` 产出 `lib/client.js`（`window.__ModuleLoader__.load({id,
factory})` 注册），host 半体产出 `lib/index.js`。

## 限制

- 仅进程内无感重发，不跨进程重启恢复。
- 不轮询额度，不预停新请求。
- 不处理余额类/账户逾期类错误（v1 ZenMux 中为 `insufficient_credit` / `reject_no_credit`）。
- 不新增 `system/message` surface 事件。
- 不实现 provider 切换（只预留 `quota/changed` 事件与适配器接口）。

## 未来扩展点

1. **Provider 切换**：监听 `quota/changed`，在 `agent/request` 瀑布中改写 provider 路由。
2. **新平台模板**：实现并注册 `PlatformQuotaAdapter`，不改恢复状态机。
3. **系统消息升级**：若 DSH core 未来支持 `system/message` surface 事件，`resumeNotice`
   可从 user 角色切换为 system 角色。

## 安装与挂载

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
