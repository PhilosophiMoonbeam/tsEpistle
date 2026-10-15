import { normalizeCodeTheme } from '../../shared/theme-policy.ts'

// Only the reviewed, locally bundled presets can be applied, including offline.
export const applyCodeTheme = (input: unknown, root: HTMLElement = document.documentElement): void => {
  root.setAttribute('data-wiki-code-theme', normalizeCodeTheme(input))
}

export const CODE_THEME_PREVIEW_SOURCE = `// A useful trail for the next reader.
const page = { title: "Shared understanding", revision: 42 };
function describePage(current) {
  return current.revision > 0
    ? \`\${current.title} · revision \${current.revision}\`
    : null;
}
console.log(describePage(page));`

// Reuse Prism's bundled JavaScript grammar, without DOM plugins, stylesheet
// imports, language autoloading or remote requests. Cancellation fences the
// publication, not the shared module import, so a later preview can reuse it.
export const renderCodeThemePreview = async (signal: AbortSignal): Promise<string | null> => {
  if (signal.aborted) return null
  // This lazy admin-only preview must not put Prism in the initial admin bundle.
  // Disable its automatic document scan before first load; readers already use
  // explicit highlightAllUnder, and preview publication is owned by the caller.
  if (typeof window !== 'undefined' && !Reflect.get(window, 'Prism')) Reflect.set(window, 'Prism', { manual: true })
  const { default: Prism } = await import('prismjs')
  if (signal.aborted) return null
  return Prism.highlight(CODE_THEME_PREVIEW_SOURCE, Prism.languages.javascript!, 'javascript')
}
