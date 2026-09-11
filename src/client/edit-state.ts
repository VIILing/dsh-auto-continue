/**
 * Draft (edit-state) mapping for one platform-instance card.
 *
 * Kept free of React and CSS imports on purpose: the card component renders it,
 * but the row ⇄ draft conversion is pure logic and is unit-tested in
 * `tests/client-edit-state.spec.ts` (the component itself is covered by the
 * Playwright lane).
 */
import { parseOptionsJson, type AutoContinueInstance } from './api.ts'

/** A persisted instance row: the instance value plus its map key. */
export type InstanceRow = AutoContinueInstance & { id: string }

/** One staged instance draft, seeded from a row (or the empty new-instance shape). */
export interface EditState {
  id: string
  isNew: boolean
  type: string
  baseURL: string
  optionsJson: string
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
const DEFAULT_RESUME_TEMPLATE = '因额度限制，本次请求等待了 {hours} 小时 {minutes} 分钟后重新发送。'

/**
 * Seed a staged draft from a persisted row, or the empty new-instance shape.
 * @param defaultType platform template preselected for a new instance
 *   (the first registered template); ignored when the row already names one.
 */
export function toEditState(row: InstanceRow | null, defaultType: string): EditState {
  if (row === null) {
    return {
      id: '',
      isNew: true,
      type: defaultType,
      baseURL: '',
      optionsJson: '',
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
  const options = row.options ?? {}
  return {
    id: row.id,
    isNew: false,
    type: row.type ?? defaultType,
    baseURL: row.baseURL ?? '',
    // 空 options 显示为空框（占位提示即“无”），非空则格式化便于编辑。
    optionsJson: Object.keys(options).length > 0 ? JSON.stringify(options, null, 2) : '',
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

/** Write the staged draft back to an instance value (blank endpoint/key = unset). */
export function editStateToInstance(s: EditState): AutoContinueInstance {
  const baseURL = s.baseURL.trim()
  return {
    type: s.type,
    baseURL: baseURL === '' ? undefined : baseURL,
    options: parseOptionsJson(s.optionsJson) ?? {},
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
