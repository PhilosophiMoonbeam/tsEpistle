import {
  storageActionDefinition,
  storageConfigurationIssues,
  type StorageField,
  type StorageModuleDefinition,
  type StorageTargetView,
  type StorageValue
} from '../../shared/storage-workspace.ts'

export interface StorageConfigurationRow {
  key: string
  isEnabled: boolean
  mode: string
  syncInterval: string
  config: Record<string, unknown>
  state: Record<string, unknown>
}
export const storageRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
const safeKey = (key: string) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key)
export const storageModuleDefinition = (value: unknown): StorageModuleDefinition => {
  const row = storageRecord(value),
    key = text(row.key),
    props = storageRecord(row.props),
    fields: StorageField[] = []
  for (const [key, value] of Object.entries(props)) {
    if (row.key === 'git' && key === 'dotContentReview') continue
    const field = storageRecord(value),
      type = text(field.type).toLowerCase()
    if (!safeKey(key) || !['string', 'number', 'boolean'].includes(type)) continue
    const defaultValue = typeof field.default === type ? (field.default as StorageValue) : type === 'string' ? '' : type === 'boolean' ? false : 0
    fields.push({
      key,
      title: text(field.title, key),
      hint: text(field.hint),
      type: type as StorageField['type'],
      default: defaultValue,
      sensitive: field.sensitive === true,
      multiline: field.multiline === true,
      order: typeof field.order === 'number' ? field.order : 100,
      options: Array.isArray(field.enum)
        ? field.enum
            .filter((value): value is string => typeof value === 'string')
            .map((value) => {
              const [key, ...label] = value.split('|')
              return { value: key ?? '', title: label.join('|') || key || '' }
            })
        : []
    })
  }
  const declared = Array.isArray(row.actions) ? row.actions : [],
    actions = declared.flatMap((value) => {
      const action = storageActionDefinition(key, text(storageRecord(value).handler))
      return action ? [action] : []
    })
  const known = ['disk', 'git', 's3', 's3generic', 'digitalocean', 'azure', 'sftp'].includes(key)
  return {
    key,
    title: text(row.title, key),
    description: text(row.description),
    isAvailable: known && row.isAvailable === true,
    modes: Array.isArray(row.supportedModes) ? row.supportedModes.filter((mode): mode is string => typeof mode === 'string') : [],
    defaultMode: text(row.defaultMode, 'push'),
    schedule: typeof row.schedule === 'string' ? row.schedule : false,
    internalSchedule: typeof row.internalSchedule === 'string' ? row.internalSchedule : false,
    fields: fields.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    actions
  }
}
export const storageTargetView = (row: StorageConfigurationRow, definition: StorageModuleDefinition | undefined): StorageTargetView => {
  const declared = definition ?? storageModuleDefinition({ key: row.key, title: row.key }),
    module = declared.key === 'git' ? { ...declared, fields: declared.fields.filter(field => field.key !== 'dotContentReview') } : declared,
    config: Record<string, StorageValue> = {},
    secrets: Record<string, boolean> = {},
    raw = storageRecord(row.config)
  for (const field of module.fields) {
    if (field.sensitive) secrets[field.key] = typeof raw[field.key] === 'string' && String(raw[field.key]).length > 0
    else config[field.key] = typeof raw[field.key] === field.type ? (raw[field.key] as StorageValue) : field.default
  }
  const view: StorageTargetView = {
    ...module,
    isEnabled: row.isEnabled,
    mode: row.mode,
    syncInterval: row.syncInterval || String(module.schedule || 'P0D'),
    config,
    secrets,
    issues: []
  }
  view.issues = storageConfigurationIssues(view)
  if (!module.isAvailable)
    view.issues.unshift('This target is unavailable in the current build. Existing configuration is retained; an enabled target can be disabled.')
  return view
}
