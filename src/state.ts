import { instanceHasCredential, type PlatformInstanceConfig } from './config.ts'
import type { StatsFetchResult } from './recovery.ts'

/** 公开的 instance 状态快照（v2 维度从 provider 改为 instance）。 */
export type QuotaInstanceState =
  | { phase: 'unconfigured' }
  | { phase: 'idle' }
  | { phase: 'checking-stats' }
  | { phase: 'waiting-reset'; resetAt: number }
  | { phase: 'post-reset-retrying'; attempts: number }
  | { phase: 'disabled' }

/** 每个 platform instance 的内存运行时状态（§11.3，v2 按 instance 键控）。 */
export interface InstanceRuntimeState {
  instanceId: string
  /** 当前相位。 */
  phase: QuotaInstanceState
  /** 本 episode 是否已经历过一次 waiting-reset 等待。 */
  episodeWaitedReset: boolean
  /** 本 episode 是否已追加 resumeNotice。 */
  noticeAppended: boolean
  /** 本 episode 已消耗的 post-reset 重试次数（跨相位持久）。 */
  postResetAttempts: number
  /** 单飞统计查询的 in-flight promise；null 表示当前无查询。 */
  statsFlight: Promise<StatsFetchResult> | null
}

/** 创建一个 instance 状态；未配置凭据时为 `unconfigured`。 */
export function createInstanceState(
  instanceId: string,
  instance: PlatformInstanceConfig,
): InstanceRuntimeState {
  return {
    instanceId,
    phase: instanceHasCredential(instance) ? { phase: 'idle' } : { phase: 'unconfigured' },
    episodeWaitedReset: false,
    noticeAppended: false,
    postResetAttempts: 0,
    statsFlight: null,
  }
}

/** 重置 episode 级标志（新 episode 开始时调用）。 */
export function beginEpisode(state: InstanceRuntimeState): void {
  state.episodeWaitedReset = false
  state.noticeAppended = false
  state.postResetAttempts = 0
}

/** 计算统计接口退避序列（§6.2.3）。用于测试与实现。 */
export function computeStatsRetryDelays(
  initialDelayMs: number,
  maxDelayMs: number,
  totalTimeoutMs: number,
): number[] {
  const delays: number[] = []
  let delay = initialDelayMs
  let remaining = totalTimeoutMs
  while (remaining > 0) {
    const wait = Math.min(delay, maxDelayMs, remaining)
    delays.push(wait)
    remaining -= wait
    delay = Math.min(delay * 2, maxDelayMs)
  }
  return delays
}

/** 解析 ISO 时间到 epoch ms；解析失败返回 null。 */
export function parseResetsAt(resetsAt: string | null | undefined): number | null {
  if (resetsAt == null) return null
  const ms = Date.parse(resetsAt)
  return Number.isNaN(ms) ? null : ms
}
