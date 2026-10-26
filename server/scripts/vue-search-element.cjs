// Vue 3.5.44 predates the standard HTML <search> element in its native-tag list.
// Keep the real element, not a fake Vue component, in HTML and Pug type checking.
/** @type {import('@vue/language-core').VueLanguagePlugin} */
module.exports = () => ({
  version: 2.2,
  name: 'tsepistle-native-search',
  resolveTemplateCompilerOptions(options) {
    const prior = options.isCustomElement
    return { ...options, isCustomElement: tag => tag === 'search' || (prior?.(tag) ?? false) }
  }
})
