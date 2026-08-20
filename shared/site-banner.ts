export const SITE_BANNER_TITLE_LIMIT = 160
export const SITE_BANNER_CONTENT_LIMIT = 8000

export type SiteBannerConfig = {
  isEnabled: boolean
  title: string
  content: string
}

type SiteBannerValidation =
  | { ok: true; value: SiteBannerConfig }
  | { ok: false; message: string }

const supportedFields: Record<string, true> = {
  isEnabled: true,
  title: true,
  content: true
}

export const disabledSiteBanner = (): SiteBannerConfig => ({
  isEnabled: false,
  title: '',
  content: ''
})

export const validateSiteBanner = (input: unknown): SiteBannerValidation => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Site banner must be an object.' }
  }
  const banner = input as Record<string, unknown>
  if (Object.keys(banner).some(field => supportedFields[field] !== true)) {
    return { ok: false, message: 'Site banner contains unsupported fields.' }
  }
  if (typeof banner.isEnabled !== 'boolean') {
    return { ok: false, message: 'Site banner enabled flag must be a boolean.' }
  }
  if (typeof banner.title !== 'string') {
    return { ok: false, message: 'Site banner title must be a string.' }
  }
  if (typeof banner.content !== 'string') {
    return { ok: false, message: 'Site banner content must be a string.' }
  }

  const title = banner.title.trim()
  const content = banner.content.trim()
  if (/\r|\n/.test(title)) {
    return { ok: false, message: 'Site banner title must be a single line.' }
  }
  if (title.length > SITE_BANNER_TITLE_LIMIT) {
    return { ok: false, message: `Site banner title cannot exceed ${SITE_BANNER_TITLE_LIMIT} characters.` }
  }
  if (content.length > SITE_BANNER_CONTENT_LIMIT) {
    return { ok: false, message: `Site banner content cannot exceed ${SITE_BANNER_CONTENT_LIMIT} characters.` }
  }
  if (content.includes('\0')) {
    return { ok: false, message: 'Site banner content contains invalid control characters.' }
  }
  if (banner.isEnabled && title.length === 0 && content.length === 0) {
    return { ok: false, message: 'An enabled site banner must have a title or content.' }
  }

  return {
    ok: true,
    value: {
      isEnabled: banner.isEnabled,
      title,
      content
    }
  }
}

export const siteBannerOrDefault = (input: unknown): SiteBannerConfig => {
  const result = validateSiteBanner(input)
  return result.ok ? result.value : disabledSiteBanner()
}
