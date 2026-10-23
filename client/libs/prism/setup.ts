import Prism from 'prismjs'
import { languages as components } from 'prismjs/components.json'
import 'prismjs/plugins/line-highlight/prism-line-highlight.css'
import 'prismjs/plugins/line-numbers/prism-line-numbers.css'

Reflect.set(globalThis, 'Prism', Prism)
// Prism plugins are legacy global scripts; static imports run before the core global is initialized under Bun 1.4.
await import('prismjs/plugins/autoloader/prism-autoloader')
await import('prismjs/plugins/line-numbers/prism-line-numbers')
await import('prismjs/plugins/line-highlight/prism-line-highlight')
await import('prismjs/plugins/normalize-whitespace/prism-normalize-whitespace')
await import('prismjs/plugins/toolbar/prism-toolbar')

Prism.plugins.autoloader.languages_path = '/_assets/js/prism/'

const supportedLanguages = new Set<string>()
for (const [language, component] of Object.entries(components)) {
  if (language === 'meta') continue
  supportedLanguages.add(language)
  if (typeof component === 'object' && 'alias' in component) {
    const aliases = typeof component.alias === 'string' ? [component.alias] : component.alias
    for (const alias of aliases) supportedLanguages.add(alias)
  }
}
Prism.hooks.add('before-sanity-check', env => {
  // Core still escapes and renders unknown fences; "none" tells the autoloader not to request a nonexistent component.
  if (!env.grammar && !supportedLanguages.has(env.language)) env.language = 'none'
})

Prism.plugins.NormalizeWhitespace.setDefaults({
  'remove-trailing': true,
  'remove-indent': true,
  'left-trim': true,
  'right-trim': true,
  'remove-initial-line-feed': true,
  'tabs-to-spaces': 2
})

export default Prism
