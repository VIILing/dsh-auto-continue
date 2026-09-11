# DeepSeek Harness 插件开发背景知识

> 本文面向需要在 DeepSeek Harness（以下简称 DSH）中开发插件的工程师。
> 阅读对象：已经了解 TypeScript 与 Node.js，但不熟悉 DSH / Cordis 的开发者。
> 配套文档：`doc/需求文档/需求文档.md`。

---

## 1. DSH 是什么

DeepSeek Harness（`dsh`）是由 DeepSeek AI 开源的 agent 运行框架。其最核心的设计原则是：

> **一切皆插件（everything-is-a-plugin）**。

在 DSH 中，模型适配器、工具注册表、会话日志、agent loop、Web UI、沙箱、权限策略等，全部都是插件。插件通过配置组合成一棵“插件树”，没有任何一个特权内核需要被修改。扩展 DSH 的方式就是编写新插件，把它挂载到其他插件旁边。

DSH 底层的插件框架是 **Cordis**。Cordis 在 DSH 中以 `@deepseek-ai/cordis` 包名提供（vendor 形式，代码位于仓库 `vendor/cordis`）。理解 Cordis 的五个核心概念，就理解了 DSH 插件开发的基础。

---

## 2. Cordis 核心概念

### 2.1 插件（Plugin）

Cordis 接受三种插件形态：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

// ① 函数插件（最常用）：模块导出一个 apply 函数
export const name = 'my-plugin'
export const inject = ['tools']
export function apply(ctx: Context, config: Config) {
  // 在这里注册能力
}

// ② 对象插件：对象带有 apply 方法
export default {
  name: 'my-plugin',
  inject: ['tools'],
  Config,
  apply(ctx: Context, config: Config) { /* ... */ },
}

// ③ 类插件：Service 子类，用于“提供服务”
export default class MyService extends Service {
  static inject = ['llm']
  static Config = Config
  constructor(ctx: Context, config: Config) {
    super(ctx, 'myService')   // 注册为 ctx.myService
  }
}
```

- **函数插件**：最常见。`apply` 的第二个参数是经过校验和填好默认值的配置。
- **对象插件**：带 `apply` 方法的对象，适合需要同时导出更多元数据的场景。
- **类插件**：`Service` 子类。当插件要向其他插件“提供服务”时使用。Loader 会 `new` 这个类，并把 `ctx` 和 `config` 传入构造函数。

> 补充说明：
>
> - ① 的写法（`export const name/inject` + `export function apply`）在 ESM 模块里其实是一个“命名空间对象”。loader 的 `unwrapExports` 拿到它后，Cordis 会按“对象插件”（有 `apply` 方法）来加载——它与严格意义上的“函数插件”（把 `name`/`inject`/`Config` 作为属性挂在函数上）加载行为完全一致。这是 DSH 生态的实际主流写法（`dsh-llm-retry` 等内置插件皆如此），照此书写即可。
> - ③ 的“类插件”不强制继承 `Service`：任何带静态 `inject`（及可选静态 `Config`）的构造函数都可被 loader `new`。继承 `Service` 并调用 `super(ctx, name)` 的唯一额外作用是**把实例注册为服务**（见 2.3）。

### 2.2 Context：服务容器

**Context（上下文）** 是服务（Service）的仓库。一个服务占据一个稳定的 `ctx.<key>`，例如：

| ctx 键 | 服务 |
|---|---|
| `ctx.tools` | 工具注册表与执行流水线 |
| `ctx.llm` | LLM 适配器注册与流式调用 |
| `ctx.agents` | Agent 注册表 |
| `ctx.sessions` | 会话存储 |
| `ctx.systemPrompt` | 系统提示词组装 |
| `ctx.credentials` | 凭据解析 |

其他插件通过 **key** 查找服务，而不是 import 具体实现类。因此配置可以替换服务提供者，而服务消费者不用改代码。

### 2.3 Service：提供服务

要提供服务，插件继承 `Service` 并在构造函数中调用 `super(ctx, '服务名')`：

```ts
import { Service, type Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    greeter: GreeterService   // 让 ctx.greeter 有类型
  }
}

export default class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')     // 运行期注册：之后任何插件可访问 ctx.greeter
  }
  greet(who: string) {
    return `Hello, ${who}!`
  }
}
```

- `declare module '@deepseek-ai/cordis' { interface Context { ... } }` 是 TypeScript 声明合并，只影响类型，不产生运行时代码。
- 服务注册是 effect：卸载提供者时，服务会被移除。
- 服务名在同一个隔离 scope（isolation realm）内是**扁平命名空间**：同一 realm 内名字唯一，重复 `provide` 同名服务会抛错（`service "..." has been registered at ...`）。DSH 已经占用了 `tools`、`llm`、`agents` 等名字，自定义服务应加前缀，例如 `myPlugin.greeter`。
- 需要多个互不干扰的同名服务实例时，用 `isolate` 创建独立 realm（见 4.4）：不同 realm 内的同名服务互不影响、互不冲突。

### 2.4 inject：依赖声明

插件通过 `inject` 声明它需要哪些服务：

```ts
export const inject = ['tools', 'llm']

export function apply(ctx: Context) {
  // 此处保证 ctx.tools 和 ctx.llm 已经存在且 ACTIVE
}
```

关键行为：

1. **依赖就绪才加载**：`inject` 中的服务全部就绪后，Cordis 才会调用 `apply`。
2. **加载顺序由依赖决定，不由配置文件里的顺序决定**。配置列表中的条目是并发挂载的，列表位置不保证加载先后。
3. **依赖消失会卸载**：如果所需服务在运行中被卸载/替换，依赖它的插件也会被卸载，等服务恢复后重新加载。
4. **可选依赖**：不写 `inject`，在运行时用 `ctx.get('serviceName')` 探测；没有提供者时返回 `undefined`，插件仍可运行。

### 2.5 Config：配置 Schema

插件可以导出 `Config` 来声明配置结构。DSH 使用 **Schemastery** 作为 schema 库（Cordis 接受任何 Standard Schema 校验器，但 DSH 生态统一用 Schemastery）：

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  greeting: string
  retries: number
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  retries: Schema.number().default(3),
})

export function apply(ctx: Context, config: Config) {
  // config 已通过校验，且缺省字段已填默认值
}
```

要点：

- `interface Config` 和 `const Config` 同名导出：一个给 TypeScript 类型，一个给运行时校验。
- 配置在 `apply` 执行前完成校验；校验失败则插件加载失败（FAILED），不会半初始化。
- **不要导出普通对象作为 Config**：普通对象不实现 Standard Schema，不会被接受。
- DSH 设计原则：**所有部署可能想调整的值都应做成配置字段**，不要硬编码。

### 2.6 Fiber：插件实例的生命周期

每个被加载的插件实例都拥有一个 **Fiber**。状态机：

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                 ↘ FAILED
```

| 状态 | 含义 |
|---|---|
| PENDING | 已声明，但所需依赖服务尚未就绪 |
| LOADING | 依赖就绪，`apply` 正在执行 |
| ACTIVE | 插件运行中 |
| FAILED | `apply` 或配置校验抛错 |
| UNLOADING | 正在卸载，执行 disposer |
| DISPOSED | 已完全卸载 |

插件在 PENDING 状态不会报错，也不会打印任何东西。排查“插件为什么没有加载”时，常见原因是 `inject` 中某个服务没有提供者。

### 2.7 Effect：可逆副作用

插件通过 `ctx` 注册的能力都应该是**可逆副作用**。插件卸载时，Cordis 会自动撤销这些注册：

```ts
export function apply(ctx: Context) {
  // 事件监听：卸载时自动移除
  ctx.on('some-event', handler)

  // 子插件：随父插件一起卸载
  ctx.plugin(childPlugin)

  // 业务注册：卸载时自动反注册
  ctx.tools.register(tool)

  // 自定义资源：用 ctx.effect 包住并返回 disposer
  ctx.effect(() => {
    const timer = setInterval(() => {}, 5000)
    return () => clearInterval(timer)   // 卸载时执行
  })
}
```

清理顺序规则：

- 同步 disposer 按**注册顺序的逆序**执行。
- 多个**异步** disposer **并发**执行，不保证先后。
- 需要按顺序清理的资源，必须放进同一个 `ctx.effect()` 返回的单一 disposer 中，并在其中顺序 `await`。

---

## 3. 事件系统

### 3.1 事件命名

DSH 事件使用 `namespace/action` 命名，例如：

- `agent/request-error`
- `agent/request`
- `agent/pre-step`
- `llm/stream`
- `tools/pre-execute`
- `tools/result`
- `session/event`

自定义事件建议使用自己的命名空间前缀，例如 `quota/changed`。

### 3.2 五种分发模式

事件通过 TypeScript 声明合并注册签名，然后使用与模式匹配的方法分发：

| 模式 | 调用方法 | 是否 await | 分发顺序 | 返回值 |
|---|---|---|---|---|
| `emit` | `ctx.emit(name, ...args)` | 否 | 按注册顺序观察 | 忽略 |
| `waterfall` | `ctx.waterfall(name, ...args, inner)` | 由监听器决定 | 按注册顺序形成洋葱链 | 有 |
| `parallel` | `await ctx.parallel(name, ...args)` | 是 | 所有监听器并行执行 | 无 |
| `serial` | `await ctx.serial(name, ...args)` | 是 | 按注册顺序执行 | 首个非 null/false/undefined 值 |
| `bail` | `ctx.bail(name, ...args)` | 否 | 按注册顺序执行 | 首个非 null/false/undefined 值 |

补充说明：

- `emit` 是“发射后不理会”（fire-and-forget）：监听器返回的 Promise 不会被 await，也不会向上抛；异步监听器需要自行捕获并处理错误。
- `parallel` 会等待所有监听器 settle，但**任一监听器 reject 时整体抛 `AggregateError`**（聚合所有拒绝原因），而不是静默忽略。
- `serial` 与 `bail` 都是“遇到首个 bail 值（非 null/false/undefined）即停”，区别仅在于 `serial` 会 await 监听器返回的 Promise，而 `bail` 是同步的——返回 Promise 的监听器会把 Promise 本身当作 truthy 的 bail 值立即返回，**`bail` 不适用于异步监听器**。
- `waterfall` 的“是否 await”取决于最外层监听器返回的是普通值还是 Promise：返回 Promise 时调用方需要自行 `await`。

### 3.3 waterfall 详解

`waterfall` 是“环绕中间件”，用于拦截与转换。监听器签名：

```ts
ctx.on('demo/transform', async (input, next) => {
  const downstream = await next()   // 执行下游监听器
  return downstream.toUpperCase()   // 包装下游返回值
})
```

规则：

1. 调用 `next()` 继续执行下游；**返回时不调用 `next()` 就是短路**。
2. 只做观察/注解的监听器**必须调用 `next()`**，否则会吞掉下游所有行为。
3. 策略类监听器在“拥有决策权”时可以不调用 `next()` 直接返回结果。

DSH 中大量拦截点都是 waterfall：`agent/request-error`、`agent/request`、`llm/stream`、`tools/pre-execute` 等。

### 3.4 监听器选项

```ts
ctx.on('event', listener, { prepend: true, global: true })
```

- `prepend: true`：把监听器排到该事件已有监听器之前。
- `global: true`：跨作用域监听（通常用于观察所有 agent，而不是只观察当前 scope）。
- 默认情况下，监听器按注册顺序执行。
- 另提供 `ctx.once(name, listener, options)`：首次触发后自动注销，适合一次性初始化/确认类事件。

### 3.5 类型化事件

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'my-plugin/ready'(payload: { id: string }): void
  }
}
```

声明合并后，`ctx.on('my-plugin/ready', ...)` 与 `ctx.emit('my-plugin/ready', ...)` 都有完整类型推断。

---

## 4. Loader 与配置

### 4.1 配置条目字段

`cordis.yml`（以及 bundle patch 文件）是一个条目列表。每个条目可包含：

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | string | 条目稳定身份。patch 按 id 定位行；没有 id 时 loader 每次生成随机 id，配置热更时会被当作“删除+新增”整体重挂 |
| `name` | string | 模块 specifier：相对路径、npm 包名，或 `cordis:` 内置（如 `cordis:group`） |
| `config` | object | 传给插件 `apply(ctx, config)` 的配置 |
| `disabled` | boolean / `!!js` | 为 true 时保留条目但跳过挂载 |
| `group` | boolean | 标记为 group 条目 |
| `inject` | array / object | 在插件自身 inject 之外追加依赖 |
| `isolate` | object | 为条目/组创建服务隔离 realm |
| `intercept` | object | 覆盖依赖服务的 config |

### 4.2 id 的重要性

- patch 通过 `id` 定位条目；后写入的层会覆盖先写入层的同 id 条目。
- 配置热更（HMR）按 id diff：有 id 的条目只更新变化部分；没有 id 的条目每次读取都会生成新 id，导致整体重挂。
- 因此**每个生产条目都应有稳定的显式 id**。

### 4.3 config 与 `!!js`

`config` 内可以使用 `!!js` 标签写运行时表达式：

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

- `!!js` 只在 `config` 和 `disabled` 中有效。
- `config` 中的 `!!js` 在插件声明的 `inject` 激活后、基于插件自己的 `ctx` 求值。
- `disabled` 中的 `!!js` 在每次挂载决策时基于 loader 上下文求值。

### 4.4 group / isolate / intercept

- **group**：把一组条目作为一个单元加载/卸载。配置中用 `cordis:group` 插件 + `group: true`。
- **isolate**：为 group/条目创建独立的服务 realm。例如两个 group 各自 `isolate: { shell: true }`，则各自拥有独立的 `ctx.shell` 实例，互不干扰。
- **intercept**：在某个条目上覆盖其依赖服务的配置，例如给某个消费者注入不同配置的依赖。

### 4.5 patch、bundle、profile

DSH 的配置是“有序层叠加”的结果：

1. profile 的 `dsh.profile.bundles` 列表中的每个 bundle patch，按列表顺序；
2. profile 自己的 `cordis.patch.yml`；
3. home 级 `$DSH_HOME/cordis.patch.yml`；
4. 命令行 `--patch` overlay，按 argv 顺序。

规则：

- **后层覆盖前层**。
- patch 以 **id 定位整行**，替换的是**整个 `config` 值**，不是深合并。
- 因此覆盖某行时要重述所有保留字段。

bundle 与 profile 的定义：

- **bundle**：npm 包，`package.json` 中 `dsh.bundle.patch` 指向 patch 文件。
- **profile**：`$DSH_HOME/profiles/<name>` 下的具名组装，`dsh.profile.bundles` 列出 bundle。

---

## 5. DSH 会话与 LLM

### 5.1 会话日志与 surface

DSH 的核心不变式：

> **模型可见即已记录（Model-visible means logged）。**

会话（Session）日志是只追加（append-only）的事件流。模型看到的上下文全部从日志派生：

- `SessionEventMap` 定义所有事件类型；**插件可以通过声明合并扩展它**，添加非 surface 事件。
- **surface（表面）**：日志中会派生为 LLM 消息的事件集合。当前 surface 事件类型只有三种：
  - `user/message`
  - `assistant/message`
  - `tool/result`
- `session.deriveMessages()` 按 surface 顺序投影出 LLM 消息历史。
- 要给模型看到新内容，必须落成 surface 事件（通常追加 `user/message`）。
- 追加消息的示例：

```ts
agent.session.append('user/message', message, { surfaceOp: 'append' })
```

- `SurfaceEventType` 是 type 别名，**插件无法通过声明合并扩展**。`0.1.5` 起框架自带了 `system/message`，但它是**渲染后的系统提示词**所在节点，不是插件通知通道（框架会在非 in-history 路由上把后续系统节点置空）；插件注入的合成上下文应走 `user/message`，必要时用调用方自带的 `<system-reminder>` 包裹——这也是 `agent-instructions`、`tool-skill` 等一方插件的做法。

### 5.2 LLM 服务

`ctx.llm` 是 LLM 适配器注册表与流式调用服务：

- 适配器通过 `ctx.llm.registerAdapter(providers, adapter)` 注册，并声明自己负责哪些 provider 路由。
- 一次模型请求使用 `GenerateOptions` 描述：

```ts
interface GenerateOptions {
  provider: string        // provider 路由名，选择适配器
  model: string
  messages: Message[]     // 有序对话消息（system 槽位之外）
  system?: string         // 系统提示词文本
  tools?: ToolSchema[]
  signal?: AbortSignal
  // ...
}
```

- `Message` 支持 `role: 'system' | 'user' | 'assistant'`。
- `ctx.llm.stream(options)` 返回 `AsyncIterable<StreamChunk>`。

### 5.3 provider 与 adapter

- provider 是字符串路由名（如 `deepseek`、`openai`、`zenmux-provider`），由适配器注册时声明。
- 多 provider 适配器（如 `dsh-llm-pi-ai`）通过配置为每个 provider 路由设置 `api`、`baseURL`、`apiKeyEnv`、`retryPolicy` 等。
- OpenAI Chat Completion 协议在 `dsh-llm-pi-ai` 中对应 `api: openai-completions`。

### 5.4 LlmFailure 与 LlmError

当一次模型请求失败时，最终适配器边界会把错误归一化为 `LlmFailure`：

```ts
interface LlmFailure {
  readonly message: string       // 人类可读失败摘要
  readonly code: string          // 稳定错误码：QUOTA / RATE_LIMIT / SERVER / TIMEOUT ...
  readonly status?: number       // HTTP 状态码（适配器能拿到时才有）
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}
```

注意：

- 应该**优先 route on `code`**，而不是解析 `message`。
- 但某些适配器的 code 映射可能不完整/不准确。例如 `dsh-llm-pi-ai` 目前对 ZenMux 的 402 分类不完整。此时插件可以在自己负责的 provider 范围内做本地正则识别。

---

## 6. Agent loop 与关键扩展点

### 6.1 turn 与 step

- **step**：一次模型请求 + 该请求引发的工具调用。
- **turn**：零个或多个 step。turn 在领取首条输入前打开，在不再欠任何工作时关闭。

简化流程：

```
turn/start
  agent/pre-step（决定是否进入、进入哪些消息）
  step/start
  记录 user/message
  构建请求（agent/request 瀑布）
  llm/stream → assistant/chunk* → assistant/message
  工具调用 → tools/pre-execute → tools/execute → tools/post-execute → tool/result
  step/end
  （可能继续 next-step）
turn/end
```

### 6.2 agent/request-error：请求失败恢复扩展点

这是“自动续跑”插件的核心挂载点。当一次模型请求以失败结束时，agent loop 会分发：

```ts
'agent/request-error'(
  this: Scoped<Agent>,
  payload: {
    agent: Agent
    turn: number
    step: number
    provider: string
    failure: LlmFailure
    retryPolicy: ResolvedRetryPolicy | undefined
    signal: AbortSignal
  },
  next: () => Promise<RequestErrorAction>,
): Promise<RequestErrorAction>
```

其中：

```ts
type RequestErrorAction = { kind: 'retry' } | undefined
```

语义：

- 监听器返回 `{ kind: 'retry' }`：表示“我负责恢复”，loop 会在**同一个 turn、同一个 step** 内重新构建并发送请求。模型历史不变，对 LLM 无感。
- 监听器返回 `undefined`（或调用 `next()` 后得到 undefined）：表示失败终止，turn 以 error 结束。
- `payload.signal` 是当前 turn 的中止信号，等待期间必须监听它。

### 6.3 其他相关扩展点

- `agent/request`（waterfall）：替换本次请求的 provider/model 等配置，**不能修改消息内容**。
- `agent/pre-step`（waterfall）：拒绝或改写进入 step 的消息。
- `llm/stream`（waterfall）：环绕每次流式调用。可以短路并自行产出 chunk（例如产出错误 finish chunk）。
- `session/event`（emit）：观察所有会话事件。

### 6.4 与 dsh-llm-retry 的协作模式

`dsh-llm-retry` 是 DSH 自带的请求重试插件，同样挂在 `agent/request-error` 上：

- 它根据 provider 的 `retryPolicy` 对 `RATE_LIMIT`、`SERVER`、`TIMEOUT` 等错误做有限重试。
- 它返回 `{ kind: 'retry' }` 来实现同 turn/step 重试。
- 自定义恢复插件应当遵循同样的约定：
  - **自己负责的错误**：不调用 `next()`，直接返回恢复决策；
  - **其他错误**：调用 `next()`，交给 `dsh-llm-retry` 等下游策略。

---

## 7. 凭据与环境

### 7.1 ctx.credentials

DSH 通过凭据 seam 管理密钥：

- 配置文件只保存**引用**（通常是环境变量名），例如 `apiKeyEnv: OPENAI_API_KEY`。
- `ctx.credentials.resolve(ref)` 按固定优先级解析：启动环境 > 凭据存储文件 > 项目 `.env` > home `.env`。
- 没有 `ctx.credentials` 时，可用 `launchEnvironmentOf(ctx)` 读取启动环境快照。

### 7.2 launchEnvironmentOf

来自 `@deepseek-ai/dsh-launch-environment`：

```ts
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

const env = launchEnvironmentOf(ctx)
const value = env.get('ZENMUX_MANAGEMENT_API_KEY')?.value
```

它返回本次进程启动时的环境快照；在非 CLI 启动的测试/嵌入场景中会回退到 `process.env`。

---

## 8. 插件开发检查清单

1. 明确插件是“纯消费者”“纯提供者”还是“服务 + 策略”角色。
2. 函数插件导出 `apply`；服务插件继承 `Service` 并 `super(ctx, 'name')`。
3. 需要依赖的服务写入 `inject`；可选依赖用 `ctx.get()` 探测。
4. 配置字段使用 Schemastery schema，带默认值，fail loud。
5. 所有资源通过 `ctx.effect()` / `ctx.on()` / 服务注册管理，保证卸载时清理。
6. waterfall 监听器：要么调用 `next()`，要么是刻意的短路。
7. 事件名、服务名加前缀，避免与 DSH 保留名冲突。
8. 在 `cordis.yml` / patch 中给条目显式 `id`。
9. 模型可见内容必须落成 surface 事件（通常是 `user/message`）。
10. 长时间等待必须可取消（监听 `AbortSignal`），插件卸载时清理 timer 与进行中的任务。

---

## 9. 术语表

| 术语 | 解释 |
|---|---|
| Cordis | DSH 底层的插件框架 |
| Context（ctx） | 服务容器与插件注册能力的总入口 |
| Service | 可被其他插件通过 `ctx.<key>` 获取的命名能力 |
| Plugin | 插件：函数 / 对象 / Service 子类 |
| inject | 插件声明的硬依赖服务列表 |
| Config | 插件配置的运行时 Schema + TS 类型 |
| Fiber | 插件实例的生命周期管理单元 |
| Effect | 可逆副作用；插件卸载时自动撤销 |
| waterfall | 环绕中间件式事件分发 |
| Loader | 读取 `cordis.yml`/patch 并挂载插件的加载器 |
| patch | 以 id 定位并覆盖/插入配置行的配置片段 |
| bundle | 携带 patch 文件的 npm 包 |
| profile | 具名插件组合，含 bundle 列表与用户 patch |
| Session | 会话；其日志是模型上下文的唯一来源 |
| surface | 会话日志中会派生为 LLM 消息的事件子集 |
| LlmFailure | 归一化后的模型请求失败事实 |
| provider | LLM 适配器注册的路由名，请求用它选择适配器 |
| turn / step | 智能体工作单元：turn 包含零或多个 step，step = 一次模型调用 + 其工具调用 |
| RequestErrorAction | `{kind:'retry'}` 或 `undefined`；请求失败恢复决策 |
| credentials seam | DSH 凭据解析服务 `ctx.credentials` |
