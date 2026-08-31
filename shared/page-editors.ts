export const PAGE_EDITOR_KEYS = ['markdown', 'visual-markdown', 'ckeditor', 'asciidoc', 'code'] as const

export type PageEditorKey = (typeof PAGE_EDITOR_KEYS)[number]

export type AvailableEditorsValidation = { ok: true; value: PageEditorKey[] } | { ok: false; message: string }

const PAGE_EDITOR_KEY_SET: ReadonlySet<string> = new Set(PAGE_EDITOR_KEYS)

const DEFAULT_PAGE_EDITOR_KEYS = ['markdown', 'visual-markdown'] as const

export const isPageEditorKey = (value: unknown): value is PageEditorKey => typeof value === 'string' && PAGE_EDITOR_KEY_SET.has(value)

export const defaultAvailableEditors = (): PageEditorKey[] => [...DEFAULT_PAGE_EDITOR_KEYS]

export const normalizeAvailableEditors = (value: unknown): PageEditorKey[] => {
  if (!Array.isArray(value)) return defaultAvailableEditors()
  const selected = new Set(value.filter(isPageEditorKey))
  const normalized = PAGE_EDITOR_KEYS.filter(editor => selected.has(editor))
  return normalized.length > 0 ? normalized : defaultAvailableEditors()
}

export const validateAvailableEditors = (value: unknown): AvailableEditorsValidation => {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'Available editors must be an array.' }
  }
  if (value.length < 1) {
    return { ok: false, message: 'At least one editor must remain available.' }
  }
  if (value.some(editor => !isPageEditorKey(editor))) {
    return { ok: false, message: 'Available editors contains an unsupported editor.' }
  }
  if (new Set(value).size !== value.length) {
    return { ok: false, message: 'Available editors must not contain duplicates.' }
  }
  const selected = new Set(value)
  return {
    ok: true,
    value: PAGE_EDITOR_KEYS.filter(editor => selected.has(editor))
  }
}
