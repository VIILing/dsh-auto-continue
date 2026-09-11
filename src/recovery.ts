import type { PlatformInstanceConfig, StatsRetryConfig } from './config.ts'
import {
  isExhaustedBy,
  type PlatformQuotaAdapter,
  type PlatformQuotaSnapshot,
} from './platform.ts'

/** 统计查询单飞的结果。 */
export type StatsFetchResult =
  | { ok: true; snapshot: PlatformQuotaSnapshot }
  | { ok: false; aborted: boolean }

export type WaitActionDecision =
  | { type: 'missing-info' }
  | { type: 'waiting-reset'; resetAt: number }
  | { type: 'post-reset' }

export interface FetchStatsOptions {
  adapter: PlatformQuotaAdapter
  credential: string
  baseURL: string
  instance: PlatformInstanceConfig
  statsRetry: StatsRetryConfig
  statsRequestTimeoutMs: number
  logger: {
    warn: (format: string, ...args: unknown[]) => void
  }
  lifetimeSignal: AbortSignal
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.name === 'TimeoutError'
  }
  return false
}

/**
 * 可取消等待：等待 `ms` 毫秒，任一信号触发后拒绝（AbortError）。
 */
export function abortableDelay(ms: number, ...signals: AbortSignal[]): Promise<void> {
  const active = signals.filter((s) => s !== undefined)
  const combined = active.length > 0 ? AbortSignal.any(active) : new AbortController().signal
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve()
      return
    }
    if (combined.aborted) {
      reject(combined.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      combined.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(combined.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    combined.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchOnce(
  adapter: PlatformQuotaAdapter,
  credential: string,
  baseURL: string,
  instance: PlatformInstanceConfig,
  requestTimeoutMs: number,
  lifetimeSignal: AbortSignal,
): Promise<PlatformQuotaSnapshot> {
  const signal = AbortSignal.any([lifetimeSignal, AbortSignal.timeout(requestTimeoutMs)])
  return adapter.fetchQuota({ credential, baseURL, instance, signal })
}

/**
 * 统计接口查询（含指数退避重试，§12.4）。首次立即请求；失败后按
 * 60s→120s→… 退避（单次上限 maxDelayMs，总上限 totalTimeoutMs），1 小时后
 * 仍失败返回 `{ ok: false }`。查询只受 lifetime signal 控制，不被单个 turn 取消
 * （单飞查询跨调用方共享）。
 */
export async function fetchStatsWithRetry(options: FetchStatsOptions): Promise<StatsFetchResult> {
  const { adapter, credential, baseURL, instance, statsRetry, statsRequestTimeoutMs, logger, lifetimeSignal } = options
  const { initialDelayMs, maxDelayMs, totalTimeoutMs } = statsRetry
  const deadline = Date.now() + totalTimeoutMs
  let delay = initialDelayMs

  try {
    const snapshot = await fetchOnce(
      adapter, credential, baseURL, instance, statsRequestTimeoutMs, lifetimeSignal,
    )
    return { ok: true, snapshot }
  } catch (error) {
    if (isAbortError(error)) return { ok: false, aborted: true }
    logger.warn('dsh-auto-continue: stats fetch failed: %s', String(error))
  }

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, aborted: false }
    const wait = Math.min(delay, maxDelayMs, remaining)
    try {
      await abortableDelay(wait, lifetimeSignal)
    } catch {
      return { ok: false, aborted: true }
    }
    delay = Math.min(delay * 2, maxDelayMs)

    try {
      const snapshot = await fetchOnce(
        adapter, credential, baseURL, instance, statsRequestTimeoutMs, lifetimeSignal,
      )
      return { ok: true, snapshot }
    } catch (error) {
      if (isAbortError(error)) return { ok: false, aborted: true }
      logger.warn('dsh-auto-continue: stats fetch failed: %s', String(error))
    }
  }
}

/**
 * 根据统计快照决定下一步动作（§10.4 / §12.3 / §12.5）：
 * - 关键信息缺失 → `missing-info`；
 * - 等待目标在未来（且“首次错误”或“确实耗尽”）→ `waiting-reset`；
 * - 否则 → `post-reset`。
 *
 * `episodeWaitedReset` 用于区分“首次错误”（§12.3 的两窗口未满仍等 5h reset）
 * 与“post-reset 重入”（§12.5 的统计可用 → 宽容退避）。
 */
export function decideWaitAction(options: {
  snapshot: PlatformQuotaSnapshot
  adapter: PlatformQuotaAdapter
  now: number
  resetBufferMs: number
  episodeWaitedReset: boolean
}): WaitActionDecision {
  const { snapshot, adapter, now, resetBufferMs, episodeWaitedReset } = options
  const resetsAtMs = adapter.resolveWaitTarget(snapshot)
  if (resetsAtMs === null) return { type: 'missing-info' }

  const waitTarget = resetsAtMs + resetBufferMs
  // 耗尽口径优先由平台适配器决定（isExhausted），否则用通用默认口径。
  const exhausted = isExhaustedBy(adapter, snapshot)
  const shouldWaitReset = waitTarget > now && (exhausted || !episodeWaitedReset)

  if (shouldWaitReset) return { type: 'waiting-reset', resetAt: waitTarget }
  return { type: 'post-reset' }
}
