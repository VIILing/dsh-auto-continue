import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  Config,
  STATS_REQUEST_TIMEOUT_MS,
  instanceBaseURL,
  validateConfig,
  type Config as ConfigType,
  type PlatformInstanceConfig,
} from './config.ts'
import { buildResumeNotice } from './notice.ts'
import { describePlatform, type PlatformDescriptor, type PlatformQuotaAdapter } from './platform.ts'
import { builtinPlatformAdapters } from './platforms/index.ts'
import {
  abortableDelay,
  decideWaitAction,
  fetchStatsWithRetry,
  type StatsFetchResult,
} from './recovery.ts'
import {
  beginEpisode,
  createInstanceState,
  type InstanceRuntimeState,
  type QuotaInstanceState,
} from './state.ts'
import { isTrustedApiRequest } from './trust-fence.ts'
import { AutoContinueApiError, readJsonBody, writeError, writeJson, writeOk } from './wire.ts'

const SETTINGS_NAMESPACE = 'auto-continue' as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    quota: QuotaRuntime
  }
  interface Events {
    /** instance 配额/恢复状态发生变化时广播；携带受影响 provider 列表。 */
    'quota/changed'(instanceId: string, state: QuotaInstanceState, affectedProviders: string[]): void
  }
}

interface RequestErrorPayload {
  agent: Agent
  turn: number
  step: number
  provider: string
  failure: LlmFailure
  retryPolicy: unknown
  signal: AbortSignal
}

/**
 * 配额耗尽自动续跑运行时。v2 采用三层模型：平台模板 → 平台实例 → provider 绑定。
 * 恢复状态、`disabled`、统计查询单飞均按 platform instance 键控。
 */
export default class QuotaRuntime extends Service {
  static Config = Config

  private readonly logger: ReturnType<Context['logger']>
  private readonly adapters = new Map<string, PlatformQuotaAdapter>()
  private readonly states = new Map<string, InstanceRuntimeState>()
  private readonly lifetime = new AbortController()
  /** 已提示过“全局 baseURL 覆盖适配器默认端点”的实例（每个实例只提示一次）。 */
  private readonly warnedBaseURLOverride = new Set<string>()
  private currentConfig: () => ConfigType

  constructor(ctx: Context, config: ConfigType) {
    super(ctx, 'quota')
    this.logger = ctx.logger('auto-continue')
    this.currentConfig = () => config

    // 注册内置平台模板（清单在 platforms/index.ts；新增内置平台不改本文件）。
    for (const adapter of builtinPlatformAdapters()) {
      this.adapters.set(adapter.platform, adapter)
    }

    // 加载期校验：结构规则 fail loud；未知平台类型**延后**判定，因为适配器可能由
    // 稍后加载的平台插件注册（第三方扩展点 registerPlatformAdapter）。
    const deferred: string[] = []
    validateConfig(config, this.platformNames(), {
      deferUnknownPlatforms: deferred,
      validateOptions: (platform, instanceId, options) => {
        this.validatePlatformOptions(platform, instanceId, options)
      },
    })
    if (deferred.length > 0) {
      this.logger.warn(
        'dsh-auto-continue: platform type(s) %s are not registered yet; instances of them stay inactive until a platform plugin registers an adapter',
        [...new Set(deferred)].join(', '),
      )
    }

    // 可选 settings 接入：settings 服务存在时，entry config 作为 base 层。
    // DSH 0.1.5 起自由函数 installSettingsSection 被移除，改为
    // SettingsProvider.installSection；原先自带的 ctx.inject 包裹需要自己写。
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
        setSource: (source) => {
          this.currentConfig = source
        },
        onChange: () => {
          this.reconcileInstances()
        },
        // settings 写入路径是**严格**的：此刻所有插件已加载完，未知平台类型必须报错。
        validate: (value) => validateConfig(value, this.platformNames(), {
          validateOptions: (platform, instanceId, options) => {
            this.validatePlatformOptions(platform, instanceId, options)
          },
        }),
      })
    })

    // 插件卸载时取消 lifetime signal，清理进行中的等待。
    ctx.effect(() => () => this.lifetime.abort())

    // 恢复监听器（挂载在根 ctx，未加 scope 标签，接收所有 agent 的事件）。
    const runtime = this
    ctx.on('agent/request-error', function (payload, next) {
      return runtime.handleRequestError(payload, next)
    }, { prepend: true })

    // 成功复位：instance 恢复成功（收到其 provider 的 assistant/message）后回到 idle。
    ctx.on('session/event', function (_session, event) {
      runtime.handleSessionEvent(event)
    })

    // 可选的自建设置路由：为 client 卡片提供 fenced 的 settings + providers API。
    // 不走 DSH settings RPC（其 allowlist 不服务第三方命名空间）。
    ctx.inject(['webServer'], (sctx) => {
      const handler = async (req: IncomingMessage, res: ServerResponse) => {
        const trusted = (sctx.get('webRuntime') as { trustedHosts?: string[] } | undefined)?.trustedHosts ?? []
        if (!isTrustedApiRequest(req, trusted)) {
          writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.slice('/auto-continue/api/'.length)
        if (method === '' || method.includes('/')) {
          writeError(res, new AutoContinueApiError('not-found', 'unknown auto-continue API method', 404))
          return
        }
        try {
          const payload = await readJsonBody(req)
          const value = await runtime.handleApiMethod(sctx, method, payload)
          writeOk(res, value)
        } catch (error) {
          writeError(res, error)
        }
      }
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/auto-continue/api',
        handler,
      }), 'auto-continue: /auto-continue/api routes')
    })
  }

  /** 获取一个 instance 的当前状态快照。 */
  status(instanceId: string): QuotaInstanceState {
    const instance = this.currentConfig().platformInstances[instanceId]
    if (!instance) return { phase: 'unconfigured' }
    return this.getOrCreateState(instanceId, instance).phase
  }

  /** 该 instance 是否已放弃自动续跑。 */
  isDisabled(instanceId: string): boolean {
    const instance = this.currentConfig().platformInstances[instanceId]
    if (!instance) return false
    return this.getOrCreateState(instanceId, instance).phase.phase === 'disabled'
  }

  /** 调试/查询便捷方法：按 provider 查询其绑定 instance 的状态。 */
  statusForProvider(providerId: string): QuotaInstanceState {
    const instanceId = this.currentConfig().providerBindings[providerId]
    if (!instanceId) return { phase: 'unconfigured' }
    return this.status(instanceId)
  }

  /**
   * 已注册平台模板的公开元信息，按 id 排序（UI 平台下拉的数据源）。
   */
  platforms(): PlatformDescriptor[] {
    return [...this.adapters.values()]
      .map(describePlatform)
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * 注册一个平台模板——**第三方接入新平台的唯一入口**。
   *
   * 用法（独立插件，无需修改本插件任何文件）：
   * ```ts
   * ctx.inject(['quota'], (c) => c.quota.registerPlatformAdapter(new MyAdapter()))
   * ```
   * 注册后：`platforms()` / UI 下拉自动出现该平台；实例可用 `type: <platform>`
   * 引用它（含 `cordis.yml` base 层声明——加载期对未知平台只告警不抛错）；
   * 端点由适配器 `defaultBaseURL` 或实例 `baseURL` 决定，互不干扰。
   *
   * 适配器的生命周期挂在 quota 服务上：注册方若可能先于本插件卸载，请调用返回的 disposer，
   * 或在自己的 `ctx.effect(() => ctx.quota.registerPlatformAdapter(adapter))` 中包一层。
   *
   * @returns 注销函数；注销后该平台立即不再被判定链解析。
   */
  registerPlatformAdapter(adapter: PlatformQuotaAdapter): () => void {
    const dispose = this.ctx.effect(() => {
      this.adapters.set(adapter.platform, adapter)
      return () => {
        if (this.adapters.get(adapter.platform) === adapter) {
          this.adapters.delete(adapter.platform)
        }
      }
    })
    return () => void dispose()
  }

  private platformNames(): Set<string> {
    return new Set(this.adapters.keys())
  }

  /** 用适配器声明的 `optionsSchema` 校验实例的平台专属参数（fail loud）。 */
  private validatePlatformOptions(
    platform: string,
    instanceId: string,
    options: Record<string, unknown>,
  ): void {
    const schema = this.adapters.get(platform)?.optionsSchema
    if (schema === undefined) return
    try {
      schema(options)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new TypeError(
        `dsh-auto-continue: instance "${instanceId}" has invalid options for platform "${platform}": ${detail}`,
      )
    }
  }

  /**
   * 解析实例的实际平台端点。优先级：
   * `instance.baseURL` → 全局 `platformBaseURL`（legacy，非空时） → `adapter.defaultBaseURL`。
   * 都无法确定时返回 undefined（调用方 fail safe 到 `next()`）。
   */
  private resolveBaseURL(
    instance: PlatformInstanceConfig,
    adapter: PlatformQuotaAdapter,
  ): string | undefined {
    const override = instanceBaseURL(instance)
    if (override !== undefined) return override

    const global = this.currentConfig().platformBaseURL.trim()
    if (global !== '') {
      const adapterDefault = adapter.defaultBaseURL
      if (adapterDefault !== undefined && adapterDefault !== global && !this.warnedBaseURLOverride.has(instance.type)) {
        this.warnedBaseURLOverride.add(instance.type)
        this.logger.warn(
          'dsh-auto-continue: global platformBaseURL "%s" overrides the "%s" adapter default "%s"; prefer a per-instance baseURL when several platforms are in use',
          global,
          adapter.platform,
          adapterDefault,
        )
      }
      return global
    }
    return adapter.defaultBaseURL
  }

  private reconcileInstances(): void {
    // 为新配置中的 instance 建立状态；旧 instance 状态保留（in-flight 等待不中断）。
    const config = this.currentConfig()
    for (const [instanceId, instance] of Object.entries(config.platformInstances)) {
      this.getOrCreateState(instanceId, instance)
    }
  }

  private getOrCreateState(instanceId: string, instance: PlatformInstanceConfig): InstanceRuntimeState {
    let state = this.states.get(instanceId)
    if (!state) {
      state = createInstanceState(instanceId, instance)
      this.states.set(instanceId, state)
    }
    return state
  }

  private affectedProviders(instanceId: string): string[] {
    const bindings = this.currentConfig().providerBindings
    return Object.entries(bindings)
      .filter(([, id]) => id === instanceId)
      .map(([provider]) => provider)
  }

  private transition(state: InstanceRuntimeState, phase: QuotaInstanceState): void {
    state.phase = phase
    this.ctx.emit('quota/changed', state.instanceId, phase, this.affectedProviders(state.instanceId))
  }

  private async handleRequestError(
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const { provider, failure } = payload
    const config = this.currentConfig()

    // provider → binding → instance。
    const instanceId = config.providerBindings[provider]
    if (!instanceId) return next()
    const instance = config.platformInstances[instanceId]
    if (!instance) return next()

    const state = this.getOrCreateState(instanceId, instance)
    if (state.phase.phase === 'unconfigured') return next()
    if (state.phase.phase === 'disabled') return next()

    const adapter = this.adapters.get(instance.type)
    if (!adapter) return next()
    if (!adapter.matchesQuotaExhausted(failure)) return next()

    return this.runRecovery(payload, provider, instance, adapter, state, next)
  }

  private async runRecovery(
    payload: RequestErrorPayload,
    provider: string,
    instance: PlatformInstanceConfig,
    adapter: PlatformQuotaAdapter,
    state: InstanceRuntimeState,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const { signal } = payload

    // 新 episode（idle 进入）时重置 episode 级标志。
    const isNewEpisode = state.phase.phase === 'idle'
    if (isNewEpisode) beginEpisode(state)

    this.transition(state, { phase: 'checking-stats' })

    // 解析凭据（按 instance）。
    const credential = await this.resolveCredential(instance)
    if (credential === undefined || credential === '') {
      this.logger.warn(
        'dsh-auto-continue: instance "%s" has no resolvable management key; not continuing',
        state.instanceId,
      )
      this.transition(state, { phase: 'idle' })
      return next()
    }

    // 解析平台端点（按 instance）。
    const baseURL = this.resolveBaseURL(instance, adapter)
    if (baseURL === undefined) {
      this.logger.warn(
        'dsh-auto-continue: instance "%s" has no resolvable base URL (platform "%s" declares no default and platformBaseURL is empty); not continuing',
        state.instanceId,
        adapter.platform,
      )
      this.transition(state, { phase: 'idle' })
      return next()
    }

    // 统计查询（单飞，按 instance）。
    const result = await this.fetchStatsSingleFlight(state, instance, adapter, credential, baseURL, signal)
    if (!result.ok) {
      if (result.aborted) return undefined
      this.transition(state, { phase: 'disabled' })
      this.logger.info(
        'dsh-auto-continue: instance "%s" disabled after stats retries exhausted',
        state.instanceId,
      )
      return next()
    }

    const snapshot = result.snapshot
    this.logger.debug('dsh-auto-continue: stats snapshot: %j', snapshot)

    const decision = decideWaitAction({
      snapshot,
      adapter,
      now: Date.now(),
      resetBufferMs: instance.resetBufferMs,
      episodeWaitedReset: state.episodeWaitedReset,
    })

    if (decision.type === 'missing-info') {
      this.logger.warn(
        'dsh-auto-continue: instance "%s" missing reset info; failing normally',
        state.instanceId,
      )
      this.transition(state, { phase: 'idle' })
      return next()
    }

    if (decision.type === 'waiting-reset') {
      return this.waitThenRetry(payload, provider, instance, state, decision.resetAt)
    }
    return this.postResetRetry(payload, instance, state, next)
  }

  private async fetchStatsSingleFlight(
    state: InstanceRuntimeState,
    instance: PlatformInstanceConfig,
    adapter: PlatformQuotaAdapter,
    credential: string,
    baseURL: string,
    _signal: AbortSignal,
  ): Promise<StatsFetchResult> {
    if (!state.statsFlight) {
      state.statsFlight = fetchStatsWithRetry({
        adapter,
        credential,
        baseURL,
        instance,
        statsRetry: instance.statsRetry,
        statsRequestTimeoutMs: STATS_REQUEST_TIMEOUT_MS,
        logger: this.logger,
        lifetimeSignal: this.lifetime.signal,
      }).finally(() => {
        state.statsFlight = null
      })
    }
    return state.statsFlight
  }

  private async waitThenRetry(
    payload: RequestErrorPayload,
    provider: string,
    instance: PlatformInstanceConfig,
    state: InstanceRuntimeState,
    resetAt: number,
  ): Promise<RequestErrorAction> {
    const { signal, agent } = payload
    const startedAt = Date.now()
    this.transition(state, { phase: 'waiting-reset', resetAt })

    const waitMs = Math.max(0, resetAt - Date.now())
    this.logger.info(
      'dsh-auto-continue: instance "%s" waiting for quota reset until %s (%d ms)',
      state.instanceId,
      new Date(resetAt).toISOString(),
      waitMs,
    )

    try {
      await abortableDelay(waitMs, signal, this.lifetime.signal)
    } catch {
      // 取消/卸载：停止等待，不返回 retry，不改变共享状态。
      return undefined
    }

    // resumeNotice：每次 episode 只在首次从 waiting-reset 返回 retry 前追加一次。
    if (instance.resumeNotice.enabled && !state.noticeAppended) {
      try {
        const notice = buildResumeNotice({
          provider,
          startedAtMs: startedAt,
          returnedAtMs: Date.now(),
          template: instance.resumeNotice.template,
        })
        agent.session.append('user/message', notice, { surfaceOp: 'append' })
        state.noticeAppended = true
      } catch (error) {
        this.logger.warn('dsh-auto-continue: resumeNotice append failed: %s', String(error))
      }
    }

    state.episodeWaitedReset = true
    return { kind: 'retry' }
  }

  private async postResetRetry(
    payload: RequestErrorPayload,
    instance: PlatformInstanceConfig,
    state: InstanceRuntimeState,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const { signal } = payload
    const delays = instance.postResetRetry.delaysMs
    const attempts = state.postResetAttempts

    if (attempts >= delays.length) {
      this.transition(state, { phase: 'disabled' })
      this.logger.info(
        'dsh-auto-continue: instance "%s" disabled after post-reset retries exhausted',
        state.instanceId,
      )
      return next()
    }

    const delay = delays[attempts]!
    this.transition(state, { phase: 'post-reset-retrying', attempts })
    this.logger.info(
      'dsh-auto-continue: instance "%s" post-reset retry %d/%d in %d ms',
      state.instanceId,
      attempts + 1,
      delays.length,
      delay,
    )

    try {
      await abortableDelay(delay, signal, this.lifetime.signal)
    } catch {
      return undefined
    }

    state.postResetAttempts = attempts + 1
    this.transition(state, { phase: 'post-reset-retrying', attempts: state.postResetAttempts })
    return { kind: 'retry' }
  }

  private async resolveCredential(instance: PlatformInstanceConfig): Promise<string | undefined> {
    if (instance.managementKey) return instance.managementKey
    const ref = instance.managementKeyRef
    if (!ref) return undefined

    const credentials = this.ctx.get('credentials')
    if (credentials) {
      const resolved = await credentials.resolve(ref as unknown as CredentialRef)
      return resolved?.value
    }
    return launchEnvironmentOf(this.ctx).get(ref)?.value
  }

  private settingsView(settings: NonNullable<Context['settings']>): {
    value?: unknown
    revision?: number
    keyStates: Record<string, boolean>
  } {
    const descriptor = settings.describe({ redactSecrets: true }).find((d) => d.ns === SETTINGS_NAMESPACE)
    const full = settings.describe({ redactSecrets: false }).find((d) => d.ns === SETTINGS_NAMESPACE)?.value as
      | { platformInstances?: Record<string, { managementKey?: string; managementKeyRef?: string }> }
      | undefined
    const keyStates: Record<string, boolean> = {}
    for (const [id, inst] of Object.entries(full?.platformInstances ?? {})) {
      keyStates[id] = !!(inst.managementKey || inst.managementKeyRef)
    }
    return descriptor === undefined
      ? { value: undefined, revision: undefined, keyStates: {} }
      : { value: descriptor.value, revision: descriptor.revision, keyStates }
  }

  private async handleApiMethod(sctx: Context, method: string, payload: unknown): Promise<unknown> {
    if (method === 'providers.list') {
      const llm = sctx.get('llm')
      return llm === undefined ? [] : llm.listProviders()
    }

    // 已注册平台模板（含第三方插件注册的），供 UI 平台下拉数据驱动渲染。
    if (method === 'platforms.list') {
      return this.platforms()
    }

    const settings = sctx.get('settings')
    if (method === 'settings.get') {
      return settings === undefined ? { value: undefined, revision: undefined } : this.settingsView(settings)
    }

    if (method === 'settings.update') {
      if (settings === undefined) {
        throw new AutoContinueApiError('settings-rejected', 'the settings service is not mounted in this deployment', 503)
      }
      const record = payload as { section?: unknown; expectedRevision?: unknown } | null
      const section = record?.section
      if (section === null || typeof section !== 'object' || Array.isArray(section)) {
        throw new AutoContinueApiError('bad-request', 'section must be a plain object')
      }
      const expectedRevision = typeof record?.expectedRevision === 'number' ? record.expectedRevision : undefined

      // 保留 client 未回传的 managementKey（密码框留空 = 不修改）：从当前
      // 解析值里把已有 secret 重新注入到本次要 replace 的 section 中。
      const current = settings.describe({ redactSecrets: false }).find((d) => d.ns === SETTINGS_NAMESPACE)?.value as
        | { platformInstances?: Record<string, { managementKey?: string }> }
        | undefined
      const merged = section as {
        platformInstances?: Record<string, { managementKey?: string }>
        providerBindings?: Record<string, string>
      }
      if (merged.platformInstances !== undefined) {
        for (const [id, inst] of Object.entries(merged.platformInstances)) {
          if ((inst.managementKey === undefined || inst.managementKey === '') && current?.platformInstances?.[id]?.managementKey) {
            inst.managementKey = current.platformInstances[id].managementKey
          }
        }
      }

      await settings.replace(SETTINGS_NAMESPACE, merged as Record<string, unknown>, expectedRevision)
      return this.settingsView(settings)
    }

    throw new AutoContinueApiError('not-found', `unknown auto-continue API method "${method}"`, 404)
  }

  private handleSessionEvent(event: SessionEvent): void {
    if (event.type !== 'assistant/message') return
    const data = event.data
    if (data.interrupted) return
    const message = data.message
    if (message.source.kind !== 'model') return

    const provider = message.source.provider
    const instanceId = this.currentConfig().providerBindings[provider]
    if (!instanceId) return
    const state = this.states.get(instanceId)
    if (!state) return
    if (state.phase.phase !== 'waiting-reset' && state.phase.phase !== 'post-reset-retrying') {
      return
    }
    // 重发成功：回到 idle，清空 episode 标志。
    beginEpisode(state)
    this.transition(state, { phase: 'idle' })
  }
}
