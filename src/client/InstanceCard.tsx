/**
 * One platform-instance card: a header naming the instance (with credential /
 * resume-notice state), disclosing its edit form in place, with save / discard /
 * delete. Disclosure and the staged draft are card-local: collapsing keeps the
 * draft, and a successful save remounts the card (parent bumps a key) so it
 * collapses and re-seeds from the persisted value.
 */
import { useId, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AutoContinueInstance, ProviderOption } from './api.ts'
import css from './AutoContinueSection.module.css'

type InstanceRow = AutoContinueInstance & { id: string }

/** One staged instance draft, seeded from a row (or the empty new-instance shape). */
export interface EditState {
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

const INSTANCE_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const DEFAULT_DELAYS = '60000,120000,240000,480000,900000'
const DEFAULT_RESUME_TEMPLATE = '因额度限制，本次请求等待了 {hours} 小时 {minutes} 分钟后重新发送。'

export function toEditState(row: InstanceRow | null): EditState {
  if (row === null) {
    return {
      id: '',
      isNew: true,
      type: 'zenmux',
      managementKey: '',
      resumeEnabled: false,
      resumeTemplate: DEFAULT_RESUME_TEMPLATE,
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
    resumeTemplate: row.resumeNotice?.template ?? DEFAULT_RESUME_TEMPLATE,
    initialDelayMs: String(row.statsRetry?.initialDelayMs ?? 60000),
    maxDelayMs: String(row.statsRetry?.maxDelayMs ?? 900000),
    totalTimeoutMs: String(row.statsRetry?.totalTimeoutMs ?? 3600000),
    delaysMs: (row.postResetRetry?.delaysMs ?? [60000, 120000, 240000, 480000, 900000]).join(','),
    resetBufferMs: String(row.resetBufferMs ?? 5000),
    boundProviderIds: [],
  }
}

export function editStateToInstance(s: EditState): AutoContinueInstance {
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

interface FieldProps {
  id: string
  label: string
  hint?: string
  invalid?: boolean
  invalidLabel?: string
  children: ReactNode
}

function Field({ id, label, hint, invalid, invalidLabel, children }: FieldProps) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={id}>{label}</label>
      </div>
      {children}
      {invalid
        ? <p className={css.invalid}>{invalidLabel}</p>
        : hint !== undefined ? <p className={css.hint}>{hint}</p> : null}
    </div>
  )
}

interface InstanceCardProps {
  /** The persisted row this card edits; null = the new-instance draft card. */
  row: InstanceRow | null
  /** Whether a credential is configured for this instance (header badge). */
  keySet: boolean
  /** Providers currently bound to this instance (persisted). */
  boundProviderIds: string[]
  /** Providers this card may bind (already filtered by the parent). */
  providers: ProviderOption[]
  /** Write the staged draft; resolves once the Host settled. */
  onSave: (edit: EditState) => Promise<void>
  /** Delete this instance; resolves once the Host settled. */
  onDelete?: () => Promise<void>
  /** Cancel the new-instance draft (only when `row === null`). */
  onCancel?: () => void
  t: TranslateNS<'auto-continue'>
}

export function InstanceCard(props: InstanceCardProps) {
  const { row, keySet, boundProviderIds, providers, onSave, onDelete, onCancel, t } = props
  const isNew = row === null
  const uid = useId()
  const [open, setOpen] = useState(isNew)
  const [draft, setDraft] = useState<EditState>(() => {
    const seeded = toEditState(row)
    seeded.boundProviderIds = [...boundProviderIds]
    return seeded
  })
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const idInvalid = isNew && !INSTANCE_ID_PATTERN.test(draft.id.trim())
  const numericInvalid = [draft.initialDelayMs, draft.maxDelayMs, draft.totalTimeoutMs, draft.resetBufferMs]
    .some((value) => !Number.isFinite(Number(value)))
  const blocked = idInvalid || numericInvalid || saving

  const title = isNew ? t('add') : (row?.id ?? '')
  const description = draft.type

  const discard = () => {
    if (isNew) {
      onCancel?.()
      return
    }
    const reseeded = toEditState(row)
    reseeded.boundProviderIds = [...boundProviderIds]
    setDraft(reseeded)
    setOpen(false)
  }

  const save = async () => {
    if (blocked) return
    setSaving(true)
    try {
      await onSave(draft)
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (saving) return
    setSaving(true)
    try {
      await onDelete?.()
    } finally {
      setSaving(false)
      setConfirming(false)
    }
  }

  const toggleProvider = (providerId: string) => {
    const next = draft.boundProviderIds.includes(providerId)
      ? draft.boundProviderIds.filter((id) => id !== providerId)
      : [...draft.boundProviderIds, providerId]
    setDraft({ ...draft, boundProviderIds: next })
  }

  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card} data-dsh-auto-continue-card>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{description}</span>
        </span>
        {!isNew
          ? (
            <span className={css.badges}>
              <span className={keySet ? css.badge : css.badgeMuted}>
                {keySet ? t('keySet') : t('keyUnset')}
              </span>
              <span className={row?.resumeNotice?.enabled ? css.badge : css.badgeMuted}>
                {row?.resumeNotice?.enabled ? t('resumeNoticeOn') : t('resumeNoticeOff')}
              </span>
            </span>
          )
          : null}
        <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>

      {open
        ? (
          <div className={css.body}>
            <Field
              id={`${uid}-id`}
              label={t('id')}
              hint={t('idPlaceholder')}
              invalid={idInvalid}
              invalidLabel={t('idInvalid')}
            >
              <input
                id={`${uid}-id`}
                className={idInvalid ? `${css.input} ${css.inputInvalid}` : css.input}
                data-dsh-auto-continue-id
                value={draft.id}
                disabled={!isNew}
                placeholder={t('idPlaceholder')}
                onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }}
              />
            </Field>

            <Field id={`${uid}-type`} label={t('type')}>
              <select
                id={`${uid}-type`}
                className={css.select}
                value={draft.type}
                onChange={(event) => { setDraft({ ...draft, type: event.target.value }) }}
              >
                <option value="zenmux">zenmux</option>
              </select>
            </Field>

            <Field id={`${uid}-key`} label={t('managementKey')} hint={t('managementKeyHint')}>
              <input
                id={`${uid}-key`}
                className={css.input}
                type="password"
                autoComplete="off"
                value={draft.managementKey}
                placeholder={t('managementKeyPlaceholder')}
                onChange={(event) => { setDraft({ ...draft, managementKey: event.target.value }) }}
              />
            </Field>

            <div className={css.field}>
              <label className={css.checkRow}>
                <input
                  type="checkbox"
                  checked={draft.resumeEnabled}
                  onChange={(event) => { setDraft({ ...draft, resumeEnabled: event.target.checked }) }}
                />
                {t('resumeNoticeEnabled')}
              </label>
            </div>

            <Field id={`${uid}-template`} label={t('resumeNoticeTemplate')}>
              <input
                id={`${uid}-template`}
                className={css.input}
                value={draft.resumeTemplate}
                onChange={(event) => { setDraft({ ...draft, resumeTemplate: event.target.value }) }}
              />
            </Field>

            <Field id={`${uid}-initial`} label={t('statsRetryInitial')} invalid={!Number.isFinite(Number(draft.initialDelayMs))} invalidLabel={t('invalidNumber')}>
              <input
                id={`${uid}-initial`}
                className={!Number.isFinite(Number(draft.initialDelayMs)) ? `${css.input} ${css.inputInvalid}` : css.input}
                inputMode="numeric"
                value={draft.initialDelayMs}
                onChange={(event) => { setDraft({ ...draft, initialDelayMs: event.target.value }) }}
              />
            </Field>

            <Field id={`${uid}-max`} label={t('statsRetryMax')} invalid={!Number.isFinite(Number(draft.maxDelayMs))} invalidLabel={t('invalidNumber')}>
              <input
                id={`${uid}-max`}
                className={!Number.isFinite(Number(draft.maxDelayMs)) ? `${css.input} ${css.inputInvalid}` : css.input}
                inputMode="numeric"
                value={draft.maxDelayMs}
                onChange={(event) => { setDraft({ ...draft, maxDelayMs: event.target.value }) }}
              />
            </Field>

            <Field id={`${uid}-total`} label={t('statsRetryTotal')} invalid={!Number.isFinite(Number(draft.totalTimeoutMs))} invalidLabel={t('invalidNumber')}>
              <input
                id={`${uid}-total`}
                className={!Number.isFinite(Number(draft.totalTimeoutMs)) ? `${css.input} ${css.inputInvalid}` : css.input}
                inputMode="numeric"
                value={draft.totalTimeoutMs}
                onChange={(event) => { setDraft({ ...draft, totalTimeoutMs: event.target.value }) }}
              />
            </Field>

            <Field id={`${uid}-delays`} label={t('postResetDelays')} hint={t('postResetDelaysHint')}>
              <input
                id={`${uid}-delays`}
                className={css.input}
                value={draft.delaysMs}
                onChange={(event) => { setDraft({ ...draft, delaysMs: event.target.value }) }}
              />
            </Field>

            <Field id={`${uid}-buffer`} label={t('resetBuffer')} invalid={!Number.isFinite(Number(draft.resetBufferMs))} invalidLabel={t('invalidNumber')}>
              <input
                id={`${uid}-buffer`}
                className={!Number.isFinite(Number(draft.resetBufferMs)) ? `${css.input} ${css.inputInvalid}` : css.input}
                inputMode="numeric"
                value={draft.resetBufferMs}
                onChange={(event) => { setDraft({ ...draft, resetBufferMs: event.target.value }) }}
              />
            </Field>

            <div className={css.field}>
              <div className={css.head}>
                <span className={css.label}>{t('providers')}</span>
              </div>
              {providers.length === 0
                ? <p className={css.hint}>{t('noProviders')}</p>
                : (
                  <div className={css.checkList}>
                    {providers.map((provider) => (
                      <label className={css.checkRow} key={provider.id}>
                        <input
                          type="checkbox"
                          checked={draft.boundProviderIds.includes(provider.id)}
                          onChange={() => { toggleProvider(provider.id) }}
                        />
                        {provider.name ?? provider.id}
                      </label>
                    ))}
                  </div>
                )}
              <p className={css.hint}>{t('providersHint')}</p>
            </div>

            <div className={css.footer}>
              {onDelete !== undefined
                ? (
                  <button type="button" className={css.danger} onClick={() => { setConfirming(true) }}>
                    {t('delete')}
                  </button>
                )
                : null}
              <button type="button" className={css.discard} onClick={discard}>
                {isNew ? t('cancel') : t('discard')}
              </button>
              <button type="button" className={css.save} data-dsh-auto-continue-save disabled={blocked} onClick={save}>
                {saving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        )
        : null}

      <Modal
        open={confirming}
        onClose={() => { setConfirming(false) }}
        title={t('deleteTitle')}
        closeLabel={t('cancel')}
        description={boundProviderIds.length > 0 ? t('deleteConfirmBound') : t('deleteConfirm')}
        footer={(
          <>
            <button type="button" className={css.discard} autoFocus onClick={() => { setConfirming(false) }}>
              {t('cancel')}
            </button>
            <button type="button" className={css.danger} disabled={saving} onClick={remove}>
              {t('delete')}
            </button>
          </>
        )}
      />
    </li>
  )
}
