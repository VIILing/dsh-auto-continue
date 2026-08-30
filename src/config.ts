import Schema from '@deepseek-ai/schemastery'

export const DEFAULT_PLATFORM = 'zenmux'
export const DEFAULT_PLATFORM_BASE_URL = 'https://zenmux.ai'
export const DEFAULT_RESUME_NOTICE_TEMPLATE =
  '因额度限制，本次请求等待了 {hours} 小时 {minutes} 分钟后重新发送。'

export const DEFAULT_STATS_RETRY = {
  initialDelayMs: 60000,
  maxDelayMs: 900000,
  totalTimeoutMs: 3600000,
} as const

/** 单次统计接口 HTTP 请求超时（v2 不再作为可配置字段，固定默认值）。 */
export const STATS_REQUEST_TIMEOUT_MS = 30000

export const DEFAULT_POST_RESET_RETRY_DELAYS_MS = [
  60000, 120000, 240000, 480000, 900000,
] as const

export const DEFAULT_RESET_BUFFER_MS = 5000

/** 实例 id 建议格式：lowercase kebab。 */
export const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]*$/

const MANAGEMENT_KEY_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ResumeNoticeConfig {
  enabled: boolean
  template: string
}

export interface StatsRetryConfig {
  initialDelayMs: number
  maxDelayMs: number
  totalTimeoutMs: number
}

export interface PostResetRetryConfig {
  delaysMs: number[]
}

/** 一个平台实例：由平台模板生成，承载账号与恢复策略相关的全部字段。 */
export interface PlatformInstanceConfig {
  /** 平台模板标识；v1 仅支持 `zenmux`。 */
  type: string
  /** 管理密钥引用（环境变量名/凭据存储引用）。schema 支持，v1 UI 不展示。 */
  managementKeyRef?: string
  /** 明文管理密钥。v1 UI 以明文 secret 编辑，不回显。 */
  managementKey?: string
  resumeNotice: ResumeNoticeConfig
  statsRetry: StatsRetryConfig
  postResetRetry: PostResetRetryConfig
  resetBufferMs: number
}

/** 插件顶层配置（schema 校验并填好默认值后的形态）。 */
export interface Config {
  /** 平台 API base URL。v1 全局唯一，不在实例中。 */
  platformBaseURL: string
  /** 平台实例集合，默认空。 */
  platformInstances: Record<string, PlatformInstanceConfig>
  /** provider 绑定：provider-id → instance-id。 */
  providerBindings: Record<string, string>
}

const instanceSchema = Schema.object({
  type: Schema.string().default(DEFAULT_PLATFORM),
  managementKeyRef: Schema.string().pattern(MANAGEMENT_KEY_REF_PATTERN),
  managementKey: Schema.string().role('secret'),
  resumeNotice: Schema.object({
    enabled: Schema.boolean().default(false),
    template: Schema.string().default(DEFAULT_RESUME_NOTICE_TEMPLATE),
  }).default({
    enabled: false,
    template: DEFAULT_RESUME_NOTICE_TEMPLATE,
  }),
  statsRetry: Schema.object({
    initialDelayMs: Schema.number().min(1).default(DEFAULT_STATS_RETRY.initialDelayMs),
    maxDelayMs: Schema.number().min(1).default(DEFAULT_STATS_RETRY.maxDelayMs),
    totalTimeoutMs: Schema.number().min(1).default(DEFAULT_STATS_RETRY.totalTimeoutMs),
  }).default({ ...DEFAULT_STATS_RETRY }),
  postResetRetry: Schema.object({
    delaysMs: Schema.array(Schema.number().min(1)).default([...DEFAULT_POST_RESET_RETRY_DELAYS_MS]),
  }).default({ delaysMs: [...DEFAULT_POST_RESET_RETRY_DELAYS_MS] }),
  resetBufferMs: Schema.number().min(0).default(DEFAULT_RESET_BUFFER_MS),
})

export const Config = Schema.object({
  platformBaseURL: Schema.string().default(DEFAULT_PLATFORM_BASE_URL),
  platformInstances: Schema.dict(instanceSchema),
  providerBindings: Schema.dict(Schema.string()),
}) as unknown as Schema<Config>

/** 判断一个实例是否配置了凭据（managementKeyRef 与 managementKey 均空即未配置）。 */
export function instanceHasCredential(instance: PlatformInstanceConfig): boolean {
  return !!(instance.managementKeyRef || instance.managementKey)
}

/**
 * 跨字段校验（§6.3）。用于插件加载（base 层 fail loud）与 settings 写入。
 * @param config 已通过 schema 校验的解析值。
 * @param registeredPlatforms 已注册的平台模板名集合（v1 仅 `zenmux`）。
 */
export function validateConfig(
  config: Config,
  registeredPlatforms: ReadonlySet<string>,
): void {
  for (const [instanceId, instance] of Object.entries(config.platformInstances)) {
    if (!INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new TypeError(
        `dsh-auto-continue: instance id "${instanceId}" must match ${INSTANCE_ID_PATTERN}`,
      )
    }
    if (!registeredPlatforms.has(instance.type)) {
      throw new TypeError(
        `dsh-auto-continue: instance "${instanceId}" has unknown platform type "${instance.type}"`,
      )
    }
    if (instance.managementKeyRef && instance.managementKey) {
      throw new TypeError(
        `dsh-auto-continue: instance "${instanceId}" cannot set both managementKeyRef and managementKey`,
      )
    }
    const { initialDelayMs, maxDelayMs, totalTimeoutMs } = instance.statsRetry
    for (const [field, value] of [
      ['statsRetry.initialDelayMs', initialDelayMs],
      ['statsRetry.maxDelayMs', maxDelayMs],
      ['statsRetry.totalTimeoutMs', totalTimeoutMs],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`dsh-auto-continue: instance "${instanceId}" ${field} must be a positive integer`)
      }
    }
    const delays = instance.postResetRetry.delaysMs
    if (delays.length === 0 || delays.some((d) => !Number.isInteger(d) || d <= 0)) {
      throw new TypeError(
        `dsh-auto-continue: instance "${instanceId}" postResetRetry.delaysMs must be a non-empty array of positive integers`,
      )
    }
    if (!Number.isInteger(instance.resetBufferMs) || instance.resetBufferMs < 0) {
      throw new TypeError(
        `dsh-auto-continue: instance "${instanceId}" resetBufferMs must be a non-negative integer`,
      )
    }
  }

  for (const [providerId, instanceId] of Object.entries(config.providerBindings)) {
    if (!config.platformInstances[instanceId]) {
      throw new TypeError(
        `dsh-auto-continue: provider "${providerId}" binds to missing instance "${instanceId}"`,
      )
    }
  }
}
