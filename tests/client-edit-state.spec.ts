/**
 * Draft 映射单测：`platformInstances` 行 ⇄ 卡片编辑态。
 *
 * 重点覆盖 v3 新增字段（`baseURL` / `options` / 数据驱动的 `type`），以及
 * 「留空 = 未设置」的语义（端点、密钥）——这些以前只在 Playwright lane 里被间接覆盖。
 */
import { describe, expect, it } from 'vitest'
import {
  editStateToInstance,
  toEditState,
  type EditState,
  type InstanceRow,
} from '../src/client/edit-state.ts'

function makeRow(overrides: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'demo-main',
    type: 'demo',
    ...overrides,
  }
}

function makeDraft(overrides: Partial<EditState> = {}): EditState {
  return {
    ...toEditState(null, 'demo'),
    id: 'demo-main',
    isNew: false,
    ...overrides,
  }
}

describe('toEditState：新建草稿', () => {
  it('type 取传入的默认模板（列表首项），端点与专属参数留空', () => {
    const draft = toEditState(null, 'openrouter')
    expect(draft.isNew).toBe(true)
    expect(draft.type).toBe('openrouter')
    expect(draft.baseURL).toBe('')
    expect(draft.optionsJson).toBe('')
    expect(draft.managementKey).toBe('')
    expect(draft.boundProviderIds).toEqual([])
  })

  it('未注册任何模板时 defaultType 为空串（由 UI 提示，不伪造平台名）', () => {
    expect(toEditState(null, '').type).toBe('')
  })
})

describe('toEditState：既有行', () => {
  it('装载 type / baseURL / options', () => {
    const draft = toEditState(makeRow({
      baseURL: 'https://proxy.internal',
      options: { region: 'eu', tenant: 'acme' },
    }), 'demo')
    expect(draft.isNew).toBe(false)
    expect(draft.type).toBe('demo')
    expect(draft.baseURL).toBe('https://proxy.internal')
    expect(JSON.parse(draft.optionsJson)).toEqual({ region: 'eu', tenant: 'acme' })
  })

  it('行未写 type 时回退到默认模板；行未写端点/参数时留空', () => {
    const draft = toEditState(makeRow({ type: undefined }), 'fallback-template')
    expect(draft.type).toBe('fallback-template')
    expect(draft.baseURL).toBe('')
    expect(draft.optionsJson).toBe('')
  })

  it('空的 options 显示为空框（不是 "{}"）', () => {
    expect(toEditState(makeRow({ options: {} }), 'demo').optionsJson).toBe('')
  })

  it('managementKey 始终不装载（secret 不回显）', () => {
    const draft = toEditState(makeRow({ managementKey: 'should-not-leak' }), 'demo')
    expect(draft.managementKey).toBe('')
  })

  it('保留其它字段的既有值与默认值', () => {
    const draft = toEditState(makeRow({
      resumeNotice: { enabled: true, template: '等了 {hours} 小时' },
      statsRetry: { initialDelayMs: 1000, maxDelayMs: 2000, totalTimeoutMs: 3000 },
      postResetRetry: { delaysMs: [100, 200] },
      resetBufferMs: 42,
    }), 'demo')
    expect(draft.resumeEnabled).toBe(true)
    expect(draft.resumeTemplate).toBe('等了 {hours} 小时')
    expect([draft.initialDelayMs, draft.maxDelayMs, draft.totalTimeoutMs]).toEqual(['1000', '2000', '3000'])
    expect(draft.delaysMs).toBe('100,200')
    expect(draft.resetBufferMs).toBe('42')
  })
})

describe('editStateToInstance：回写', () => {
  it('写回 type / baseURL / options', () => {
    const instance = editStateToInstance(makeDraft({
      type: 'openrouter',
      baseURL: 'https://proxy.internal',
      optionsJson: '{"region":"eu"}',
    }))
    expect(instance.type).toBe('openrouter')
    expect(instance.baseURL).toBe('https://proxy.internal')
    expect(instance.options).toEqual({ region: 'eu' })
  })

  it('端点留空 → baseURL 为 undefined（表示用模板默认端点），并去掉首尾空格', () => {
    expect(editStateToInstance(makeDraft({ baseURL: '' })).baseURL).toBeUndefined()
    expect(editStateToInstance(makeDraft({ baseURL: '   ' })).baseURL).toBeUndefined()
    expect(editStateToInstance(makeDraft({ baseURL: '  https://x.example  ' })).baseURL).toBe('https://x.example')
  })

  it('专属参数留空 → {}（占位与空等价）', () => {
    expect(editStateToInstance(makeDraft({ optionsJson: '' })).options).toEqual({})
    expect(editStateToInstance(makeDraft({ optionsJson: '  ' })).options).toEqual({})
  })

  it('密钥留空 → undefined（host 端保留原值），非空才写新值', () => {
    expect(editStateToInstance(makeDraft({ managementKey: '' })).managementKey).toBeUndefined()
    expect(editStateToInstance(makeDraft({ managementKey: 'sk-new' })).managementKey).toBe('sk-new')
  })

  it('数值字段转数字、重试序列按逗号拆分并丢弃非法项', () => {
    const instance = editStateToInstance(makeDraft({
      initialDelayMs: '10',
      maxDelayMs: '20',
      totalTimeoutMs: '30',
      delaysMs: '100, 200 ,oops,-5',
      resetBufferMs: '0',
    }))
    expect(instance.statsRetry).toEqual({ initialDelayMs: 10, maxDelayMs: 20, totalTimeoutMs: 30 })
    expect(instance.postResetRetry).toEqual({ delaysMs: [100, 200] })
    expect(instance.resetBufferMs).toBe(0)
  })
})

describe('行 → 草稿 → 实例 往返', () => {
  it('保留 type / baseURL / options', () => {
    const row = makeRow({
      type: 'openrouter',
      baseURL: 'https://proxy.internal',
      options: { region: 'eu' },
      resumeNotice: { enabled: true, template: 't' },
      statsRetry: { initialDelayMs: 1000, maxDelayMs: 2000, totalTimeoutMs: 3000 },
      postResetRetry: { delaysMs: [100, 200] },
      resetBufferMs: 7,
    })
    const instance = editStateToInstance(toEditState(row, 'demo'))
    expect(instance).toEqual({
      type: 'openrouter',
      baseURL: 'https://proxy.internal',
      options: { region: 'eu' },
      managementKey: undefined,
      resumeNotice: { enabled: true, template: 't' },
      statsRetry: { initialDelayMs: 1000, maxDelayMs: 2000, totalTimeoutMs: 3000 },
      postResetRetry: { delaysMs: [100, 200] },
      resetBufferMs: 7,
    })
  })
})
