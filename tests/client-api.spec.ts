import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildInstanceDelete,
  buildInstanceEdit,
  isValidBaseURLInput,
  listPlatforms,
  parseOptionsJson,
  updateSettings,
  type AutoContinueSection,
} from '../src/client/api.ts'

describe('client settings api', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('updateSettings 把 section 放在 "section" 键下（而非 patch）', async () => {
    const captured: { url?: string; body?: Record<string, unknown> } = {}
    vi.stubGlobal('fetch', async (url: string, init: { body?: string }) => {
      captured.url = url
      captured.body = JSON.parse(init.body ?? '{}') as Record<string, unknown>
      return {
        ok: true,
        json: async () => ({ ok: true, value: { value: {}, revision: 1 } }),
      } as unknown as Response
    })

    const section = { platformInstances: {}, providerBindings: {} }
    await updateSettings(section, 7)

    expect(captured.url).toBe('/auto-continue/api/settings.update')
    expect(captured.body).toEqual({ section, expectedRevision: 7 })
    expect(captured.body).not.toHaveProperty('patch')
  })

  it('buildInstanceEdit 合并时保留 managementKeyRef，并重建绑定', () => {
    const current: AutoContinueSection = {
      platformInstances: {
        zm: {
          type: 'zenmux',
          managementKeyRef: 'ZENMUX_KEY',
          resumeNotice: { enabled: false, template: 't' },
        },
      },
      providerBindings: { p1: 'zm', p2: 'other' },
    }
    const next = buildInstanceEdit(current, 'zm', { type: 'zenmux', resetBufferMs: 0 }, ['p3'])
    expect(next.platformInstances.zm?.managementKeyRef).toBe('ZENMUX_KEY')
    expect(next.platformInstances.zm?.resetBufferMs).toBe(0)
    expect(next.providerBindings).toEqual({ p2: 'other', p3: 'zm' })
  })

  it('buildInstanceDelete 删除实例并解绑其 provider', () => {
    const current: AutoContinueSection = {
      platformInstances: { zm: { type: 'zenmux' }, other: { type: 'zenmux' } },
      providerBindings: { p1: 'zm', p2: 'other' },
    }
    const next = buildInstanceDelete(current, 'zm')
    expect(next.platformInstances.zm).toBeUndefined()
    expect(next.platformInstances.other).toBeDefined()
    expect(next.providerBindings).toEqual({ p2: 'other' })
  })

  it('listPlatforms 走 fenced 路由的 platforms.list 方法', async () => {
    const captured: { url?: string } = {}
    vi.stubGlobal('fetch', async (url: string) => {
      captured.url = url
      return {
        ok: true,
        json: async () => ({ ok: true, value: [{ id: 'demo', label: 'Demo Platform' }] }),
      } as unknown as Response
    })

    const platforms = await listPlatforms()
    expect(captured.url).toBe('/auto-continue/api/platforms.list')
    expect(platforms).toEqual([{ id: 'demo', label: 'Demo Platform' }])
  })

  it('parseOptionsJson：留空 = {}，非法 JSON / 非对象 = null', () => {
    expect(parseOptionsJson('')).toEqual({})
    expect(parseOptionsJson('   ')).toEqual({})
    expect(parseOptionsJson('{"region":"eu"}')).toEqual({ region: 'eu' })
    expect(parseOptionsJson('[1,2]')).toBeNull()
    expect(parseOptionsJson('null')).toBeNull()
    expect(parseOptionsJson('"text"')).toBeNull()
    expect(parseOptionsJson('{oops')).toBeNull()
  })

  it('isValidBaseURLInput：留空合法，非空需 http(s)', () => {
    expect(isValidBaseURLInput('')).toBe(true)
    expect(isValidBaseURLInput('  ')).toBe(true)
    expect(isValidBaseURLInput('https://proxy.internal')).toBe(true)
    expect(isValidBaseURLInput('http://localhost:8080')).toBe(true)
    expect(isValidBaseURLInput('proxy.internal')).toBe(false)
    expect(isValidBaseURLInput('ftp://x')).toBe(false)
  })
})
