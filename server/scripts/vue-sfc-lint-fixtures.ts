// Consumer inputs, not source-pattern assertions. Keep invalid SFCs in strings so
// ordinary repository lint/type checks do not mistake them for application code.
const script = '<script setup lang="ts">const visible = true</script>'

export const vueSfcLintFixtures = [
  {
    name: 'valid-html',
    source: `<template><p v-if="visible">Visible</p><p v-else>Hidden</p></template>${script}`,
    expected: 'valid'
  },
  {
    name: 'valid-pug',
    source: `<template lang="pug">\np(v-if="visible") Visible\np(v-else) Hidden\n</template>${script}`,
    expected: 'valid'
  },
  {
    name: 'missing-if-html',
    source: `<template><p v-if>Missing content condition</p></template>${script}`,
    expected: 'template',
    message: 'v-if/v-else-if is missing expression'
  },
  {
    name: 'missing-if-pug',
    source: `<template lang="pug">\np(v-if) Missing content condition\n</template>${script}`,
    expected: 'template',
    message: 'v-if/v-else-if is missing expression'
  },
  {
    name: 'orphan-else-html',
    source: `<template><p v-else>Unreachable alternative</p></template>${script}`,
    expected: 'template',
    message: 'v-else/v-else-if has no adjacent v-if or v-else-if'
  },
  {
    name: 'orphan-else-pug',
    source: `<template lang="pug">\np(v-else) Unreachable alternative\n</template>${script}`,
    expected: 'template',
    message: 'v-else/v-else-if has no adjacent v-if or v-else-if'
  },
  {
    name: 'debugger-html',
    source: '<template><p>Content</p></template><script setup lang="ts">debugger</script>',
    expected: 'script',
    category: 'lint/suspicious/noDebugger'
  },
  {
    name: 'debugger-pug',
    source: '<template lang="pug">\np Content\n</template><script setup lang="ts">debugger</script>',
    expected: 'script',
    category: 'lint/suspicious/noDebugger'
  },
  {
    name: 'unparseable-script',
    source: '<template><p>Content</p></template><script setup lang="ts">const =</script>',
    expected: 'script',
    category: 'parse'
  },
  {
    name: 'unparseable-html',
    source: `<template><section><p>Unclosed</section></template>${script}`,
    expected: 'template',
    message: 'Element is missing end tag'
  },
  {
    name: 'unparseable-pug',
    source: `<template lang="pug">\np(\n</template>${script}`,
    expected: 'template'
  },
  {
    name: 'unsupported-template-language',
    source: `<template lang="unknown-vue-lint-language">content</template>${script}`,
    expected: 'template',
    message: 'Unsupported template language'
  },
  {
    name: 'unsupported-script-language',
    source: '<template><p>Content</p></template><script lang="coffee">value = 1</script>',
    expected: 'admission',
    message: 'Unsupported script language'
  },
  {
    name: 'external-script',
    source: '<template><p>Content</p></template><script src="./external.ts"></script>',
    expected: 'admission',
    message: 'External script blocks need an explicit lint owner'
  }
] as const
