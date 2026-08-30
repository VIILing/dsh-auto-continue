/**
 * Client entry for the auto-continue settings card.
 *
 * Registers a `settings.plugin.item` card keyed by the `auto-continue` settings
 * namespace. The card reads/writes settings through the host plugin's own
 * fenced HTTP route (see `api.ts`), not the DSH settings RPC domain, whose
 * allowlist does not serve third-party namespaces.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AutoContinueCard } from './AutoContinueCard.tsx'
import { en, zh } from './locales.ts'

/**
 * `settings.plugin.item` 是 keyed slot，由第一方包 `dsh-client-ui-settings-plugins`
 * 在运行时声明、其类型也住在该包内；第三方插件不依赖该包，故在此本地补声明。
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.plugin.item': {
      kind: 'keyed'
      scope: 'root'
      owner: { children?: never }
    }
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.locale.register('auto-continue', 'zh', zh)
  ctx.locale.register('auto-continue', 'en', en)

  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      {
        name: 'settings.plugin.item',
        key: 'auto-continue',
        locale: 'auto-continue',
      },
      AutoContinueCard,
    ),
  )
}
