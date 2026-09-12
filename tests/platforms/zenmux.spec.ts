import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import {
  ZenMuxAdapter,
  mapSnapshot,
  matchesQuotaExhausted,
  resolveWaitTarget,
} from '../../src/platforms/zenmux.ts'
import {
  isWindowExhausted,
  type PlatformQuotaAdapter,
  type PlatformQuotaSnapshot,
  type QuotaFetchContext,
  type QuotaWindow,
} from '../../src/platform.ts'
import { decideWaitAction } from '../../src/recovery.ts'
import {
  INSUFFICIENT_CREDIT_BODY,
  QUOTE_EXCEEDED_BODY,
  QUOTE_EXCEEDED_REQUEST_ID,
  RAW_QUOTE_EXCEEDED_TEXT,
  REJECT_NO_CREDIT_BODY,
  piAiFlattenedMessage,
  piAiMessageText,
  rawJsonMessage,
} from './zenmux-402-sample.ts'

function failure(message: string, status?: number): LlmFailure {
  return { message, code: 'QUOTA', ...(status === undefined ? {} : { status }) }
}

function window(name: string, usage: number, remaining: number, resetsAt: string | null): QuotaWindow {
  return { name, usagePercentage: usage, remainingFlows: remaining, resetsAt }
}

function snapshot(w5: QuotaWindow, w7: QuotaWindow): PlatformQuotaSnapshot {
  return { windows: [w5, w7] }
}

/** 构造 fetchQuota 的调用上下文（v3 起适配器接收上下文对象）。 */
function fetchContext(baseURL: string, credential = 'cred'): QuotaFetchContext {
  return {
    credential,
    baseURL,
    instance: {
      type: 'zenmux',
      options: {},
      resumeNotice: { enabled: false, template: '{hours} {minutes}' },
      statsRetry: { initialDelayMs: 60000, maxDelayMs: 900000, totalTimeoutMs: 3600000 },
      postResetRetry: { delaysMs: [60000] },
      resetBufferMs: 5000,
    },
    signal: new AbortController().signal,
  }
}

const adapter = new ZenMuxAdapter()

describe('ZenMux 平台元信息', () => {
  it('自带展示名与默认端点（UI 下拉与端点解析都从适配器读取）', () => {
    expect(adapter.platform).toBe('zenmux')
    expect(adapter.label).toBe('ZenMux')
    expect(adapter.defaultBaseURL).toBe('https://zenmux.ai')
  })

  it('未声明 optionsSchema / isExhausted（沿用通用判定）', () => {
    const asInterface: PlatformQuotaAdapter = adapter
    expect(asInterface.optionsSchema).toBeUndefined()
    expect(asInterface.isExhausted).toBeUndefined()
  })
})

describe('ZenMux 错误识别 (matchesQuotaExhausted)', () => {
  it('命中 quote_exceeded 纯文本', () => {
    expect(matchesQuotaExhausted(failure('quote_exceeded'))).toBe(true)
  })

  it('命中 JSON 形式 {"error":{"code":"402","type":"quote_exceeded"}}', () => {
    const msg = '{"error":{"code":"402","type":"quote_exceeded"}}'
    expect(matchesQuotaExhausted(failure(msg))).toBe(true)
  })

  it('命中 pi-ai 压平后的转义 JSON 文本', () => {
    const msg = String.raw`{"error":{"code":"402","type":"quote_exceeded","message":"quota exceeded"}}`
    expect(matchesQuotaExhausted(failure(msg))).toBe(true)
  })

  it('命中人类可读文案 subscription quota exhausted', () => {
    expect(matchesQuotaExhausted(failure('Subscription quota exhausted'))).toBe(true)
  })

  it('命中 reached your subscription quota limit', () => {
    expect(matchesQuotaExhausted(failure('You have reached your subscription quota limit'))).toBe(true)
  })

  it('insufficient_credit 不命中', () => {
    expect(matchesQuotaExhausted(failure('insufficient_credit'))).toBe(false)
  })

  it('reject_no_credit 不命中', () => {
    expect(matchesQuotaExhausted(failure('reject_no_credit'))).toBe(false)
  })

  it('rate_limit 不命中', () => {
    expect(matchesQuotaExhausted(failure('rate_limit'))).toBe(false)
  })

  it('status=403 不命中', () => {
    expect(matchesQuotaExhausted(failure('quote_exceeded', 403))).toBe(false)
  })

  it('长度 > 10000 不命中', () => {
    expect(matchesQuotaExhausted(failure('quote_exceeded ' + 'x'.repeat(10000)))).toBe(false)
  })

  it('status=402 命中', () => {
    expect(matchesQuotaExhausted(failure('quote_exceeded', 402))).toBe(true)
  })
})

describe('ZenMux 等待目标计算 (resolveWaitTarget)', () => {
  const t5 = '2026-03-24T13:00:00.000Z'
  const t7 = '2026-03-26T02:15:05.000Z'

  it('5h 满 / 7d 未满 → 5h resetsAt', () => {
    const snap = snapshot(
      window('5h', 1, 0, t5),
      window('7d', 0.5, 100, t7),
    )
    expect(resolveWaitTarget(snap)).toBe(Date.parse(t5))
  })

  it('7d 满 / 5h 满 → max(5h, 7d)', () => {
    const snap = snapshot(
      window('5h', 1, 0, t5),
      window('7d', 1, 0, t7),
    )
    expect(resolveWaitTarget(snap)).toBe(Date.parse(t7))
  })

  it('7d 满 / 5h 满 → max 取较晚一方（5h 更晚）', () => {
    const snap = snapshot(
      window('5h', 1, 0, t7),
      window('7d', 1, 0, t5),
    )
    expect(resolveWaitTarget(snap)).toBe(Date.parse(t7))
  })

  it('两窗口未满（统计滞后）→ 5h resetsAt', () => {
    const snap = snapshot(
      window('5h', 0.5, 100, t5),
      window('7d', 0.5, 100, t7),
    )
    expect(resolveWaitTarget(snap)).toBe(Date.parse(t5))
  })

  it('7d 满 / 5h 未满 → 7d resetsAt', () => {
    const snap = snapshot(
      window('5h', 0.5, 100, t5),
      window('7d', 1, 0, t7),
    )
    expect(resolveWaitTarget(snap)).toBe(Date.parse(t7))
  })

  it('所需 resetsAt 为 null → 缺失（返回 null）', () => {
    const snap = snapshot(
      window('5h', 1, 0, null),
      window('7d', 0.5, 100, t7),
    )
    expect(resolveWaitTarget(snap)).toBeNull()
  })

  it('max 中一方 resetsAt 为 null 时用另一方', () => {
    const snap = snapshot(
      window('5h', 1, 0, null),
      window('7d', 1, 0, t7),
    )
    expect(resolveWaitTarget(snap)).toBe(Date.parse(t7))
  })
})

describe('窗口耗尽判定 (isWindowExhausted)', () => {
  it('remaining_flows=0 且 usage<1 → 耗尽', () => {
    expect(isWindowExhausted(window('5h', 0.5, 0, '2026-03-24T13:00:00.000Z'))).toBe(true)
  })

  it('usage=1 且 remaining>0 → 耗尽', () => {
    expect(isWindowExhausted(window('5h', 1, 10, '2026-03-24T13:00:00.000Z'))).toBe(true)
  })

  it('usage<1 且 remaining>0 → 未耗尽', () => {
    expect(isWindowExhausted(window('5h', 0.5, 10, '2026-03-24T13:00:00.000Z'))).toBe(false)
  })
})

describe('ZenMux 统计快照映射 (mapSnapshot)', () => {
  const body = {
    success: true,
    data: {
      quota_5_hour: {
        usage_percentage: 0.0715,
        resets_at: '2026-03-24T08:35:09.000Z',
        max_flows: 800,
        used_flows: 57.2,
        remaining_flows: 742.8,
      },
      quota_7_day: {
        usage_percentage: 0.0673,
        resets_at: '2026-03-26T02:15:05.000Z',
        max_flows: 6182,
        used_flows: 416.11,
        remaining_flows: 5765.89,
      },
    },
  }

  it('合法响应映射为 5h / 7d 两个窗口', () => {
    const snap = mapSnapshot(body)
    expect(snap.windows).toHaveLength(2)
    const byName = Object.fromEntries(snap.windows.map((w) => [w.name, w]))
    expect(byName['5h'].usagePercentage).toBe(0.0715)
    expect(byName['5h'].remainingFlows).toBe(742.8)
    expect(byName['7d'].resetsAt).toBe('2026-03-26T02:15:05.000Z')
  })

  it('缺失窗口抛错', () => {
    const bad = { success: true, data: { quota_5_hour: body.data.quota_5_hour } }
    expect(() => mapSnapshot(bad)).toThrow()
  })

  it('usage_percentage 类型错误抛错', () => {
    const bad = {
      success: true,
      data: {
        quota_5_hour: { ...body.data.quota_5_hour, usage_percentage: 'full' },
        quota_7_day: body.data.quota_7_day,
      },
    }
    expect(() => mapSnapshot(bad)).toThrow()
  })
})

describe('ZenMux fetchQuota', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('HTTP 200 且 success=true 返回快照', async () => {
    const body = {
      success: true,
      data: {
        quota_5_hour: { usage_percentage: 1, remaining_flows: 0, resets_at: '2026-03-24T13:00:00.000Z' },
        quota_7_day: { usage_percentage: 0.5, remaining_flows: 10, resets_at: '2026-03-26T02:15:05.000Z' },
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      json: async () => body,
    })))
    const snap = await adapter.fetchQuota(fetchContext('https://zenmux.ai'))
    expect(snap.windows.map((w) => w.name)).toEqual(['5h', '7d'])
  })

  it('非 200 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 500, json: async () => ({}) })))
    await expect(
      adapter.fetchQuota(fetchContext('https://zenmux.ai')),
    ).rejects.toThrow()
  })

  it('success !== true 抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ success: false }) })))
    await expect(
      adapter.fetchQuota(fetchContext('https://zenmux.ai')),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 黄金样本回归（v1 §1.3 / §18-8）
//
// `tests/fixtures/zenmux-subscription-detail.json` 是一次真实 ZenMux
// `GET /api/v1/management/subscription/detail` 的原始响应，逐字节保存。它把
// §8.3 的字段映射钉死在真实数据上：若 ZenMux 改变响应结构（字段改名、类型变化、
// 缺失），本组用例会失败，提醒修订映射与文档，而不是让漂移悄悄上线。
// ---------------------------------------------------------------------------
const GOLDEN_STATS_BODY: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/zenmux-subscription-detail.json', import.meta.url), 'utf8'),
)

describe('黄金样本：真实 ZenMux 统计响应回归 (§8.3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('字段映射与真实响应一致（5h / 7d）', () => {
    const snap = mapSnapshot(GOLDEN_STATS_BODY)
    expect(snap.windows.map((w) => w.name)).toEqual(['5h', '7d'])
    const byName = Object.fromEntries(snap.windows.map((w) => [w.name, w]))
    expect(byName['5h']).toEqual({
      name: '5h',
      usagePercentage: 0.0196,
      remainingFlows: 49.02,
      resetsAt: '2026-09-11T13:52:58.000Z',
    })
    expect(byName['7d']).toEqual({
      name: '7d',
      usagePercentage: 0.1088,
      remainingFlows: 189.82,
      resetsAt: '2026-09-12T08:48:40.000Z',
    })
  })

  it('真实响应的额外字段与无 usage 的 quota_monthly 不影响映射', () => {
    const raw = GOLDEN_STATS_BODY as { data: Record<string, unknown> }
    // 真实响应带 plan / currency / base_usd_per_flow / account_status 等本插件
    // 不消费的字段；quota_monthly 只有上限、没有 usage_percentage。
    expect(Object.keys(raw.data)).toContain('account_status')
    expect(raw.data['quota_monthly']).not.toHaveProperty('usage_percentage')
    expect(() => mapSnapshot(GOLDEN_STATS_BODY)).not.toThrow()
  })

  it('真实响应两窗口均未耗尽 → 等待目标取 5h resets_at', () => {
    const snap = mapSnapshot(GOLDEN_STATS_BODY)
    expect(snap.windows.every((w) => !isWindowExhausted(w))).toBe(true)
    expect(resolveWaitTarget(snap)).toBe(Date.parse('2026-09-11T13:52:58.000Z'))
  })

  it('fetchQuota 全链路：真实响应体 → 归一化快照（URL 与 Bearer 头正确）', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => GOLDEN_STATS_BODY,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const snap = await adapter.fetchQuota(fetchContext('https://zenmux.ai', 'mgmt-key'))
    expect(snap.windows.map((w) => `${w.name}:${w.usagePercentage}`)).toEqual(['5h:0.0196', '7d:0.1088'])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://zenmux.ai/api/v1/management/subscription/detail',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer mgmt-key' },
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// 402 黄金样本回归（需求 §1.3 / §7 验收第 18 条；设计 §5.1 / §5.2）
//
// 两份真实样本，均逐字节保存在 `tests/fixtures/`：
// 1. `zenmux-subscription-detail-402.json`——账号真实达到订阅配额上限（即 402
//    条件成立）时抓取的 `subscription/detail` 响应。它与上一节健康样本的唯一区别
//    就是「5h 窗口已耗尽」：`usage_percentage=1`、`remaining_flows=0`，而 7d 未满
//    ——这正是 402 恢复流程真正要处理的输入。
// 2. `zenmux-402-quote-exceeded.json`——线上抓取的真实 402 **错误响应体**
//    （`quote_exceeded`，尾部带 ` (request_id: …)`）。余额类 402 暂无线上样本，
//    其响应体取自 ZenMux 官方错误码参考（https://zenmux.ai/docs/guide/advanced/error-codes）。
// 用例同时按 `dsh-llm-pi-ai` 的真实压平逻辑（`utils/error-body.js` 的
// `formatProviderError`）拼出模型侧 `failure.message` 的两种形态。
// ---------------------------------------------------------------------------
const GOLDEN_402_STATS_BODY: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/zenmux-subscription-detail-402.json', import.meta.url), 'utf8'),
)

describe('黄金样本：真实耗尽样本回归（402 条件成立时的统计响应）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('字段映射与真实耗尽响应一致（5h 已满、7d 未满）', () => {
    const snap = mapSnapshot(GOLDEN_402_STATS_BODY)
    const byName = Object.fromEntries(snap.windows.map((w) => [w.name, w]))
    expect(byName['5h']).toEqual({
      name: '5h',
      usagePercentage: 1,
      remainingFlows: 0,
      resetsAt: '2026-09-12T11:02:38.000Z',
    })
    expect(byName['7d']).toEqual({
      name: '7d',
      usagePercentage: 0.4752,
      remainingFlows: 111.78,
      resetsAt: '2026-09-12T08:48:40.000Z',
    })
  })

  it('耗尽判定：5h 已耗尽、7d 未耗尽', () => {
    const snap = mapSnapshot(GOLDEN_402_STATS_BODY)
    const byName = Object.fromEntries(snap.windows.map((w) => [w.name, w]))
    expect(isWindowExhausted(byName['5h'])).toBe(true)
    expect(isWindowExhausted(byName['7d'])).toBe(false)
  })

  it('等待目标：7d 未满 → 取 5h resets_at（即使它晚于 7d 的重置时刻）', () => {
    const snap = mapSnapshot(GOLDEN_402_STATS_BODY)
    // 真实样本里 5h 的重置时刻（11:02:38Z）恰好晚于 7d（08:48:40Z），因此本样本
    // 无法单独区分「7d 未满取 5h」与「取 max(5h, 7d)」；该区分由本文件 §5.2 的规则
    // 用例负责。这里把真实数据上的等待目标钉死为 5h 的重置时刻。
    expect(resolveWaitTarget(snap)).toBe(Date.parse('2026-09-12T11:02:38.000Z'))
    expect(resolveWaitTarget(snap)).not.toBe(Date.parse('2026-09-12T08:48:40.000Z'))
  })

  it('真实耗尽样本经决策链得到 waiting-reset（含 resetBufferMs）', () => {
    const snap = mapSnapshot(GOLDEN_402_STATS_BODY)
    const resets5 = Date.parse('2026-09-12T11:02:38.000Z')
    expect(
      decideWaitAction({
        snapshot: snap,
        adapter,
        now: resets5 - 60_000,
        resetBufferMs: 5000,
        episodeWaitedReset: false,
      }),
    ).toEqual({ type: 'waiting-reset', resetAt: resets5 + 5000 })
  })

  it('fetchQuota 全链路：真实耗尽响应体 → 归一化快照', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => GOLDEN_402_STATS_BODY,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const snap = await adapter.fetchQuota(fetchContext('https://zenmux.ai', 'mgmt-key'))
    expect(snap.windows.map((w) => `${w.name}:${w.usagePercentage}/${w.remainingFlows}`)).toEqual([
      '5h:1/0',
      '7d:0.4752/111.78',
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://zenmux.ai/api/v1/management/subscription/detail',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer mgmt-key' },
      }),
    )
  })
})

describe('黄金样本：真实 402 识别规则核对（§5.1 / 验收第 18 条）', () => {
  it('线上抓取的真实 402 响应体：类型/文案/request_id 与样本逐字段一致', () => {
    // 样本本身即校验：字段名、类型与文案（含尾部 request_id）逐字来自线上响应。
    expect(QUOTE_EXCEEDED_BODY.error.code).toBe('402')
    expect(QUOTE_EXCEEDED_BODY.error.type).toBe('quote_exceeded')
    expect(QUOTE_EXCEEDED_BODY.error.message).toContain(
      'You have reached your subscription quota limit.',
    )
    expect(QUOTE_EXCEEDED_BODY.error.message).toContain(`(request_id: ${QUOTE_EXCEEDED_REQUEST_ID})`)
  })

  it('命中线上 402 响应体（原始字节 / JSON 原样 / pi-ai 两种压平形态）', () => {
    // 原始字节（含结尾换行）——SDK 若把 body 作为字符串透出即为此形态。
    expect(matchesQuotaExhausted(failure(RAW_QUOTE_EXCEEDED_TEXT, 402))).toBe(true)
    expect(matchesQuotaExhausted(failure(rawJsonMessage(QUOTE_EXCEEDED_BODY), 402))).toBe(true)
    expect(matchesQuotaExhausted(failure(piAiFlattenedMessage(QUOTE_EXCEEDED_BODY), 402))).toBe(true)
    expect(matchesQuotaExhausted(failure(piAiMessageText(QUOTE_EXCEEDED_BODY), 402))).toBe(true)
    // 真实链路里 pi-ai 的 failure 只有 message/code，没有 status。
    expect(matchesQuotaExhausted(failure(piAiFlattenedMessage(QUOTE_EXCEEDED_BODY)))).toBe(true)
    expect(matchesQuotaExhausted(failure(piAiMessageText(QUOTE_EXCEEDED_BODY)))).toBe(true)
  })

  it('尾部 request_id 不影响识别', () => {
    const withoutRequestId = QUOTE_EXCEEDED_BODY.error.message.replace(
      ` (request_id: ${QUOTE_EXCEEDED_REQUEST_ID})`,
      '',
    )
    const body = { error: { ...QUOTE_EXCEEDED_BODY.error, message: withoutRequestId } }
    expect(matchesQuotaExhausted(failure(piAiFlattenedMessage(body), 402))).toBe(true)
  })

  it('命中官方人类可读文案（裸 message，无 JSON 包裹）', () => {
    expect(matchesQuotaExhausted(failure(QUOTE_EXCEEDED_BODY.error.message, 402))).toBe(true)
  })

  it('余额类 402 不命中：insufficient_credit / reject_no_credit', () => {
    for (const body of [INSUFFICIENT_CREDIT_BODY, REJECT_NO_CREDIT_BODY]) {
      expect(matchesQuotaExhausted(failure(rawJsonMessage(body), 402))).toBe(false)
      expect(matchesQuotaExhausted(failure(piAiFlattenedMessage(body), 402))).toBe(false)
      expect(matchesQuotaExhausted(failure(piAiMessageText(body), 402))).toBe(false)
    }
  })

  it('三型 402 共享 "code":"402" 外壳，识别只认 quote_exceeded 语义', () => {
    // 仅凭 code=402 不足以判定：三种 402 的 JSON 外壳相同，差异在 type/message。
    const shellOnly = '{"error":{"code":"402"}}'
    expect(matchesQuotaExhausted(failure(shellOnly, 402))).toBe(false)
    // 余额类即便携带 402 状态码也不处理（避免把「余额不足」误当「配额可恢复」）。
    expect(matchesQuotaExhausted(failure(rawJsonMessage(INSUFFICIENT_CREDIT_BODY), 402))).toBe(false)
  })
})
