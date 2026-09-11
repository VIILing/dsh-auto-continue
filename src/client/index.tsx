/**
 * Client entry for the auto-continue settings section.
 *
 * Registers a top-level `settings.section` entry (id = `auto-continue`) so the
 * plugin gets its own standalone tab in the Settings panel, alongside "General",
 * "Models", and "Plugins" — NOT a card nested inside the Plugins page. The
 * section reads/writes settings through the host plugin's own fenced HTTP route
 * (see `api.ts`), not the DSH settings RPC domain, whose allowlist does not
 * serve third-party namespaces.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots). DSH 0.1.5 removed
// `@deepseek-ai/dsh-client-runtime`, whose ClientContext used to carry it.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { AutoContinueSection } from './AutoContinueSection.tsx'
import { en, zh } from './locales.ts'

/**
 * `settings.section` is a list slot declared by the first-party settings domain
 * base (`dsh-client-ui-settings`); a third-party plugin cannot depend on that
 * package, so the declaration is re-stated locally (same shape as the canonical
 * contract). Each entry becomes one nav row in the Settings panel.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.locale.register('auto-continue', 'zh', zh)
  ctx.locale.register('auto-continue', 'en', en)

  // Registration-time nav label follows the active locale via a thunk; the
  // section content receives the framework-synthesized `t` seat through the
  // declared `locale` namespace.
  const t = ctx.locale.bind('auto-continue')
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'auto-continue',
        order: 30,
        label: () => t('nav'),
        locale: 'auto-continue',
      },
      AutoContinueSection,
    ),
  )
}
