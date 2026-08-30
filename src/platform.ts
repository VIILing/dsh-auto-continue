import type { LlmFailure } from '@deepseek-ai/dsh-llm'

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

/**
 * 平台配额适配器接口：任何能提供配额统计接口的 LLM 服务商，实现并注册本接口
 * 即可复用同一套恢复状态机。
 */
export interface PlatformQuotaAdapter {
  readonly platform: string

  /** 判断一个 LlmFailure 是否为本平台的“配额耗尽”错误。 */
  matchesQuotaExhausted(failure: LlmFailure): boolean

  /** 请求平台统计接口，返回归一化快照。 */
  fetchQuota(
    credential: string,
    baseURL: string,
    signal: AbortSignal,
  ): Promise<PlatformQuotaSnapshot>

  /** 根据归一化快照计算“重置时刻”时间戳（epoch ms）；无法计算时返回 null。 */
  resolveWaitTarget(snapshot: PlatformQuotaSnapshot): number | null
}

/** 窗口耗尽判定：`usage_percentage >= 1` 或 `remaining_flows <= 0`（或关系）。 */
export function isWindowExhausted(window: QuotaWindow): boolean {
  return window.usagePercentage >= 1 || window.remainingFlows <= 0
}

/** 快照中是否存在任一已耗尽窗口。 */
export function isSnapshotExhausted(snapshot: PlatformQuotaSnapshot): boolean {
  return snapshot.windows.some(isWindowExhausted)
}
