import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import {
  Config,
  validateConfig,
  type Config as ConfigType,
  type PlatformInstanceConfig,
} from '../src/config.ts'

const ZENMUX = new Set(['zenmux'])

function makeInstance(overrides: Partial<PlatformInstanceConfig> = {}): PlatformInstanceConfig {
  return {
    type: 'zenmux',
    managementKey: 'sk',
    resumeNotice: { enabled: false, template: '{hours} {minutes}' },
    statsRetry: { initialDelayMs: 60000, maxDelayMs: 900000, totalTimeoutMs: 3600000 },
    postResetRetry: { delaysMs: [60000] },
    resetBufferMs: 5000,
    ...overrides,
  }
}

function makeCfg(
  instances: Record<string, PlatformInstanceConfig> = {},
  bindings: Record<string, string> = {},
): ConfigType {
  return {
    platformBaseURL: 'https://zenmux.ai',
    platformInstances: instances,
    providerBindings: bindings,
  }
}

function resolve(raw: unknown): ConfigType {
  return Schema.resolve(raw, Config, {})[0]
}

describe('v2 配置 schema', () => {
  it('默认空实例、空绑定、全局 baseURL 默认留空（legacy 覆盖）', () => {
    const cfg = resolve({})
    // 全局 platformBaseURL 不再是 zenmux 专属默认值：平台端点由适配器 defaultBaseURL 提供。
    expect(cfg.platformBaseURL).toBe('')
    expect(cfg.platformInstances).toEqual({})
    expect(cfg.providerBindings).toEqual({})
  })

  it('解析 v2 完整配置并填默认值', () => {
    const cfg = resolve({
      platformInstances: { 'zenmux-main': { type: 'zenmux', managementKey: 'sk' } },
      providerBindings: { 'zenmux-provider': 'zenmux-main' },
    })
    expect(cfg.platformInstances['zenmux-main'].type).toBe('zenmux')
    expect(cfg.platformInstances['zenmux-main'].statsRetry.initialDelayMs).toBe(60000)
    expect(cfg.platformInstances['zenmux-main'].resumeNotice.enabled).toBe(false)
    expect(cfg.platformInstances['zenmux-main'].options).toEqual({})
    expect(cfg.providerBindings).toEqual({ 'zenmux-provider': 'zenmux-main' })
  })

  it('type 必填：不再默认成某个具体平台', () => {
    expect(() => resolve({ platformInstances: { x: { managementKey: 'sk' } } })).toThrow(/type/)
  })

  it('实例级 baseURL 与平台专属 options 原样解析', () => {
    const cfg = resolve({
      platformInstances: {
        x: { type: 'zenmux', baseURL: 'https://proxy.internal', options: { region: 'us', retries: 2 } },
      },
    })
    expect(cfg.platformInstances.x.baseURL).toBe('https://proxy.internal')
    expect(cfg.platformInstances.x.options).toEqual({ region: 'us', retries: 2 })
  })

  it('managementKey 标记为 secret（role）', () => {
    // role 是 schema 元数据，用于 settings 脱敏；这里验证不因 role 影响解析。
    const cfg = resolve({
      platformInstances: { 'x': { type: 'zenmux', managementKey: 'sk' } },
    })
    expect(cfg.platformInstances['x'].managementKey).toBe('sk')
  })
})

describe('v2 配置跨字段校验 (validateConfig)', () => {
  it('合法配置不抛错', () => {
    expect(() =>
      validateConfig(
        makeCfg({ 'zenmux-main': makeInstance() }, { 'zenmux-provider': 'zenmux-main' }),
        ZENMUX,
      ),
    ).not.toThrow()
  })

  it('managementKeyRef 与 managementKey 同时非空 → 抛错', () => {
    expect(() =>
      validateConfig(
        makeCfg({ 'x': makeInstance({ managementKeyRef: 'K', managementKey: 'sk' }) }),
        ZENMUX,
      ),
    ).toThrow(/both managementKeyRef and managementKey/)
  })

  it('type 非 zenmux → 抛错', () => {
    expect(() =>
      validateConfig(makeCfg({ 'x': makeInstance({ type: 'openai' }) }), ZENMUX),
    ).toThrow(/unknown platform type/)
  })

  it('providerBindings 指向不存在实例 → 抛错', () => {
    expect(() =>
      validateConfig(makeCfg({}, { 'p': 'missing' }), ZENMUX),
    ).toThrow(/missing instance/)
  })

  it('实例 id 格式非法 → 抛错', () => {
    expect(() =>
      validateConfig(makeCfg({ 'Bad-Id': makeInstance() }), ZENMUX),
    ).toThrow(/must match/)
  })

  it('postResetRetry.delaysMs 空数组 → 抛错', () => {
    expect(() =>
      validateConfig(makeCfg({ 'x': makeInstance({ postResetRetry: { delaysMs: [] } }) }), ZENMUX),
    ).toThrow(/non-empty array/)
  })

  it('statsRetry 非正整数 → 抛错', () => {
    expect(() =>
      validateConfig(
        makeCfg({ 'x': makeInstance({ statsRetry: { initialDelayMs: 1.5, maxDelayMs: 900000, totalTimeoutMs: 3600000 } }) }),
        ZENMUX,
      ),
    ).toThrow(/positive integer/)
  })

  it('resetBufferMs 负数 → 抛错', () => {
    expect(() =>
      validateConfig(makeCfg({ 'x': makeInstance({ resetBufferMs: -1 }) }), ZENMUX),
    ).toThrow(/non-negative integer/)
  })

  it('baseURL 非 http(s) → 抛错', () => {
    expect(() =>
      validateConfig(makeCfg({ 'x': makeInstance({ baseURL: 'proxy.internal' }) }), ZENMUX),
    ).toThrow(/baseURL must be an http\(s\) URL/)
  })

  it('deferUnknownPlatforms：未知平台类型被收集而不是抛错（加载期语义）', () => {
    const deferred: string[] = []
    expect(() =>
      validateConfig(
        makeCfg({ 'or-main': makeInstance({ type: 'openrouter' }) }),
        ZENMUX,
        { deferUnknownPlatforms: deferred },
      ),
    ).not.toThrow()
    expect(deferred).toEqual(['openrouter'])
  })

  it('deferUnknownPlatforms 只放宽“平台未注册”，结构规则仍 fail loud', () => {
    const deferred: string[] = []
    expect(() =>
      validateConfig(
        makeCfg({ 'or-main': makeInstance({ type: 'openrouter', resetBufferMs: -1 }) }),
        ZENMUX,
        { deferUnknownPlatforms: deferred },
      ),
    ).toThrow(/resetBufferMs must be a non-negative integer/)
    expect(deferred).toEqual([])
  })

  it('validateOptions 钩子：对已知平台调用，未知平台跳过', () => {
    const seen: Array<[string, string, Record<string, unknown>]> = []
    validateConfig(
      makeCfg({
        'zenmux-main': makeInstance({ options: { a: 1 } }),
        'or-main': makeInstance({ type: 'openrouter' }),
      }),
      new Set(['zenmux', 'openrouter']),
      { validateOptions: (platform, instanceId, options) => { seen.push([platform, instanceId, options]) } },
    )
    expect(seen).toEqual([
      ['zenmux', 'zenmux-main', { a: 1 }],
      ['openrouter', 'or-main', {}],
    ])
  })
})
