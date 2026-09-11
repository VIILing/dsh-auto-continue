/**
 * The auto-continue Settings section: a title/intro, the platform-instance card
 * list (each card expandable in place), and the dashed "add instance" affordance
 * at the bottom — mirroring the DSH Plugins card list and the Models "add
 * provider" button. All reads/writes go through the host plugin's own fenced
 * route (see `api.ts`).
 */
import { useCallback, useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  buildInstanceDelete,
  buildInstanceEdit,
  getSettings,
  listPlatforms,
  listProviders,
  updateSettings,
  type AutoContinueInstance,
  type PlatformOption,
  type ProviderOption,
  type SettingsView,
} from './api.ts'
import { editStateToInstance, type EditState } from './edit-state.ts'
import { InstanceCard } from './InstanceCard.tsx'
import css from './AutoContinueSection.module.css'

type InstanceRow = AutoContinueInstance & { id: string }

export function AutoContinueSection({ t }: { t: TranslateNS<'auto-continue'> }) {
  const [rows, setRows] = useState<InstanceRow[]>([])
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [platforms, setPlatforms] = useState<PlatformOption[]>([])
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({})
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [saveNonce, setSaveNonce] = useState(0)

  const reload = useCallback(async () => {
    try {
      const view = await getSettings()
      const section = view.value ?? {}
      const instances = section.platformInstances ?? {}
      setRows(Object.entries(instances).map(([id, inst]) => ({ id, ...(inst ?? {}) })))
      setBindings(section.providerBindings ?? {})
      setKeyStates(view.keyStates ?? {})
      setRevision(view.revision)
      setProviders(await listProviders())
      setPlatforms(await listPlatforms())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'))
    }
  }, [t])

  useEffect(() => {
    void reload()
  }, [reload])

  const boundOf = useCallback(
    (instanceId: string): string[] =>
      Object.entries(bindings).filter(([, id]) => id === instanceId).map(([provider]) => provider),
    [bindings],
  )

  const applyView = useCallback((view: SettingsView) => {
    const section = view.value ?? {}
    setRows(Object.entries(section.platformInstances ?? {}).map(([id, inst]) => ({ id, ...(inst ?? {}) })))
    setBindings(section.providerBindings ?? {})
    setKeyStates(view.keyStates ?? {})
    setRevision(view.revision)
  }, [])

  const persist = useCallback(async (next: { platformInstances: Record<string, AutoContinueInstance>; providerBindings: Record<string, string> }) => {
    try {
      const view = await updateSettings(next, revision)
      applyView(view)
      setSaveNonce((n) => n + 1)
      setAdding(false)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'))
    }
  }, [revision, t, applyView])

  const saveInstance = useCallback((edit: EditState) => {
    const current = {
      platformInstances: Object.fromEntries(rows.map((r) => [r.id, r as AutoContinueInstance])),
      providerBindings: bindings,
    }
    return persist(buildInstanceEdit(current, edit.id, editStateToInstance(edit), edit.boundProviderIds))
  }, [rows, bindings, persist])

  const removeInstance = useCallback((id: string) => {
    const current = {
      platformInstances: Object.fromEntries(rows.map((r) => [r.id, r as AutoContinueInstance])),
      providerBindings: bindings,
    }
    return persist(buildInstanceDelete(current, id))
  }, [rows, bindings, persist])

  // Providers a card may bind: those already bound to it, plus any not bound elsewhere.
  const selectableProviders = useCallback(
    (instanceId: string): ProviderOption[] => {
      const boundHere = new Set(boundOf(instanceId))
      return providers.filter((p) => boundHere.has(p.id) || !Object.values(bindings).includes(p.id))
    },
    [providers, bindings, boundOf],
  )

  return (
    <div data-dsh-auto-continue className={css.section}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}
      {rows.length === 0 && !adding ? <p className={css.empty}>{t('empty')}</p> : null}
      <ul className={css.cards}>
        {rows.map((row) => (
          <InstanceCard
            key={`${row.id}@${saveNonce}`}
            row={row}
            keySet={keyStates[row.id] ?? false}
            platforms={platforms}
            boundProviderIds={boundOf(row.id)}
            providers={selectableProviders(row.id)}
            onSave={saveInstance}
            onDelete={() => removeInstance(row.id)}
            t={t}
          />
        ))}
        {adding
          ? (
            <InstanceCard
              key={`__new__@${saveNonce}`}
              row={null}
              keySet={false}
              platforms={platforms}
              boundProviderIds={[]}
              providers={selectableProviders('')}
              onSave={saveInstance}
              onCancel={() => { setAdding(false) }}
              t={t}
            />
          )
          : null}
      </ul>
      {!adding
        ? (
          <button type="button" className={css.addButton} data-dsh-auto-continue-add onClick={() => { setAdding(true) }}>
            <IconPlusOutline16 size={14} />
            {t('add')}
          </button>
        )
        : null}
    </div>
  )
}
