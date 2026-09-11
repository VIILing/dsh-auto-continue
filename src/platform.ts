import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type Schema from '@deepseek-ai/schemastery'

import type { PlatformInstanceConfig } from './config.ts'

/** 归一化后的单个配额窗口。 */
export interface QuotaWindow {
  /** 窗口标识，如 `'5h'`、`'7d'`。 */
  name: string
  /** 0–1 四位小数；不做 [0,1] 夹取。 */
  usagePercentage: number
  /** 剩余 Flow。 */
  remainingFlows: number
  /** ISO 8601 字符串或 null。 */
  resetsAt: string | null
}

/** 平台配额归一化快照。 */
export interface PlatformQuotaSnapshot {
  windows: QuotaWindow[]
}

/** `fetchQuota` 的调用上下文：适配器需要的全部输入都在这里。 */
export interface QuotaFetchContext {
  /** 实例凭据（managementKey 明文，或 managementKeyRef 的解析结果）。 */
  readonly credential: string
  /** 已解析的平台端点：`instance.baseURL` ?? 全局覆盖（非空时） ?? `adapter.defaultBaseURL`。 */
  readonly baseURL: string
  /** 该实例的完整配置，供平台读取专属参数（`instance.options`）。 */
  readonly instance: PlatformInstanceConfig
  /** 取消信号（插件 lifetime + 单次请求超时）。 */
  readonly signal: AbortSignal
}

/**
 * 平台配额适配器接口：任何能提供配额统计接口的 LLM 服务商，实现并注册本接口
 * 即可复用同一套恢复状态机。
 *
 * 除 `platform` 与三个必需方法外，其余成员都是**可选元数据**，用于让平台成为
 * 一等模板：`label` 让 UI 显示它，`defaultBaseURL` 让它自带端点，
 * `optionsSchema` 让它校验专属参数，`isExhausted` 让它自定义“耗尽”口径。
 */
export interface PlatformQuotaAdapter {
  /** 平台模板标识，即实例配置里的 `type`。 */
  readonly platform: string

  /** UI 展示名；缺省回退到 `platform`。 */
  readonly label?: string

  /** 该平台默认 API 端点；实例可用 `baseURL` 覆盖，全局 `platformBaseURL` 为 legacy 覆盖。 */
  readonly defaultBaseURL?: string

  /** 平台专属参数（`instance.options`）的 schema；声明后写入设置时会 fail loud 校验。 */
  readonly optionsSchema?: Schema<Record<string, unknown>>

  /** 判断一个 LlmFailure 是否为本平台的“配额耗尽”错误。 */
  matchesQuotaExhausted(failure: LlmFailure): boolean

  /** 请求平台统计接口，返回归一化快照。 */
  fetchQuota(context: QuotaFetchContext): Promise<PlatformQuotaSnapshot>

  /** 根据归一化快照计算“重置时刻”时间戳（epoch ms）；无法计算时返回 null。 */
  resolveWaitTarget(snapshot: PlatformQuotaSnapshot): number | null

  /**
   * 覆盖通用“耗尽”判定（默认 `usagePercentage >= 1 || remainingFlows <= 0`）。
   * 平台的耗尽口径无法用归一化数值表达时应实现本方法。
   */
  isExhausted?(snapshot: PlatformQuotaSnapshot): boolean
}

/** 平台模板的公开元信息（供 `/auto-continue/api` 的 `platforms.list` 与 UI 使用）。 */
export interface PlatformDescriptor {
  /** 平台模板标识（= 实例 `type`）。 */
  id: string
  /** UI 展示名。 */
  label: string
}

/** 把适配器投影成 UI 可消费的元信息。 */
export function describePlatform(adapter: PlatformQuotaAdapter): PlatformDescriptor {
  return { id: adapter.platform, label: adapter.label ?? adapter.platform }
}

/** 窗口耗尽判定：`usage_percentage >= 1` 或 `remaining_flows <= 0`（或关系）。 */
export function isWindowExhausted(window: QuotaWindow): boolean {
  return window.usagePercentage >= 1 || window.remainingFlows <= 0
}

/** 快照中是否存在任一已耗尽窗口（通用默认口径）。 */
export function isSnapshotExhausted(snapshot: PlatformQuotaSnapshot): boolean {
  return snapshot.windows.some(isWindowExhausted)
}

/** 平台视角的耗尽判定：优先用适配器的自定义口径，否则用通用默认口径。 */
export function isExhaustedBy(adapter: PlatformQuotaAdapter, snapshot: PlatformQuotaSnapshot): boolean {
  return adapter.isExhausted?.(snapshot) ?? isSnapshotExhausted(snapshot)
}
