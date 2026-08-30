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
  it('默认空实例、空绑定、默认 baseURL', () => {
    const cfg = resolve({})
    expect(cfg.platformBaseURL).toBe('https://zenmux.ai')
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
    expect(cfg.providerBindings).toEqual({ 'zenmux-provider': 'zenmux-main' })
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
})
