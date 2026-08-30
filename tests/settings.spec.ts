import { Context } from '@deepseek-ai/cordis'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QuotaRuntime from '../src/index.ts'
import type { Config, PlatformInstanceConfig } from '../src/config.ts'

const NS = settingsNamespace('auto-continue')

/** 内存版 settings provider，用于测试 settings 变更语义。 */
class MemorySettingsProvider extends SettingsProvider {
  private doc: Record<string, unknown> = {}
  get writable(): boolean {
    return true
  }
  protected async load(): Promise<Record<string, unknown>> {
    return this.doc
  }
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = section
  }
}

function makeInstance(overrides: Partial<PlatformInstanceConfig> = {}): PlatformInstanceConfig {
  return {
    type: 'zenmux',
    managementKey: 'test-key',
    resumeNotice: { enabled: false, template: '{hours} 小时 {minutes} 分钟' },
    statsRetry: { initialDelayMs: 10, maxDelayMs: 20, totalTimeoutMs: 100 },
    postResetRetry: { delaysMs: [10, 20, 40] },
    resetBufferMs: 5000,
    ...overrides,
  }
}

function baseConfig(): Config {
  return { platformBaseURL: 'https://zenmux.ai', platformInstances: {}, providerBindings: {} }
}

function failure(message: string): LlmFailure {
  return { message, code: 'QUOTA' }
}

function statsBody(resetsAt: string): Record<string, unknown> {
  return {
    success: true,
    data: {
      quota_5_hour: { usage_percentage: 1, remaining_flows: 0, resets_at: resetsAt },
      quota_7_day: { usage_percentage: 0.5, remaining_flows: 100, resets_at: resetsAt },
    },
  }
}

function makePayload(provider: string, failure: LlmFailure) {
  return {
    agent: {} as never,
    turn: 1,
    step: 1,
    provider,
    failure,
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }
}

async function waitForNamespace(ctx: Context, ns: SettingsNamespace): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (ctx.settings.get(ns) !== undefined) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`settings namespace "${ns}" not registered`)
}

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemorySettingsProvider)
  await ctx.plugin(QuotaRuntime, baseConfig())
  await waitForNamespace(ctx, NS)
  return ctx
}

describe('v2 settings 变更语义', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('通过 settings 新增实例与绑定 → status/statusForProvider 反映', async () => {
    const ctx = await mount()
    await ctx.settings.update(NS, {
      platformInstances: { 'zm': makeInstance() },
      providerBindings: { 'p1': 'zm' },
    })

    expect(ctx.quota.status('zm')).toEqual({ phase: 'idle' })
    expect(ctx.quota.statusForProvider('p1')).toEqual({ phase: 'idle' })
    expect(ctx.quota.statusForProvider('unbound')).toEqual({ phase: 'unconfigured' })
  })

  it('解绑 provider 后新 402 → next()，不查询统计', async () => {
    const ctx = await mount()
    await ctx.settings.update(NS, {
      platformInstances: { 'zm': makeInstance() },
      providerBindings: { 'p1': 'zm' },
    })

    // 解绑：replace 会整体重置 user 层。
    await ctx.settings.replace(NS, { platformInstances: {}, providerBindings: {} })

    const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const next = vi.fn(async () => undefined as RequestErrorAction)
    const action = await ctx.waterfall('agent/request-error', makePayload('p1', failure('quote_exceeded')), next)
    expect(action).toBeUndefined()
    expect(next).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('跨字段校验：写入指向不存在实例的绑定被拒绝', async () => {
    const ctx = await mount()
    await expect(
      ctx.settings.update(NS, { providerBindings: { 'p1': 'missing-instance' } }),
    ).rejects.toThrow(/missing instance/)
  })

  it('删除实例后 in-flight 等待不中断（等待仍完成并返回 retry）', async () => {
    // 挂载与写入用真实计时器（waitForNamespace 依赖 setTimeout）。
    const ctx = await mount()
    await ctx.settings.update(NS, {
      platformInstances: { 'zm': makeInstance() },
      providerBindings: { 'p1': 'zm' },
    })

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-24T08:00:00.000Z'))
    try {
      const resetsAt = new Date(Date.now() + 100000).toISOString()
      vi.stubGlobal('fetch', vi.fn(async () => ({
        status: 200,
        json: async () => statsBody(resetsAt),
      })))

      const next = vi.fn(async () => undefined as RequestErrorAction)
      const promise = ctx.waterfall('agent/request-error', makePayload('p1', failure('quote_exceeded')), next)
      await vi.advanceTimersByTimeAsync(0) // 统计查询完成，进入等待

      // 删除实例（解绑 + 删实例）；in-flight 等待不应中断。
      await ctx.settings.replace(NS, { platformInstances: {}, providerBindings: {} })

      await vi.advanceTimersByTimeAsync(100000 + 5000)
      const action = await promise
      expect(action).toEqual({ kind: 'retry' })
      expect(next).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
