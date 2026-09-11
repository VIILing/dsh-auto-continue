/**
 * 平台模板契约测试：证明「新增一个平台 = 实现 PlatformQuotaAdapter + 注册」这条
 * 架构承诺成立——用第三个平台 `demo`（既不是 zenmux，也不在仓库内置清单里）走完整链路。
 *
 * 覆盖点：
 * 1. base 层（cordis.yml）可以声明尚未注册的平台，插件加载不抛错，注册后立即可用；
 * 2. 第三方插件用 `ctx.inject(['quota'])` 注册（文档推荐的接入方式，零核心改动）；
 * 3. 端点归属：适配器 defaultBaseURL / 实例 baseURL / 全局 legacy 覆盖，三档优先级；
 * 4. 平台专属参数 `instance.options` 透传给适配器，`optionsSchema` 在写入时 fail loud；
 * 5. `isExhausted` 可覆盖通用“耗尽”口径；
 * 6. 注销后平台从 platforms() 消失且不再被判定。
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QuotaRuntime from '../../src/index.ts'
import type { Config, PlatformInstanceConfig } from '../../src/config.ts'
import type { PlatformQuotaAdapter, PlatformQuotaSnapshot, QuotaFetchContext } from '../../src/platform.ts'
import { decideWaitAction } from '../../src/recovery.ts'

const NOW = new Date('2026-03-24T08:00:00.000Z')
const NS = 'auto-continue' as const
const DEMO_DEFAULT_BASE_URL = 'https://demo.example'

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

/** 「新平台」的最小实现：3 个必需方法 + 元数据，不含任何核心知识。 */
class DemoAdapter implements PlatformQuotaAdapter {
  readonly platform = 'demo'
  readonly label = 'Demo Platform'
  readonly defaultBaseURL = DEMO_DEFAULT_BASE_URL
  /** 平台专属参数 schema：region 必须是字符串。 */
  readonly optionsSchema = Schema.object({ region: Schema.string().default('us') })
  readonly seen: QuotaFetchContext[] = []

  matchesQuotaExhausted(failure: LlmFailure): boolean {
    return /demo_quota_spent/.test(failure.message)
  }

  async fetchQuota(context: QuotaFetchContext): Promise<PlatformQuotaSnapshot> {
    this.seen.push(context)
    return {
      windows: [
        {
          name: 'monthly',
          usagePercentage: 1,
          remainingFlows: 0,
          resetsAt: new Date(Date.now() + 60000).toISOString(),
        },
      ],
    }
  }

  resolveWaitTarget(snapshot: PlatformQuotaSnapshot): number | null {
    const window = snapshot.windows[0]
    return window?.resetsAt == null ? null : Date.parse(window.resetsAt)
  }
}

function makeInstance(overrides: Partial<PlatformInstanceConfig> = {}): PlatformInstanceConfig {
  return {
    type: 'demo',
    options: { region: 'us' },
    managementKey: 'demo-key',
    resumeNotice: { enabled: false, template: '{hours} 小时' },
    statsRetry: { initialDelayMs: 10, maxDelayMs: 20, totalTimeoutMs: 100 },
    postResetRetry: { delaysMs: [10] },
    resetBufferMs: 0,
    ...overrides,
  }
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    platformBaseURL: '',
    platformInstances: { 'demo-main': makeInstance() },
    providerBindings: { 'demo-provider': 'demo-main' },
    ...overrides,
  }
}

function makePayload(provider: string, failure: LlmFailure) {
  return {
    agent: {} as unknown as Agent,
    turn: 1,
    step: 1,
    provider,
    failure,
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }
}

function quotaFailure(): LlmFailure {
  return { message: 'demo_quota_spent', code: 'QUOTA' }
}

async function waitForNamespace(ctx: Context, ns: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (ctx.settings.get(ns) !== undefined) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`settings namespace "${ns}" not registered`)
}

async function mount(config: Config, withSettings = false): Promise<Context> {
  const ctx = new Context()
  if (withSettings) await ctx.plugin(MemorySettingsProvider)
  await ctx.plugin(QuotaRuntime, config)
  if (withSettings) await waitForNamespace(ctx, NS)
  return ctx
}

/** 触发一次 402 判定并把等待跑完。 */
async function driveOnce(ctx: Context, provider = 'demo-provider'): Promise<RequestErrorAction> {
  const next = vi.fn(async () => undefined as RequestErrorAction)
  const promise = ctx.waterfall('agent/request-error', makePayload(provider, quotaFailure()), next)
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(60000)
  return promise
}

describe('平台模板契约：新平台只需实现接口 + 注册', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('base 层可声明尚未注册的平台：加载不抛错，注册后立即可用', async () => {
    // 平台插件可能比本插件晚加载，因此构造期不得因未知平台类型而抛错。
    const ctx = await mount(makeConfig())
    // 只有内置 zenmux；demo 尚未注册。
    expect(ctx.quota.platforms()).toEqual([{ id: 'zenmux', label: 'ZenMux' }])

    // 未注册期间：判定 fail safe 到 next()，不吞错误、不查询统计。
    const nextUnregistered = vi.fn(async () => undefined as RequestErrorAction)
    const unregistered = await ctx.waterfall(
      'agent/request-error',
      makePayload('demo-provider', quotaFailure()),
      nextUnregistered,
    )
    expect(unregistered).toBeUndefined()
    expect(nextUnregistered).toHaveBeenCalled()

    // 注册后同一配置立刻可用，无需重启、无需改核心文件。
    ctx.quota.registerPlatformAdapter(new DemoAdapter())
    expect(await driveOnce(ctx)).toEqual({ kind: 'retry' })
  })

  it('独立插件通过 ctx.inject([quota]) 注册平台（文档推荐的接入方式）', async () => {
    const ctx = await mount(makeConfig())
    const adapter = new DemoAdapter()

    class DemoPlatformPlugin {
      constructor(c: Context) {
        c.inject(['quota'], (quotaCtx) => {
          quotaCtx.quota.registerPlatformAdapter(adapter)
        })
      }
    }
    await ctx.plugin(DemoPlatformPlugin)

    expect(ctx.quota.platforms()).toEqual([
      { id: 'demo', label: 'Demo Platform' },
      { id: 'zenmux', label: 'ZenMux' },
    ])
    expect(await driveOnce(ctx)).toEqual({ kind: 'retry' })
  })

  it('端点归属：适配器默认 → 实例覆盖 → 全局 legacy 覆盖', async () => {
    // a) 全局留空、实例未覆盖 → 适配器 defaultBaseURL
    const a = await mount(makeConfig())
    const adapterA = new DemoAdapter()
    a.quota.registerPlatformAdapter(adapterA)
    await driveOnce(a)
    expect(adapterA.seen[0]?.baseURL).toBe(DEMO_DEFAULT_BASE_URL)

    // b) 实例级 baseURL 覆盖适配器默认
    const b = await mount(makeConfig({
      platformInstances: { 'demo-main': makeInstance({ baseURL: 'https://proxy.internal' }) },
    }))
    const adapterB = new DemoAdapter()
    b.quota.registerPlatformAdapter(adapterB)
    await driveOnce(b)
    expect(adapterB.seen[0]?.baseURL).toBe('https://proxy.internal')

    // c) 全局 platformBaseURL 非空时为 legacy 覆盖，优先级高于适配器默认
    const c = await mount(makeConfig({ platformBaseURL: 'https://global.internal' }))
    const adapterC = new DemoAdapter()
    c.quota.registerPlatformAdapter(adapterC)
    await driveOnce(c)
    expect(adapterC.seen[0]?.baseURL).toBe('https://global.internal')
  })

  it('平台专属参数 instance.options 透传给适配器', async () => {
    const ctx = await mount(makeConfig({
      platformInstances: { 'demo-main': makeInstance({ options: { region: 'eu', tenant: 'acme' } }) },
    }))
    const adapter = new DemoAdapter()
    ctx.quota.registerPlatformAdapter(adapter)

    await driveOnce(ctx)
    expect(adapter.seen[0]?.instance.options).toEqual({ region: 'eu', tenant: 'acme' })
  })

  it('optionsSchema：写入非法平台参数 → fail loud', async () => {
    const ctx = await mount(makeConfig({ platformInstances: {}, providerBindings: {} }), true)
    ctx.quota.registerPlatformAdapter(new DemoAdapter())

    await expect(ctx.settings.replace(NS, {
      platformInstances: { 'demo-main': makeInstance({ options: { region: 123 } as unknown as Record<string, unknown> }) },
      providerBindings: { 'demo-provider': 'demo-main' },
    })).rejects.toThrow(/invalid options for platform "demo"/)
  })

  it('settings 写入未注册平台类型 → 严格路径抛错（写入时插件已全部加载）', async () => {
    const ctx = await mount(makeConfig({ platformInstances: {}, providerBindings: {} }), true)
    await expect(ctx.settings.replace(NS, {
      platformInstances: { 'nope-main': makeInstance({ type: 'nope' }) },
    })).rejects.toThrow(/unknown platform type "nope"/)
  })

  it('isExhausted 覆盖通用“耗尽”口径', () => {
    const snapshot: PlatformQuotaSnapshot = {
      windows: [{ name: 'monthly', usagePercentage: 0.5, remainingFlows: 100, resetsAt: null }],
    }
    const resetsAtMs = NOW.getTime() + 60000
    const base = {
      snapshot: { windows: [{ ...snapshot.windows[0]!, resetsAt: new Date(resetsAtMs).toISOString() }] },
      now: NOW.getTime(),
      resetBufferMs: 0,
      // 已经等过一轮：通用口径下会落到 post-reset 宽容退避。
      episodeWaitedReset: true,
    }
    const plain = new DemoAdapter()
    expect(decideWaitAction({ ...base, adapter: plain })).toEqual({ type: 'post-reset' })

    const custom = new DemoAdapter()
    Object.defineProperty(custom, 'isExhausted', { value: () => true })
    expect(decideWaitAction({ ...base, adapter: custom })).toEqual({ type: 'waiting-reset', resetAt: resetsAtMs })
  })

  it('注销后平台从 platforms() 消失且不再被判定', async () => {
    const ctx = await mount(makeConfig())
    const dispose = ctx.quota.registerPlatformAdapter(new DemoAdapter())
    expect(ctx.quota.platforms().map((p) => p.id)).toEqual(['demo', 'zenmux'])

    dispose()
    expect(ctx.quota.platforms()).toEqual([{ id: 'zenmux', label: 'ZenMux' }])

    const next = vi.fn(async () => undefined as RequestErrorAction)
    const action = await ctx.waterfall(
      'agent/request-error',
      makePayload('demo-provider', quotaFailure()),
      next,
    )
    expect(action).toBeUndefined()
    expect(next).toHaveBeenCalled()
  })
})
