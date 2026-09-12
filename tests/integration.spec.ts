import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QuotaRuntime from '../src/index.ts'
import type { Config, PlatformInstanceConfig } from '../src/config.ts'
import { QUOTE_EXCEEDED_BODY, piAiFlattenedMessage } from './platforms/zenmux-402-sample.ts'

const NOW = new Date('2026-03-24T08:00:00.000Z')

function failure(message: string, status?: number): LlmFailure {
  return { message, code: 'QUOTA', ...(status === undefined ? {} : { status }) }
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

function makeConfig(
  instances: Record<string, PlatformInstanceConfig> = { 'zenmux-main': makeInstance() },
  bindings: Record<string, string> = { 'zenmux-provider': 'zenmux-main' },
  overrides: Partial<Config> = {},
): Config {
  return {
    platformBaseURL: 'https://zenmux.ai',
    platformInstances: instances,
    providerBindings: bindings,
    ...overrides,
  }
}

function makePayload(
  provider: string,
  failure: LlmFailure,
  agent?: Agent,
  signal?: AbortSignal,
) {
  return {
    agent: agent ?? ({} as unknown as Agent),
    turn: 1,
    step: 1,
    provider,
    failure,
    retryPolicy: undefined,
    signal: signal ?? new AbortController().signal,
  }
}

function statsBody(resetsAt: string, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      quota_5_hour: { usage_percentage: 1, remaining_flows: 0, resets_at: resetsAt },
      quota_7_day: { usage_percentage: 0.5, remaining_flows: 100, resets_at: resetsAt },
      ...overrides,
    },
  }
}

function stubFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => body })))
}

function makeRecordingAgent() {
  const appended: Array<{ type: string; data: unknown; opts: unknown }> = []
  const agent = {
    id: 'agent-1',
    options: {},
    session: {
      append: (type: string, data: unknown, opts: unknown) => {
        appended.push({ type, data, opts })
        return { type, data, seq: appended.length, time: Date.now() }
      },
    },
  } as unknown as Agent
  return { agent, appended }
}

async function mount(config: Config): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(QuotaRuntime, config)
  return ctx
}

describe('QuotaRuntime 集成（v2 实例维度）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('402 + 绑定实例 → 等待 resetsAt + buffer 后返回 retry', async () => {
    const resetsAt = new Date(Date.now() + 100000).toISOString()
    stubFetch(statsBody(resetsAt))

    const ctx = await mount(makeConfig())
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('quote_exceeded'))

    const promise = ctx.waterfall('agent/request-error', payload, next)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100000 + 5000)

    const action = await promise
    expect(action).toEqual({ kind: 'retry' })
    expect(next).not.toHaveBeenCalled()
  })

  it('黄金样本全链路：真实 402 文案 + 真实耗尽统计 → 等到 5h 重置后 retry', async () => {
    const goldenStats: unknown = JSON.parse(
      readFileSync(new URL('./fixtures/zenmux-subscription-detail-402.json', import.meta.url), 'utf8'),
    )
    stubFetch(goldenStats)

    const ctx = await mount(makeConfig())
    const next = vi.fn(async () => undefined as RequestErrorAction)
    // 真实链路里 pi-ai 只给出 message/code（无 status），故这里也刻意不带 status。
    const payload = makePayload('zenmux-provider', {
      message: piAiFlattenedMessage(QUOTE_EXCEEDED_BODY),
      code: 'QUOTA',
    })

    const promise = ctx.waterfall('agent/request-error', payload, next)
    await vi.advanceTimersByTimeAsync(0)

    const resets5 = Date.parse('2026-09-12T11:02:38.000Z')
    await vi.advanceTimersByTimeAsync(resets5 + 5000 - NOW.getTime())

    const action = await promise
    expect(action).toEqual({ kind: 'retry' })
    expect(next).not.toHaveBeenCalled()
  })

  it('provider 未绑定 → next()，不查询统计', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = await mount(makeConfig())
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('unbound-provider', failure('quote_exceeded'))

    const action = await ctx.waterfall('agent/request-error', payload, next)
    expect(action).toBeUndefined()
    expect(next).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('绑定实例无 Key → next()，不查询统计', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = await mount(makeConfig({ 'zenmux-main': makeInstance({ managementKey: undefined, managementKeyRef: undefined }) }))
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('quote_exceeded'))

    const action = await ctx.waterfall('agent/request-error', payload, next)
    expect(action).toBeUndefined()
    expect(next).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('非配额错误 → next()，不查询统计', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = await mount(makeConfig())
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('insufficient_credit'))

    const action = await ctx.waterfall('agent/request-error', payload, next)
    expect(action).toBeUndefined()
    expect(next).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('统计接口连续失败 → 退避耗尽后 disabled（按实例），next()', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const ctx = await mount(makeConfig())
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('quote_exceeded'))

    const promise = ctx.waterfall('agent/request-error', payload, next)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)

    const action = await promise
    expect(action).toBeUndefined()
    expect(next).toHaveBeenCalled()
    expect(ctx.quota.isDisabled('zenmux-main')).toBe(true)
    expect(ctx.quota.status('zenmux-main')).toEqual({ phase: 'disabled' })
  })

  it('同实例多 provider 共享 disabled 状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const ctx = await mount(makeConfig(
      { 'zenmux-main': makeInstance() },
      { 'p1': 'zenmux-main', 'p2': 'zenmux-main' },
    ))
    const next = vi.fn(async () => undefined as RequestErrorAction)

    const p1 = ctx.waterfall('agent/request-error', makePayload('p1', failure('quote_exceeded')), next)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    await p1

    // 第二个 provider 因实例 disabled 而直接 next()。
    const next2 = vi.fn(async () => undefined as RequestErrorAction)
    const p2 = ctx.waterfall('agent/request-error', makePayload('p2', failure('quote_exceeded')), next2)
    await vi.advanceTimersByTimeAsync(0)
    const action2 = await p2
    expect(action2).toBeUndefined()
    expect(next2).toHaveBeenCalled()
    expect(ctx.quota.isDisabled('zenmux-main')).toBe(true)
  })

  it('resets_at 缺失 → next() 普通失败，不等待', async () => {
    stubFetch(statsBody('ignored', {
      quota_5_hour: { usage_percentage: 1, remaining_flows: 0, resets_at: null },
      quota_7_day: { usage_percentage: 0.5, remaining_flows: 100, resets_at: null },
    }))

    const ctx = await mount(makeConfig())
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('quote_exceeded'))

    const promise = ctx.waterfall('agent/request-error', payload, next)
    await vi.advanceTimersByTimeAsync(0)

    const action = await promise
    expect(action).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })

  it('resumeNotice 开启 → 返回 retry 前追加一条 user 消息', async () => {
    const resetsAt = new Date(Date.now() + 100000).toISOString()
    stubFetch(statsBody(resetsAt))

    const ctx = await mount(makeConfig({
      'zenmux-main': makeInstance({ resumeNotice: { enabled: true, template: '等了 {hours} 小时 {minutes} 分钟' } }),
    }))
    const { agent, appended } = makeRecordingAgent()
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('quote_exceeded'), agent)

    const promise = ctx.waterfall('agent/request-error', payload, next)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100000 + 5000)

    const action = await promise
    expect(action).toEqual({ kind: 'retry' })
    expect(appended).toHaveLength(1)
    expect(appended[0].type).toBe('user/message')
    expect((appended[0].data as { role: string }).role).toBe('user')
  })

  it('resumeNotice 默认关闭 → 不追加 user 消息', async () => {
    const resetsAt = new Date(Date.now() + 100000).toISOString()
    stubFetch(statsBody(resetsAt))

    const ctx = await mount(makeConfig())
    const { agent, appended } = makeRecordingAgent()
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('quote_exceeded'), agent)

    const promise = ctx.waterfall('agent/request-error', payload, next)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100000 + 5000)

    const action = await promise
    expect(action).toEqual({ kind: 'retry' })
    expect(appended).toHaveLength(0)
  })

  it('turn signal 取消 → 停止等待，不返回 retry', async () => {
    const resetsAt = new Date(Date.now() + 100000).toISOString()
    stubFetch(statsBody(resetsAt))

    const ctx = await mount(makeConfig())
    const controller = new AbortController()
    const next = vi.fn(async () => undefined as RequestErrorAction)
    const payload = makePayload('zenmux-provider', failure('quote_exceeded'), undefined, controller.signal)

    const promise = ctx.waterfall('agent/request-error', payload, next)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()

    const action = await promise
    expect(action).toBeUndefined()
    expect(next).not.toHaveBeenCalled()
  })

  it('quota/changed 事件按实例发布，携带受影响 provider 列表', async () => {
    const resetsAt = new Date(Date.now() + 100000).toISOString()
    stubFetch(statsBody(resetsAt))

    const ctx = await mount(makeConfig(
      { 'zenmux-main': makeInstance() },
      { 'p1': 'zenmux-main', 'p2': 'zenmux-main' },
    ))
    const events: Array<{ instanceId: string; state: unknown; providers: string[] }> = []
    ctx.on('quota/changed', (instanceId, state, providers) => {
      events.push({ instanceId, state, providers })
    })

    const next = vi.fn(async () => undefined as RequestErrorAction)
    const promise = ctx.waterfall('agent/request-error', makePayload('p1', failure('quote_exceeded')), next)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100000 + 5000)
    await promise

    expect(events.length).toBeGreaterThan(0)
    expect(events[0].instanceId).toBe('zenmux-main')
    expect(events[0].providers.sort()).toEqual(['p1', 'p2'])
    expect(events[0].state).toEqual({ phase: 'checking-stats' })
  })
})
