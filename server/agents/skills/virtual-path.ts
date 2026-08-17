const MAX_PATH_BYTES = 512
const MAX_PATH_SEGMENTS = 8
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export class SkillPathError extends Error {
  readonly code = 'INVALID_SKILL_PATH'
}

export const validateSkillVirtualPath = (value: string): string => {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new SkillPathError('Skill resource path is empty or too long')
  }
  if (value.startsWith('/') || value.includes('\\') || value.includes('\0') || value.includes('%')) {
    throw new SkillPathError('Skill resource path must be a decoded relative POSIX path')
  }
  if (/[^\x20-\x7E]/.test(value)) throw new SkillPathError('Skill resource path contains unsupported characters')

  const segments = value.split('/')
  if (segments.length > MAX_PATH_SEGMENTS || segments.some(segment => segment === '' || segment === '.' || segment === '..' || !PATH_SEGMENT.test(segment))) {
    throw new SkillPathError('Skill resource path contains an invalid segment')
  }
  return segments.join('/')
}

export const mapSkillPagePath = (namespace: string, rootPath: string, pagePath: string): string => {
  const normalizedNamespace = validateSkillVirtualPath(namespace)
  const normalizedRoot = validateSkillVirtualPath(rootPath)
  const normalizedPage = validateSkillVirtualPath(pagePath)
  if (normalizedRoot !== `${normalizedNamespace}/${normalizedRoot.split('/').at(-1) ?? ''}`) {
    throw new SkillPathError('Skill root must be a direct child of the configured namespace')
  }
  if (normalizedPage === normalizedRoot) return 'SKILL.md'
  if (!normalizedPage.startsWith(`${normalizedRoot}/`)) throw new SkillPathError('Skill page is outside the selected root')

  const relative = normalizedPage.slice(normalizedRoot.length + 1)
  const basename = relative.split('/').at(-1)
  if (!basename || basename.includes('.')) throw new SkillPathError('Dotted resource names cannot be inferred from Wiki page routes')
  return validateSkillVirtualPath(`${relative}.md`)
}

export const decodeSkillResourcePathOnce = (encodedPath: string): string => {
  let decoded: string
  try {
    decoded = decodeURIComponent(encodedPath)
  } catch {
    throw new SkillPathError('Skill resource path contains invalid percent encoding')
  }
  if (/%[0-9A-Fa-f]{2}/.test(decoded)) throw new SkillPathError('Skill resource path must not be recursively encoded')
  return validateSkillVirtualPath(decoded)
}
