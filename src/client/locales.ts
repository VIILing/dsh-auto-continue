/** zh/en dictionaries registered under the `auto-continue` locale namespace. */

export const zh = {
  empty: '尚未配置平台实例。点击“新增”创建第一个实例。',
  add: '新增',
  edit: '编辑',
  delete: '删除',
  save: '保存',
  cancel: '取消',
  id: '实例 id',
  idPlaceholder: '如 zenmux-main（小写字母/数字/连字符）',
  type: '类型',
  managementKey: '管理密钥',
  managementKeyPlaceholder: '留空表示不修改',
  keySet: '明文密钥已设置',
  keyUnset: '未设置',
  resumeNotice: '重发提示',
  resumeNoticeOn: '提示开启',
  resumeNoticeOff: '提示关闭',
  resumeNoticeEnabled: '开启重发提示',
  resumeNoticeTemplate: '提示模板',
  statsRetryInitial: '统计退避初始等待 (ms)',
  statsRetryMax: '统计退避单次上限 (ms)',
  statsRetryTotal: '统计退避总时长上限 (ms)',
  postResetDelays: '重置后重试等待序列 (ms)',
  postResetDelaysHint: '逗号分隔，如 60000,120000,240000,480000,900000',
  resetBuffer: '重置缓冲 (ms)',
  providers: 'Provider 绑定',
  deleteConfirm: '确定删除该实例吗？',
  deleteConfirmBound: '该实例仍绑定 provider，删除后这些 provider 将不再自动续跑。',
  loadFailed: '加载设置失败',
  saveFailed: '保存失败',
} as const

export const en = {
  empty: 'No platform instance configured yet. Click "Add" to create the first one.',
  add: 'Add',
  edit: 'Edit',
  delete: 'Delete',
  save: 'Save',
  cancel: 'Cancel',
  id: 'Instance id',
  idPlaceholder: 'e.g. zenmux-main (lowercase letters / digits / hyphen)',
  type: 'Type',
  managementKey: 'Management key',
  managementKeyPlaceholder: 'Leave blank to keep unchanged',
  keySet: 'Secret set',
  keyUnset: 'Not set',
  resumeNotice: 'Resume notice',
  resumeNoticeOn: 'Notice on',
  resumeNoticeOff: 'Notice off',
  resumeNoticeEnabled: 'Enable resume notice',
  resumeNoticeTemplate: 'Template',
  statsRetryInitial: 'Stats retry initial delay (ms)',
  statsRetryMax: 'Stats retry max delay (ms)',
  statsRetryTotal: 'Stats retry total timeout (ms)',
  postResetDelays: 'Post-reset retry delays (ms)',
  postResetDelaysHint: 'Comma-separated, e.g. 60000,120000,240000,480000,900000',
  resetBuffer: 'Reset buffer (ms)',
  providers: 'Provider bindings',
  deleteConfirm: 'Delete this instance?',
  deleteConfirmBound: 'This instance still has bound providers; deleting it will unbind them and stop auto-continue for those providers.',
  loadFailed: 'Failed to load settings',
  saveFailed: 'Failed to save',
} as const

export type AutoContinueLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'auto-continue': AutoContinueLocaleKey
  }
}
