import { describe, expect, it } from 'vitest'
import type { PlatformQuotaAdapter, PlatformQuotaSnapshot, QuotaWindow } from '../src/platform.ts'
import { decideWaitAction } from '../src/recovery.ts'
import { computeStatsRetryDelays, parseResetsAt } from '../src/state.ts'

function window(name: string, usage: number, remaining: number, resetsAt: string | null): QuotaWindow {
  return { name, usagePercentage: usage, remainingFlows: remaining, resetsAt }
}

function snapshot(...windows: QuotaWindow[]): PlatformQuotaSnapshot {
  return { windows }
}

describe('computeStatsRetryDelays', () => {
  it('60s 初始，翻倍，900s 封顶，1h 总时长', () => {
    const delays = computeStatsRetryDelays(60000, 900000, 3600000)
    expect(delays).toEqual([60000, 120000, 240000, 480000, 900000, 900000, 900000])
    expect(delays.reduce((a, b) => a + b, 0)).toBe(3600000)
  })

  it('最后一次退避裁剪到剩余时间', () => {
    const delays = computeStatsRetryDelays(60000, 900000, 60000)
    expect(delays).toEqual([60000])
  })

  it('自定义参数', () => {
    const delays = computeStatsRetryDelays(1000, 10000, 35000)
    expect(delays).toEqual([1000, 2000, 4000, 8000, 10000, 10000])
  })
})

describe('parseResetsAt', () => {
  it('解析 ISO 字符串', () => {
    expect(parseResetsAt('2026-03-24T13:00:00.000Z')).toBe(Date.parse('2026-03-24T13:00:00.000Z'))
  })
  it('null / undefined → null', () => {
    expect(parseResetsAt(null)).toBeNull()
    expect(parseResetsAt(undefined)).toBeNull()
  })
  it('非法字符串 → null', () => {
    expect(parseResetsAt('not-a-date')).toBeNull()
  })
})

describe('decideWaitAction', () => {
  const NOW = Date.parse('2026-03-24T08:00:00.000Z')
  const future5h = '2026-03-24T13:00:00.000Z'

  function adapterWithResetAt(ms: number | null): PlatformQuotaAdapter {
    return {
      platform: 'test',
      matchesQuotaExhausted: () => true,
      fetchQuota: async () => { throw new Error('not used') },
      resolveWaitTarget: () => ms,
    }
  }

  it('耗尽且未来 → waiting-reset（含 buffer）', () => {
    const decision = decideWaitAction({
      snapshot: snapshot(window('5h', 1, 0, future5h)),
      adapter: adapterWithResetAt(Date.parse(future5h)),
      now: NOW,
      resetBufferMs: 5000,
      episodeWaitedReset: false,
    })
    expect(decision).toEqual({ type: 'waiting-reset', resetAt: Date.parse(future5h) + 5000 })
  })

  it('未耗尽 + 未来 + 首次错误（统计滞后）→ waiting-reset', () => {
    const decision = decideWaitAction({
      snapshot: snapshot(window('5h', 0.5, 10, future5h)),
      adapter: adapterWithResetAt(Date.parse(future5h)),
      now: NOW,
      resetBufferMs: 5000,
      episodeWaitedReset: false,
    })
    expect(decision.type).toBe('waiting-reset')
  })

  it('未耗尽 + 未来 + 已等待过 reset（重入）→ post-reset', () => {
    const decision = decideWaitAction({
      snapshot: snapshot(window('5h', 0.5, 10, future5h)),
      adapter: adapterWithResetAt(Date.parse(future5h)),
      now: NOW,
      resetBufferMs: 5000,
      episodeWaitedReset: true,
    })
    expect(decision.type).toBe('post-reset')
  })

  it('耗尽但 resetsAt 已过去 → post-reset', () => {
    const past = '2026-03-24T07:00:00.000Z'
    const decision = decideWaitAction({
      snapshot: snapshot(window('5h', 1, 0, past)),
      adapter: adapterWithResetAt(Date.parse(past)),
      now: NOW,
      resetBufferMs: 5000,
      episodeWaitedReset: false,
    })
    expect(decision.type).toBe('post-reset')
  })

  it('关键信息缺失 → missing-info', () => {
    const decision = decideWaitAction({
      snapshot: snapshot(window('5h', 1, 0, future5h)),
      adapter: adapterWithResetAt(null),
      now: NOW,
      resetBufferMs: 5000,
      episodeWaitedReset: false,
    })
    expect(decision).toEqual({ type: 'missing-info' })
  })
})
