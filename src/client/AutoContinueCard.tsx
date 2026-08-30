import { useCallback, useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  buildInstanceDelete,
  buildInstanceEdit,
  getSettings,
  listProviders,
  updateSettings,
  type AutoContinueInstance,
  type ProviderOption,
} from './api.ts'

type InstanceRow = AutoContinueInstance & { id: string }

interface EditState {
  id: string
  isNew: boolean
  type: string
  managementKey: string
  resumeEnabled: boolean
  resumeTemplate: string
  initialDelayMs: string
  maxDelayMs: string
  totalTimeoutMs: string
  delaysMs: string
  resetBufferMs: string
  boundProviderIds: string[]
}

const DEFAULT_DELAYS = '60000,120000,240000,480000,900000'

function toEditState(row: InstanceRow | null): EditState {
  if (row === null) {
    return {
      id: '',
      isNew: true,
      type: 'zenmux',
      managementKey: '',
      resumeEnabled: false,
      resumeTemplate: '因额度限制，本次请求等待了 {hours} 小时 {minutes} 分钟后重新发送。',
      initialDelayMs: '60000',
      maxDelayMs: '900000',
      totalTimeoutMs: '3600000',
      delaysMs: DEFAULT_DELAYS,
      resetBufferMs: '5000',
      boundProviderIds: [],
    }
  }
  return {
    id: row.id,
    isNew: false,
    type: row.type ?? 'zenmux',
    managementKey: '',
    resumeEnabled: row.resumeNotice?.enabled ?? false,
    resumeTemplate: row.resumeNotice?.template ?? '因额度限制，本次请求等待了 {hours} 小时 {minutes} 分钟后重新发送。',
    initialDelayMs: String(row.statsRetry?.initialDelayMs ?? 60000),
    maxDelayMs: String(row.statsRetry?.maxDelayMs ?? 900000),
    totalTimeoutMs: String(row.statsRetry?.totalTimeoutMs ?? 3600000),
    delaysMs: (row.postResetRetry?.delaysMs ?? [60000, 120000, 240000, 480000, 900000]).join(','),
    resetBufferMs: String(row.resetBufferMs ?? 5000),
    boundProviderIds: [],
  }
}

function editStateToInstance(s: EditState): AutoContinueInstance {
  return {
    type: s.type,
    managementKey: s.managementKey === '' ? undefined : s.managementKey,
    resumeNotice: {
      enabled: s.resumeEnabled,
      template: s.resumeTemplate,
    },
    statsRetry: {
      initialDelayMs: Number(s.initialDelayMs),
      maxDelayMs: Number(s.maxDelayMs),
      totalTimeoutMs: Number(s.totalTimeoutMs),
    },
    postResetRetry: {
      delaysMs: s.delaysMs.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0),
    },
    resetBufferMs: Number(s.resetBufferMs),
  }
}

export function AutoContinueCard({ t }: { t: TranslateNS<'auto-continue'> }) {

  const [rows, setRows] = useState<InstanceRow[]>([])
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({})
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditState | null>(null)

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
      Object.entries(bindings).filter(([, id]) => id === instanceId).map(([p]) => p),
    [bindings],
  )

  const persist = useCallback(
    async (next: { platformInstances: Record<string, AutoContinueInstance>; providerBindings: Record<string, string> }) => {
      try {
        const view = await updateSettings(next, revision)
        const section = view.value ?? {}
        setRows(Object.entries(section.platformInstances ?? {}).map(([id, inst]) => ({ id, ...(inst ?? {}) })))
        setBindings(section.providerBindings ?? {})
        setKeyStates(view.keyStates ?? {})
        setRevision(view.revision)
        setEditing(null)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('saveFailed'))
      }
    },
    [revision, t],
  )

  const startEdit = useCallback(
    (row: InstanceRow | null) => {
      const state = toEditState(row)
      state.boundProviderIds = row === null ? [] : boundOf(row.id)
      setEditing(state)
    },
    [boundOf],
  )

  const save = useCallback(() => {
    if (editing === null) return
    const current = {
      platformInstances: Object.fromEntries(rows.map((r) => [r.id, r as AutoContinueInstance])),
      providerBindings: bindings,
    }
    void persist(buildInstanceEdit(current, editing.id, editStateToInstance(editing), editing.boundProviderIds))
  }, [editing, rows, bindings, persist])

  const remove = useCallback(
    (row: InstanceRow) => {
      if (!window.confirm(boundOf(row.id).length > 0 ? t('deleteConfirmBound') : t('deleteConfirm'))) return
      const current = {
        platformInstances: Object.fromEntries(rows.map((r) => [r.id, r as AutoContinueInstance])),
        providerBindings: bindings,
      }
      void persist(buildInstanceDelete(current, row.id))
    },
    [rows, bindings, boundOf, persist, t],
  )

  // Provider 绑定多选：已绑定到其它实例的 provider 在本实例列表中隐藏。
  const selectableProviders = useCallback(
    (instanceId: string): ProviderOption[] => {
      const boundHere = new Set(boundOf(instanceId))
      return providers.filter((p) => boundHere.has(p.id) || !Object.values(bindings).includes(p.id))
    },
    [providers, bindings, boundOf],
  )

  return (
    <div data-dsh-auto-continue>
      {error !== null ? <div role="alert">{error}</div> : null}
      {rows.length === 0 && editing === null ? <div>{t('empty')}</div> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <strong>{row.id}</strong>
            <span>{row.type ?? 'zenmux'}</span>
            <span>{keyStates[row.id] ? t('keySet') : t('keyUnset')}</span>
            <span>{row.resumeNotice?.enabled ? t('resumeNoticeOn') : t('resumeNoticeOff')}</span>
            <button type="button" onClick={() => startEdit(row)}>{t('edit')}</button>
            <button type="button" onClick={() => remove(row)}>{t('delete')}</button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => startEdit(null)}>{t('add')}</button>
      {editing !== null ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <div>
            <label>{t('id')}</label>
            <input
              value={editing.id}
              disabled={!editing.isNew}
              placeholder={t('idPlaceholder')}
              onChange={(e) => setEditing({ ...editing, id: e.target.value })}
            />
          </div>
          <div>
            <label>{t('type')}</label>
            <select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
              <option value="zenmux">zenmux</option>
            </select>
          </div>
          <div>
            <label>{t('managementKey')}</label>
            <input
              type="password"
              placeholder={t('managementKeyPlaceholder')}
              value={editing.managementKey}
              onChange={(e) => setEditing({ ...editing, managementKey: e.target.value })}
            />
          </div>
          <div>
            <label>
              <input
                type="checkbox"
                checked={editing.resumeEnabled}
                onChange={(e) => setEditing({ ...editing, resumeEnabled: e.target.checked })}
              />
              {t('resumeNoticeEnabled')}
            </label>
          </div>
          <div>
            <label>{t('resumeNoticeTemplate')}</label>
            <input
              value={editing.resumeTemplate}
              onChange={(e) => setEditing({ ...editing, resumeTemplate: e.target.value })}
            />
          </div>
          <div>
            <label>{t('statsRetryInitial')}</label>
            <input value={editing.initialDelayMs} onChange={(e) => setEditing({ ...editing, initialDelayMs: e.target.value })} />
          </div>
          <div>
            <label>{t('statsRetryMax')}</label>
            <input value={editing.maxDelayMs} onChange={(e) => setEditing({ ...editing, maxDelayMs: e.target.value })} />
          </div>
          <div>
            <label>{t('statsRetryTotal')}</label>
            <input value={editing.totalTimeoutMs} onChange={(e) => setEditing({ ...editing, totalTimeoutMs: e.target.value })} />
          </div>
          <div>
            <label>{t('postResetDelays')}</label>
            <input value={editing.delaysMs} onChange={(e) => setEditing({ ...editing, delaysMs: e.target.value })} />
            <small>{t('postResetDelaysHint')}</small>
          </div>
          <div>
            <label>{t('resetBuffer')}</label>
            <input value={editing.resetBufferMs} onChange={(e) => setEditing({ ...editing, resetBufferMs: e.target.value })} />
          </div>
          <fieldset>
            <legend>{t('providers')}</legend>
            {selectableProviders(editing.id).map((p) => (
              <label key={p.id}>
                <input
                  type="checkbox"
                  checked={editing.boundProviderIds.includes(p.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...editing.boundProviderIds, p.id]
                      : editing.boundProviderIds.filter((id) => id !== p.id)
                    setEditing({ ...editing, boundProviderIds: next })
                  }}
                />
                {p.id}
              </label>
            ))}
          </fieldset>
          <button type="submit">{t('save')}</button>
          <button type="button" onClick={() => setEditing(null)}>{t('cancel')}</button>
        </form>
      ) : null}
    </div>
  )
}
