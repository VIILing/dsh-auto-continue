import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import {
  isWindowExhausted,
  type PlatformQuotaAdapter,
  type PlatformQuotaSnapshot,
  type QuotaWindow,
} from '../platform.ts'
import { parseResetsAt } from '../state.ts'

/**
 * v1 只识别 `quote_exceeded`（§9.3）。刻意收窄到 ZenMux 专属措辞，避免误处理
 * 余额类 402（`insufficient_credit` / `reject_no_credit`）。
 */
const ZENMUX_QUOTE_EXCEEDED_PATTERNS = [
  /quote_exceeded/,
  /subscription\s+quota\s+(?:limit|exhausted)/i,
  /reached\s+your\s+subscription\s+quota\s+limit/i,
]

/** 从字符串中识别 ZenMux 402 `quote_exceeded`。 */
export function matchesQuotaExhausted(failure: LlmFailure): boolean {
  const message = failure.message
  if (message.length > 10000) return false
  // 辅助信号：status 存在且不是 402 时不处理。
  if (failure.status !== undefined && failure.status !== 402) return false
  if (ZENMUX_QUOTE_EXCEEDED_PATTERNS.some((p) => p.test(message))) return true
  // JSON 形式：{"error":{"code":"402","type":"quote_exceeded"}}
  if (/"code"\s*:\s*"402"/.test(message) && /"type"\s*:\s*"quote_exceeded"/.test(message)) {
    return true
  }
  return false
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

interface RawWindow {
  usage_percentage?: unknown
  remaining_flows?: unknown
  resets_at?: unknown
}

/** 校验并映射一个窗口；字段缺失/类型错误时抛错（视为统计接口失败）。 */
function mapWindow(name: string, raw: RawWindow | undefined): QuotaWindow {
  if (raw === undefined) {
    throw new Error(`ZenMux stats: missing window "${name}"`)
  }
  if (!isNumber(raw.usage_percentage)) {
    throw new Error(`ZenMux stats: window "${name}" usage_percentage is not a number`)
  }
  if (!isNumber(raw.remaining_flows)) {
    throw new Error(`ZenMux stats: window "${name}" remaining_flows is not a number`)
  }
  const resetsAt = raw.resets_at === null || raw.resets_at === undefined
    ? null
    : typeof raw.resets_at === 'string'
      ? raw.resets_at
      : (() => { throw new Error(`ZenMux stats: window "${name}" resets_at is not a string`) })()

  return {
    name,
    usagePercentage: raw.usage_percentage,
    remainingFlows: raw.remaining_flows,
    resetsAt,
  }
}

/** 解析 ZenMux 统计响应。 */
export function mapSnapshot(body: unknown): PlatformQuotaSnapshot {
  if (typeof body !== 'object' || body === null) {
    throw new Error('ZenMux stats: response is not an object')
  }
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) {
    throw new Error('ZenMux stats: response.data is missing')
  }
  const d = data as { quota_5_hour?: RawWindow; quota_7_day?: RawWindow }
  return {
    windows: [
      mapWindow('5h', d.quota_5_hour),
      mapWindow('7d', d.quota_7_day),
    ],
  }
}

/**
 * v1 ZenMux 等待目标计算（§10.2 / §10.3）：
 * 返回“重置时刻”epoch ms（不含 resetBufferMs），无法计算时返回 null。
 */
export function resolveWaitTarget(snapshot: PlatformQuotaSnapshot): number | null {
  const byName = new Map(snapshot.windows.map((w) => [w.name, w]))
  const w5 = byName.get('5h')
  const w7 = byName.get('7d')

  const exhausted5 = w5 !== undefined && isWindowExhausted(w5)
  const exhausted7 = w7 !== undefined && isWindowExhausted(w7)

  let target: QuotaWindow | undefined
  if (!exhausted7) {
    // 7d 未耗尽：无论 5h 是否耗尽，都等 5h resetsAt。
    target = w5
  } else if (exhausted5) {
    // 7d、5h 都耗尽：max(5h.resetsAt, 7d.resetsAt)。
    target = maxResetsAt(w5, w7)
  } else {
    // 7d 耗尽、5h 未耗尽（理论不应出现，保守处理）：等 7d resetsAt。
    target = w7
  }

  if (target === undefined) return null
  return parseResetsAt(target.resetsAt)
}

function maxResetsAt(a: QuotaWindow | undefined, b: QuotaWindow | undefined): QuotaWindow | undefined {
  const ta = a === undefined ? null : parseResetsAt(a.resetsAt)
  const tb = b === undefined ? null : parseResetsAt(b.resetsAt)
  if (ta === null) return b
  if (tb === null) return a
  return ta >= tb ? a : b
}

/** ZenMux 平台适配器。 */
export class ZenMuxAdapter implements PlatformQuotaAdapter {
  readonly platform = 'zenmux'

  matchesQuotaExhausted(failure: LlmFailure): boolean {
    return matchesQuotaExhausted(failure)
  }

  async fetchQuota(
    credential: string,
    baseURL: string,
    signal: AbortSignal,
  ): Promise<PlatformQuotaSnapshot> {
    const url = `${baseURL.replace(/\/$/, '')}/api/v1/management/subscription/detail`
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${credential}` },
      signal,
    })
    if (response.status !== 200) {
      throw new Error(`ZenMux stats: unexpected HTTP ${response.status}`)
    }
    const body: unknown = await response.json()
    const asAny = body as { success?: unknown }
    if (asAny.success !== true) {
      throw new Error('ZenMux stats: success !== true')
    }
    return mapSnapshot(body)
  }

  resolveWaitTarget(snapshot: PlatformQuotaSnapshot): number | null {
    return resolveWaitTarget(snapshot)
  }
}

export default ZenMuxAdapter
