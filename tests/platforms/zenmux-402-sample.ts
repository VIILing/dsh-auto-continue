/**
 * ZenMux 真实 402 错误响应样本（需求 §7 验收第 18 条）。
 *
 * - `quote_exceeded`（订阅配额耗尽，本插件唯一负责恢复的类型）：**线上抓取的真实响应体**，
 *   逐字节保存在 `tests/fixtures/zenmux-402-quote-exceeded.json`。真实文案在官方文档文案之后
 *   还附带 ` (request_id: <id>)`，本文件据此钉死「识别不受尾部 request_id 影响」。
 * - `insufficient_credit` / `reject_no_credit`（余额类 402，必须原样交还下游）：暂无线上抓取
 *   样本，响应体逐字取自 ZenMux 官方错误码参考
 *   <https://zenmux.ai/docs/guide/advanced/error-codes> 中公开的真实响应格式与文案。
 *
 * 除 JSON 原文外，用例还要覆盖 `dsh-llm-pi-ai` 压平后的 `failure.message` 两种形态
 * （依据该包 `dist/utils/error-body.js` 的 `normalizeProviderError` /
 * `formatProviderError`）：`extractBody` 会把 SDK 的 `error.error` 解析对象
 * `JSON.stringify` 后拼成 `<status>: <body>`；若 SDK 已把响应体折进 `error.message`
 * （`messageCarriesBody`），则原样透出 `<status> <message>`。
 */
import { readFileSync } from 'node:fs'

export interface ZenMuxErrorBody {
  error: {
    code: string
    type: string
    message: string
  }
}

/** 线上抓取的 402 原始响应体（含结尾换行，逐字节，勿改写）。 */
export const RAW_QUOTE_EXCEEDED_TEXT: string = readFileSync(
  new URL('../fixtures/zenmux-402-quote-exceeded.json', import.meta.url),
  'utf8',
)

/** 线上抓取的 402 响应中的 provider 请求 id（识别必须不受其影响）。 */
export const QUOTE_EXCEEDED_REQUEST_ID = '31ee1011fc2e41188c272af95b69311f'

/** HTTP 402 `quote_exceeded`：订阅配额耗尽（本插件负责恢复的唯一类型）。 */
export const QUOTE_EXCEEDED_BODY: ZenMuxErrorBody = JSON.parse(RAW_QUOTE_EXCEEDED_TEXT)

/** HTTP 402 `insufficient_credit`：账户逾期（余额类，不处理）。 */
export const INSUFFICIENT_CREDIT_BODY: ZenMuxErrorBody = {
  error: {
    code: '402',
    type: 'insufficient_credit',
    message:
      'Account overdue. To prevent abuse, a non-negative balance is required for all models (including free tiers).',
  },
}

/** HTTP 402 `reject_no_credit`：余额不足（余额类，不处理）。 */
export const REJECT_NO_CREDIT_BODY: ZenMuxErrorBody = {
  error: {
    code: '402',
    type: 'reject_no_credit',
    message: 'Credit required. To prevent abuse, a positive balance is required for this model.',
  },
}

/** JSON 原样透出的形态（未压平，如直接记录响应体）。 */
export function rawJsonMessage(body: ZenMuxErrorBody): string {
  return JSON.stringify(body)
}

/** pi-ai 压平形态一：`<status>: <JSON.stringify(body)>`。 */
export function piAiFlattenedMessage(body: ZenMuxErrorBody, status = 402): string {
  return `${status}: ${JSON.stringify(body)}`
}

/** pi-ai 压平形态二：SDK 已把响应体折进 `error.message`，原样带状态前缀透出。 */
export function piAiMessageText(body: ZenMuxErrorBody, status = 402): string {
  return `${status} ${body.error.message}`
}
