import { Context } from '@deepseek-ai/cordis'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it } from 'vitest'
import QuotaRuntime from '../src/index.ts'
import type { Config, PlatformInstanceConfig } from '../src/config.ts'

const NS = 'auto-continue' as const

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
    managementKey: 'secret-key',
    resumeNotice: { enabled: false, template: '{hours} {minutes}' },
    statsRetry: { initialDelayMs: 60000, maxDelayMs: 900000, totalTimeoutMs: 3600000 },
    postResetRetry: { delaysMs: [60000] },
    resetBufferMs: 5000,
    ...overrides,
  }
}

function makeConfig(): Config {
  return {
    platformBaseURL: 'https://zenmux.ai',
    platformInstances: { 'zm': makeInstance() },
    providerBindings: { 'p1': 'zm' },
  }
}

interface CapturedRoute {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

function fakeReq(apiMethod: string, body: unknown) {
  return {
    method: 'POST',
    url: `/auto-continue/api/${apiMethod}`,
    headers: { host: 'localhost', origin: 'http://localhost' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(JSON.stringify(body))
    },
  }
}

function fakeRes() {
  const res = {
    status: 0,
    body: '',
    headers: {} as Record<string, unknown>,
    writeHead(status: number, headers: Record<string, unknown>) {
      res.status = status
      res.headers = headers
    },
    end(payload: string) {
      res.body = payload
    },
  }
  return res
}

async function mount(): Promise<{ ctx: Context; routes: CapturedRoute[] }> {
  const ctx = new Context()
  await ctx.plugin(MemorySettingsProvider)
  const routes: CapturedRoute[] = []
  ctx.provide('webServer', {
    register(route: CapturedRoute) {
      routes.push(route)
      return () => {}
    },
  } as never)
  ctx.provide('webRuntime', { trustedHosts: [] } as never)
  await ctx.plugin(QuotaRuntime, makeConfig())
  // 等待 settings namespace 注册完成。
  for (let i = 0; i < 100; i++) {
    if (ctx.settings.get(NS) !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { ctx, routes }
}

describe('自建 /auto-continue/api 路由', () => {
  afterEach(() => {
    // noop
  })

  it('settings.get 返回 redacted 值与 keyStates', async () => {
    const { routes } = await mount()
    expect(routes).toHaveLength(1)
    expect(routes[0].path).toBe('/auto-continue/api')

    const res = fakeRes()
    await routes[0].handler(fakeReq('settings.get', {}), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as {
      ok: boolean
      value: { value?: { platformInstances?: Record<string, unknown> }; keyStates?: Record<string, boolean> }
    }
    expect(body.ok).toBe(true)
    expect(body.value.value?.platformInstances?.zm).toBeDefined()
    // redacted：managementKey 不回传。
    expect((body.value.value?.platformInstances?.zm as { managementKey?: string }).managementKey).toBeUndefined()
    expect(body.value.keyStates?.zm).toBe(true)
  })

  it('settings.update 留空 managementKey 时保留已有 secret', async () => {
    const { ctx, routes } = await mount()

    const res = fakeRes()
    await routes[0].handler(fakeReq('settings.update', {
      section: {
        platformInstances: { 'zm': { type: 'zenmux', resumeNotice: { enabled: true, template: 'x' } } },
        providerBindings: { 'p1': 'zm' },
      },
    }), res)
    expect(res.status).toBe(200)
    expect((JSON.parse(res.body) as { ok: boolean }).ok).toBe(true)

    // 非 redacted 读取，确认 secret 未被删除。
    const full = ctx.settings.describe({ redactSecrets: false }).find((d) => d.ns === NS)
    const inst = (full?.value as { platformInstances: Record<string, { managementKey?: string; resumeNotice?: { enabled?: boolean } }> }).platformInstances.zm
    expect(inst.managementKey).toBe('secret-key')
    expect(inst.resumeNotice?.enabled).toBe(true)
  })

  it('providers.list 返回 provider 列表', async () => {
    const { ctx, routes } = await mount()
    ctx.provide('llm', { listProviders: () => [{ id: 'p1', name: 'p1' }] } as never)

    const res = fakeRes()
    await routes[0].handler(fakeReq('providers.list', {}), res)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { ok: boolean; value: Array<{ id: string }> }
    expect(body.ok).toBe(true)
    expect(body.value).toEqual([{ id: 'p1', name: 'p1' }])
  })

  it('非 loopback/受信 Host 被拒绝', async () => {
    const { routes } = await mount()
    const req = fakeReq('settings.get', {})
    ;(req.headers as Record<string, string>).host = 'evil.example.com'

    const res = fakeRes()
    await routes[0].handler(req, res)
    expect(res.status).toBe(403)
  })
})
