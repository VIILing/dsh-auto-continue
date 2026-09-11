/**
 * Client-side API for the auto-continue settings card. The host plugin
 * exposes a fenced HTTP route at `/auto-continue/api` (self-built transport,
 * mirroring dsh-better-sidebar) with methods `settings.get` / `settings.update`
 * / `providers.list` / `platforms.list`; the card reads/writes settings through
 * this route rather than the DSH settings RPC domain, whose allowlist does not
 * serve third-party namespaces.
 */

export interface AutoContinueInstance {
  type?: string
  /** 实例级平台端点覆盖；留空则用平台模板默认端点。 */
  baseURL?: string
  /** 平台专属参数；结构由所选平台模板决定。 */
  options?: Record<string, unknown>
  managementKeyRef?: string
  managementKey?: string
  resumeNotice?: { enabled?: boolean; template?: string }
  statsRetry?: { initialDelayMs?: number; maxDelayMs?: number; totalTimeoutMs?: number }
  postResetRetry?: { delaysMs?: number[] }
  resetBufferMs?: number
}

export interface AutoContinueSection {
  platformBaseURL?: string
  platformInstances?: Record<string, AutoContinueInstance>
  providerBindings?: Record<string, string>
}

export interface ProviderOption {
  id: string
  name: string
}

/** 一个已注册的平台模板（`platforms.list` 的元素）。 */
export interface PlatformOption {
  id: string
  label: string
}

export interface SettingsView {
  value?: AutoContinueSection
  revision?: number
  /** instance id → 是否已配置凭据（managementKey 或 managementKeyRef）。 */
  keyStates?: Record<string, boolean>
}

async function call<T>(method: string, payload: unknown = {}): Promise<T> {
  const res = await fetch(`/auto-continue/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } }
  if (!res.ok || body.ok !== true) {
    const message = body.error?.message ?? `auto-continue ${method} failed (${res.status})`
    throw new Error(message)
  }
  return body.value as T
}

export function getSettings(): Promise<SettingsView> {
  return call<SettingsView>('settings.get')
}

export function updateSettings(section: Record<string, unknown>, expectedRevision?: number): Promise<SettingsView> {
  return call<SettingsView>('settings.update', { section, expectedRevision })
}

export function listProviders(): Promise<ProviderOption[]> {
  return call<ProviderOption[]>('providers.list')
}

/** 已注册的平台模板列表（含第三方插件注册的），驱动平台下拉渲染。 */
export function listPlatforms(): Promise<PlatformOption[]> {
  return call<PlatformOption[]>('platforms.list')
}

/** 解析平台专属参数输入框；返回 null 表示非法（非对象或非法 JSON）。 */
export function parseOptionsJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** 实例级端点校验：留空合法（用平台模板默认端点），非空则需 http(s)。 */
export function isValidBaseURLInput(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '' || /^https?:\/\//.test(trimmed)
}

/** 合并一次实例编辑：重建该实例并重建指向它的 provider 绑定。 */
export function buildInstanceEdit(
  current: AutoContinueSection,
  instanceId: string,
  instance: AutoContinueInstance,
  boundProviderIds: string[],
): { platformInstances: Record<string, AutoContinueInstance>; providerBindings: Record<string, string> } {
  const instances = { ...(current.platformInstances ?? {}) }
  instances[instanceId] = { ...(instances[instanceId] ?? {}), ...instance }

  const bindings = { ...(current.providerBindings ?? {}) }
  for (const [provider, bound] of Object.entries(bindings)) {
    if (bound === instanceId) delete bindings[provider]
  }
  for (const provider of boundProviderIds) bindings[provider] = instanceId

  return { platformInstances: instances, providerBindings: bindings }
}

/** 删除实例并解绑其下所有 provider。 */
export function buildInstanceDelete(
  current: AutoContinueSection,
  instanceId: string,
): { platformInstances: Record<string, AutoContinueInstance>; providerBindings: Record<string, string> } {
  const instances = { ...(current.platformInstances ?? {}) }
  delete instances[instanceId]

  const bindings = { ...(current.providerBindings ?? {}) }
  for (const [provider, bound] of Object.entries(bindings)) {
    if (bound === instanceId) delete bindings[provider]
  }

  return { platformInstances: instances, providerBindings: bindings }
}
