# `@deepseek-ai/dsh-auto-continue` 需求补充文档（v2：platform 实例化与设置 UI）

> 版本：v2 补充
> 状态：初稿，待需求方确认
> 前置文档：`dsh-auto-continue-需求文档.md`（v1，已实现）
> 本文档是 v2 的**增量需求**，描述“platform 模板 / platform 实例 / provider 绑定”三层模型改造，以及 Web UI 设置卡片的需求。编程 Agent 应结合 v1 文档与本文档共同阅读。

---

## 1. 变更动机

v1 文档中，provider 配置直接内嵌平台模板信息：

```yaml
providers:
  zenmux-provider:
    platform: zenmux
    managementKeyRef: ...
    managementKey: ...
    platformBaseURL: ...
```

问题：

1. “platform 模板”（如何处理 ZenMux 的错误识别、统计抓取、等待目标计算）和“platform 实例值”（Key、baseURL、resumeNotice 等）被绑定在同一个对象中。
2. 多个使用同一家 LLM 服务提供商的 provider，其套餐不同，却共同使用着一个 platform 模板，其可用额度将受到最小额度套餐的限制。
3. `resumeNotice`、`statsRetry` 等本应属于某个平台实例的字段，被放在了全局或 provider 下。

v2 改为三层模型：**平台模板生成平台实例，provider 绑定到平台实例。**

---

## 2. 概念模型

```
Platform Adapter（平台模板）
  └─ type: "zenmux"
  └─ 代码级能力：错误识别、统计抓取、等待目标计算
  └─ v1 仅内置 zenmux 一个模板

Platform Instance（平台实例）
  └─ id: 用户定义，如 "zenmux-main"
  └─ type: 由哪个模板生成，如 "zenmux"
  └─ 实例值：managementKeyRef / managementKey
  └─ 实例值：resumeNotice
  └─ 实例值：statsRetry / postResetRetry / resetBufferMs
  └─ 实例值：与账号、恢复策略、提示偏好相关的全部字段

Provider（DSH 中的 LLM 路由）
  └─ provider-id，如 "zenmux-provider"
  └─ 通过 providerBindings 绑定到某个 platform instance
  └─ 一个 provider 只能绑定一个 instance
  └─ 一个 instance 可以被多个 provider 绑定
```

### 2.1 关于“全局字段”

用户确认：**除对实例无意义的字段外，其余字段都挪进实例。**

- 挪进实例：`managementKeyRef`、`managementKey`、`resumeNotice`、`statsRetry`、`postResetRetry`、`resetBufferMs`。
- 留在全局：`platformBaseURL`（平台 URL 由平台模板决定，对某个实例没有区分意义；v1 仅 ZenMux 官方地址）。

### 2.2 关于“cordis 配置 / base 层 / user 层”

DSH 设置服务对每个 namespace 的值按以下顺序解析：

1. schema 默认值；
2. **base 层**：插件在 `cordis.yml` 中的 `config`；
3. **user 层**：用户在 UI 中的修改（持久化到 `settings.yaml`）。

UI 写入的只是 user 层；UI 的“删除”实际是清除 user 层，清除后会露出 base 层。

因此：

- 如果实例定义在 `cordis.yml`（base 层），UI 无法真正删除它，只能清除用户覆盖；
- 用户决策：**默认空实例**。`cordis.yml` 中默认 `platformInstances: {}`、`providerBindings: {}`，所有实例都由用户在 UI 中手动新建。这样实例全部在 user 层，UI 可以真正增删改。
- 如高级用户手工在 `cordis.yml` 中预置实例，UI 删除只能清除用户覆盖，不能删除 base 实例（该场景作为高级用法，v1 UI 不做特殊展示）。

---

## 3. 配置结构变更

### 3.1 v1 旧配置（已实现，将被替换）

```yaml
- name: '@deepseek-ai/dsh-auto-continue'
  config:
    providers:
      zenmux-provider:
        platform: zenmux
        managementKeyRef: ZENMUX_MANAGEMENT_API_KEY
        # managementKey: sk-xxxx
        # platformBaseURL: https://zenmux.ai
    resumeNotice:
      enabled: false
      template: "因额度限制，本次请求等待了 {hours} 小时 {minutes} 分钟后重新发送。"
    statsRetry:
      initialDelayMs: 60000
      maxDelayMs: 900000
      totalTimeoutMs: 3600000
    statsRequestTimeoutMs: 30000
    postResetRetry:
      delaysMs: [60000, 120000, 240000, 480000, 900000]
    resetBufferMs: 5000
```

### 3.2 v2 新配置

```yaml
- name: '@deepseek-ai/dsh-auto-continue'
  config:
    # 全局字段：v1 仅此一个
    platformBaseURL: https://zenmux.ai

    # 平台实例集合，默认空
    platformInstances:
      zenmux-main:
        type: zenmux
        managementKeyRef: ZENMUX_MANAGEMENT_API_KEY   # schema 支持；v1 UI 不展示
        managementKey: sk-xxxx                         # v1 UI 以明文 secret 编辑
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

    # provider 绑定集合，默认空
    providerBindings:
      zenmux-provider: zenmux-main
```

### 3.3 字段说明

#### 全局字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `platformBaseURL` | string | `"https://zenmux.ai"` | 平台 API base URL。v1 全局唯一，不在实例中 |

#### `platformInstances`（map，默认 `{}`）

键为实例 id，建议 lowercase kebab：`^[a-z][a-z0-9-]*$`。

每个实例：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `type` | string | `"zenmux"` | 平台模板标识。v1 仅支持 `zenmux` |
| `managementKeyRef` | string | 无 | 管理密钥引用（环境变量名/凭据存储引用）。schema 支持，**v1 UI 不展示** |
| `managementKey` | string | 无 | 明文管理密钥。**v1 UI 以明文 secret 编辑**，不回显 |
| `resumeNotice.enabled` | boolean | `false` | 是否在重发前注入提示 |
| `resumeNotice.template` | string | 见 v1 | 提示模板，支持 `{provider}`、`{hours}`、`{minutes}` |
| `statsRetry.initialDelayMs` | number | `60000` | 统计接口失败后首次退避等待 |
| `statsRetry.maxDelayMs` | number | `900000` | 统计接口失败退避单次上限 |
| `statsRetry.totalTimeoutMs` | number | `3600000` | 统计接口失败退避总时长上限 |
| `postResetRetry.delaysMs` | number[] | `[60000, 120000, 240000, 480000, 900000]` | 重置后宽容重试的等待序列 |
| `resetBufferMs` | number | `5000` | 等待 `resets_at` 的缓冲时间 |

#### `providerBindings`（map，默认 `{}`）

- 键：provider-id（DSH LLM 路由名）。
- 值：platform instance id。
- 一个 provider 只能绑定一个 instance。
- 一个 instance 可被多个 provider 绑定。
- 值为空或未出现在 `platformInstances` 中：配置校验失败。

---

## 4. 运行时行为变更

| 项 | v1 | v2 |
|---|---|---|
| 恢复状态、`disabled`、统计查询单飞 | 按 provider | 按 platform instance |
| provider 未绑定 instance | 不适用 | 不处理，`next()` |
| instance 无 Key（`managementKeyRef` 与 `managementKey` 均为空） | 不适用 | 该 instance 下所有 provider 不自动续跑 |
| 错误识别 | provider → 平台模板 | provider → binding → instance → instance.type 对应 adapter |
| 等待/重试 | 按 provider | 按 instance；同 instance 的多个 provider 共享同一恢复状态 |
| `quota/changed` 事件 | 按 provider | 按 instance；payload 携带 instance id 与受影响的 provider 列表 |
| `resumeNotice` | 全局 | 按 instance |
| `statsRetry` / `postResetRetry` / `resetBufferMs` | 全局 | 按 instance |

### 4.1 设置变更语义

- `resumeNotice` 修改：即时生效，下一次重发提示按新配置。
- `statsRetry` / `postResetRetry` / `resetBufferMs` 修改：对新启动的恢复 episode 生效；进行中的 episode 不中断。
- 新增/删除 instance 或修改绑定：下一次 402 判断时生效。
- 删除 instance：进行中的等待不中断；该 instance 下 provider 的新 402 按删除后的绑定处理（无绑定则 `next()`）。
- 修改 `managementKey` / `managementKeyRef`：下一次统计查询时生效。

---

## 5. Web UI 设置卡片需求

### 5.1 位置

设置弹窗 → **Plugins** → **Plugin configuration** 标签页。卡片名：**自动续跑 / Auto Continue**。

### 5.2 整体布局（仿 DSH【模型】设置页）

- 页面主体是一个**实例卡片列表**。
- 每个实例卡片展示摘要信息：
  - 卡片标题：实例 id（或名称）；
  - 元信息：type（如 `zenmux`）、Key 状态（`明文密钥已设置` / `未设置`）、resumeNotice 状态（`提示开启` / `提示关闭`）。
- 卡片右部有两个按钮：
  - **编辑按钮（左）**；
  - **删除按钮（右）**。
- 点击编辑按钮，该卡片**展开**为可编辑表单。
- 列表下方有一个**新增按钮**，点击后在列表下方新增一个处于编辑态的空白实例卡片。
- 编辑态底部有 **保存** 与 **取消** 按钮。

### 5.3 实例编辑表单

| 字段 | 控件 | 说明 |
|---|---|---|
| id | 文本输入 | 新建时可编辑；已有实例只读 |
| type | 下拉框 | v1 仅 `zenmux` |
| managementKey | 密码输入框 | v1 明文 secret；不回显已有值；留空表示不修改 |
| resumeNotice.enabled | Switch | 默认关 |
| resumeNotice.template | 文本输入 | 占位符说明显示在下方 |
| statsRetry.initialDelayMs | 数字输入 | 默认 60000 |
| statsRetry.maxDelayMs | 数字输入 | 默认 900000 |
| statsRetry.totalTimeoutMs | 数字输入 | 默认 3600000 |
| postResetRetry.delaysMs | 文本输入 | 逗号分隔的毫秒序列；示例：`60000,120000,240000,480000,900000` |
| resetBufferMs | 数字输入 | 默认 5000 |
| provider 绑定 | 多选下拉/勾选列表 | 选项来自 `ctx.remote.llm.listProviders()`；一个 provider 只能被一个 instance 绑定 |

### 5.4 Provider 绑定交互

- 实例编辑表单内提供 **Provider 绑定** 多选控件。
- 选项为当前已注册的 provider 列表（来自 `ctx.remote.llm.listProviders()`）。
- 一个 provider 只能被一个实例绑定，交互规则如下：
  - 未绑定的 provider 可被任意实例勾选；
  - 已绑定的 provider 只在绑定它的实例的列表中可见，并可取消勾选（取消即解绑）；
  - 在其它实例的列表中，该 provider **不出现**（v1 为降低实现难度选择隐藏；后续如需要可改为置灰展示）。
- 保存时，UI 需要把本次编辑的实例与 provider 勾选结果合并，写入 `providerBindings`。

### 5.5 删除实例

- 删除前弹出确认。
- 若该实例仍绑定 provider，确认文案需提示：删除后这些 provider 将不再自动续跑（即同时解绑）。
- 确认后执行删除并清理解绑（见第 8 节已确认决策）。

### 5.6 空状态

- `platformInstances` 为空时，列表区显示空状态文案，引导用户点击“新增”创建第一个实例。

### 5.7 v1 UI 不做

- 不展示/编辑 `managementKeyRef`（schema 保留，UI 不显示）。
- 不展示全局 `platformBaseURL`（保留默认或 cordis.yml 配置）。
- 不展示实例的实时运行状态（如 waiting-reset 倒计时）。
- 不做凭据存储集成。

---

## 6. Host 侧改动（`packages/llm/auto-continue`）

1. Config schema 重构为 v2 结构（`platformBaseURL` + `platformInstances` + `providerBindings`）。
2. 注册 settings namespace `auto-continue`：
   - 使用 `installSettingsSection(ctx, 'auto-continue', Config, entryConfig, { setSource, onChange, validate })`；
   - `managementKey` 标记 `role('secret')`，settings 描述符/响应中不返回其值；
   - `cordis.yml` 的 `config` 作为 base 层。
3. 跨字段 `validate`：
   - 实例 id 格式合法；
   - 实例 `type` 必须是已注册平台模板（v1 仅 `zenmux`）；
   - `managementKeyRef` 与 `managementKey` 不能同时非空；
   - `providerBindings` 的每个值必须指向存在的实例；
   - `postResetRetry.delaysMs` 非空数组且元素为正整数；
   - `statsRetry` 三字段为正整数。
4. `QuotaRuntime` 状态机改为按实例键控：
   - `status(instanceId)`、`isDisabled(instanceId)`；
   - 保留 `statusForProvider(providerId)` 作为调试/查询便捷方法；
   - 恢复监听器：provider → binding → instance → adapter。
5. `quota/changed` 事件改为按实例发布，payload 含 instance id、状态、受影响的 provider 列表。
6. 设置变更按第 4.1 节语义生效。

---

## 7. Client 侧新包

- 路径：`packages/client/ui-settings-auto-continue`
- npm 名：`@deepseek-ai/dsh-client-ui-auto-continue`
- 声明 `dsh.client`（Web 平台）
- 注入依赖：`slots`、`locale`、`connection`、`remote`、`settingsScope`
- 注册 `settings.plugin.item`，key = `auto-continue`
- Provider 列表数据源：`ctx.remote.llm.listProviders()`
- 卡片自绘 CRUD 表单（不使用 `ui-settings-plugins` 的扁平 `CardForm`，需要路径级 `settingsScope.mutate`）
- 需要 zh/en locale

---

## 8. 已确认决策

1. 删除已绑定实例：确认后删除实例，并同时解绑其下所有 provider。
2. Provider 绑定控件形态：实例编辑表单内多选下拉/勾选列表；已绑定 provider 仅在绑定实例中可见/可取消，其他实例列表中隐藏。
3. `managementKeyRef`：schema 与 cordis.yml 仍支持，但 v1 UI 不展示。
4. `platformBaseURL`：v1 UI 不展示，保留全局默认。
5. 本补充文档与 v1 文档冲突时，以本文档为准。

---

## 9. 测试与验收补充

### 单元/集成测试

- Config 解析：
  - 新配置可解析；默认空实例；
  - `providerBindings` 指向不存在实例时校验失败；
  - `managementKeyRef` 与 `managementKey` 同时非空时校验失败；
  - `type` 非 `zenmux` 时校验失败。
- 运行时：
  - provider 未绑定 → `next()`；
  - provider 绑定实例无 Key → `next()`；
  - 同实例多 provider 共享恢复状态；
  - `disabled` 按实例生效，影响该实例下所有 provider；
  - 删除实例后新 402 按无绑定处理，in-flight 等待不中断。
- `quota/changed` 事件按实例发布。

### UI 测试

- 空状态展示；
- 新增实例：列表下方出现编辑态空白卡片；
- 编辑实例：展开表单，保存后卡片摘要更新；
- 删除实例：确认弹窗，删除后卡片消失；
- Provider 绑定：下拉选项来自 `remote.llm.listProviders()`；同一 provider 只能绑定一个实例；已绑定 provider 在其它实例列表中不出现；保存后 `providerBindings` 正确。
- `managementKey` 不回显，留空不修改。

### 验收标准

以下为 v1 文档第 18 节验收标准与 v2 增量的合并；v1 中与 v2 冲突的条目以本文档为准。

**通用（沿用 v1）**

1. 所有单元/集成/UI 测试通过。
2. 插件包可独立构建、发布，`dsh plugin add` / `--patch` 可启用。
3. 除本包及新增 client 包外，不修改 DSH 仓库其他包源码。
4. 配置字段均有 schema 校验与默认值；非法配置 fail loud。
5. 所有等待可取消；插件卸载后无残留 timer / 进行中的自动续跑任务。
6. `quota/changed` 事件按 v2 语义（按实例）发布。
7. README 说明配置方式、示例 overlay、限制与未来扩展点。

**恢复行为（沿用 v1 核心，适配 v2 实例维度）**

8. 对绑定到已配置 Key 的实例的 provider，ZenMux 402 `quote_exceeded` 可自动等待并续跑。
9. 未绑定实例、实例无 Key、非配额耗尽错误：行为与未安装插件一致。
10. 统计接口失败退避、1h 后 disabled、等待重置、post-reset 宽容重试等流程行为符合 v1 文档第 12 节，仅维度从 provider 改为 instance。

**v2 新增**

11. 配置结构为 `platformInstances` + `providerBindings` + 全局 `platformBaseURL`；默认空实例。
12. 同实例多 provider 共享恢复状态；`disabled` 按实例影响其下所有 provider。
13. UI 卡片可独立构建并随插件启用而出现；实例 CRUD、provider 绑定交互符合本文档第 5 节。
14. 删除实例、修改绑定等设置变更语义符合本文档第 4.1 节。
