import type { PlatformQuotaAdapter } from '../platform.ts'
import { ZenMuxAdapter } from './zenmux.ts'

/**
 * 内置平台模板清单。
 *
 * **新增一个内置平台 = 新建 `platforms/<name>.ts` 实现 `PlatformQuotaAdapter`，
 * 然后在这个数组里追加一个实例。** 通用代码（状态机、UI、设置、路由）不需要任何改动：
 * UI 的平台下拉与端点解析都从适配器元信息读取（见 `PlatformDescriptor`）。
 *
 * 第三方平台不必改本文件，写一个调用 `ctx.quota.registerPlatformAdapter(...)` 的插件即可。
 */
export function builtinPlatformAdapters(): PlatformQuotaAdapter[] {
  return [new ZenMuxAdapter()]
}
