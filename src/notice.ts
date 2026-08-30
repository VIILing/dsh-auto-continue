import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

export interface NoticeVariables {
  provider: string
  hours: number
  minutes: number
}

/** 渲染 resumeNotice 模板，替换 `{provider}` / `{hours}` / `{minutes}` 占位符。 */
export function renderTemplate(template: string, vars: NoticeVariables): string {
  return template
    .replaceAll('{provider}', vars.provider)
    .replaceAll('{hours}', String(vars.hours))
    .replaceAll('{minutes}', String(vars.minutes))
}

export interface BuildNoticeOptions {
  provider: string
  /** 开始等待的 epoch ms。 */
  startedAtMs: number
  /** 即将返回 retry 的 epoch ms。 */
  returnedAtMs: number
  template: string
}

/**
 * 构造 resumeNotice 消息（§13.2）。分钟/小时均向下取整。
 * 使用 `createUserMessage` 生成带稳定 id、被冻结的 user 角色消息。
 */
export function buildResumeNotice(options: BuildNoticeOptions): UserMessage {
  const elapsedMs = Math.max(0, options.returnedAtMs - options.startedAtMs)
  const totalMinutes = Math.floor(elapsedMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  const text = renderTemplate(options.template, {
    provider: options.provider,
    hours,
    minutes,
  })

  return createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'auto-continue',
      form: 'notice',
      summary: 'quota auto-continue',
    },
  })
}
