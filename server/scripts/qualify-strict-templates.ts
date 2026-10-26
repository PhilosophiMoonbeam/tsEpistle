import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { createParsedCommandLine } from '@vue/language-core'

/**
 * Bounded language-core 3.3.9 contract qualification, not the production gate.
 * Run: bun server/scripts/qualify-strict-templates.ts [--case <name>]
 *
 * 3.3.9 strictTemplates enables unknown props/events/directives/components and
 * strictVModel, but does NOT enable native fallthrough inference. That requires
 * fallthroughAttributes. htmlAttributes only controls spelling/camelization; it
 * does not supply native attribute types. Concrete ARIA names preserve Vue's
 * actual dashed AriaAttributes keys without wildcard spelling exemptions.
 * data-* is open-ended, but its bound expressions must still be checked.
 *
 * Slot controls use the ordinary non-generic defineSlots SFC boundary and
 * require typed payload diagnostics. Vue's public $slots retains an open name
 * index, so unknown slot-name rejection is not a guarantee of this profile.
 * Same-line Pug slot interpolation intentionally guards the adapter boundary:
 * the old 2.2.12 adapter's full compiler transform silently skipped this check.
 *
 * Every invocation creates a temporary project, checks admission via --listFiles
 * AND source-mapped negative diagnostics, and removes the project in finally.
 * The profile deliberately does not import client/env.d.ts: doing so would pull
 * every registered production SFC into this bounded pre-migration strict gate.
 * Global registrations instead have their exact type-only ownership checked
 * against the runtime registry below; the normal client gate checks their types.
 */
const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const corePackage: { version: string } = require('@vue/language-core/package.json')
assert.equal(corePackage.version, '3.3.9', 'Requalify semantics when language-core changes')
const pugPackage: { version: string } = require('@vue/language-plugin-pug/package.json')
assert.equal(pugPackage.version, '3.3.9', 'Requalify Pug source mappings when its adapter changes')

// Registration names and owning modules are an architectural contract: no fake
// globals, erased component types, or eager imports to satisfy template checking.
function checkGlobalOwners(): void {
  const runtime = ts.createSourceFile('client/client-app.ts', fs.readFileSync(path.join(root, 'client/client-app.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const environment = ts.createSourceFile('client/env.d.ts', fs.readFileSync(path.join(root, 'client/env.d.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const owners = new Map<string, string>()
  const visitRuntime = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'asyncComponent' && ts.isStringLiteral(node.arguments[0]!)) {
      const [name, loader] = node.arguments
      assert(name && ts.isStringLiteral(name))
      assert(loader && ts.isArrowFunction(loader) && ts.isCallExpression(loader.body))
      assert.equal(loader.body.expression.kind, ts.SyntaxKind.ImportKeyword)
      const module = loader.body.arguments[0]
      assert(module && ts.isStringLiteral(module))
      assert(!owners.has(name.text), `Duplicate runtime registration ${name.text}`)
      owners.set(name.text, module.text)
    }
    ts.forEachChild(node, visitRuntime)
  }
  visitRuntime(runtime)
  assert(owners.size > 0, 'Runtime registration inventory must not be empty')
  const imports = new Map<string, string>()
  for (const statement of environment.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly && statement.importClause.name && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.set(statement.importClause.name.text, statement.moduleSpecifier.text)
    }
  }
  const declared = new Map<string, string>()
  const visitEnvironment = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'GlobalComponents') {
      for (const member of node.members) {
        assert(ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name), 'Globals must have explicit component names')
        assert(member.type && ts.isTypeQueryNode(member.type) && ts.isIdentifier(member.type.exprName), 'Globals must retain the actual imported component type')
        const module = imports.get(member.type.exprName.text)
        assert(module, `${member.name.text} must use a type-only owner import`)
        assert(!declared.has(member.name.text), `Duplicate global ${member.name.text}`)
        declared.set(member.name.text, module)
      }
    }
    ts.forEachChild(node, visitEnvironment)
  }
  visitEnvironment(environment)
  assert.deepEqual([...declared].sort(), [...owners].sort(), 'GlobalComponents must exactly match client-app runtime owners')
}
checkGlobalOwners()

const control = `<script setup lang="ts">
defineOptions({ inheritAttrs: false })
defineProps<{ label: string; count?: number }>()
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ commit: [count: number] }>()
defineSlots<{ help(props: { count: number }): unknown }>()
</script>
<template>
  <div>
    <label>{{ label }}</label>
    <input v-bind="$attrs" v-model="model" />
    <button type="button" @click="emit('commit', count ?? 0)">Commit</button>
    <slot name="help" :count="count ?? 0" />
  </div>
</template>
`
const automaticControl = `<script setup lang="ts">
defineProps<{ label: string }>()
</script>
<template><button type="button">{{ label }}</button></template>
`

type NegativeCase = { codes: number[]; message: RegExp; html: string; pug: string }
const negatives: Record<string, NegativeCase> = {
  'typo-prop': { codes: [2353, 2561], message: /lable/, html: ':lable="42"', pug: ':lable="42"' },
  'unknown-component': { codes: [2339, 2551], message: /MissingQualificationComponent/, html: '<MissingQualificationComponent />', pug: 'MissingQualificationComponent' },
  'invalid-model': { codes: [2322], message: /number.*string|string.*number/, html: 'v-model="numericModel"', pug: 'v-model="numericModel"' },
  'invalid-event': { codes: [2322, 2345], message: /string|number/, html: '@commit="acceptText"', pug: '@commit="acceptText"' },
  'unknown-event': { codes: [2353, 2561, 2339, 2551], message: /commti|Commti/, html: '@commti="acceptCount"', pug: '@commti="acceptCount"' },
  'invalid-slot-payload': { codes: [2339, 2551], message: /toUpperCase/, html: '{{ count.toUpperCase() }}', pug: '{{ count.toUpperCase() }}' },
  'invalid-native': { codes: [2322], message: /wrong|Booleanish|boolean/, html: ':disabled="\'wrong\'"', pug: ':disabled="\'wrong\'"' },
  'invalid-aria': { codes: [2322], message: /wrong|Booleanish|boolean/, html: ':aria-hidden="\'wrong\'"', pug: ':aria-hidden="\'wrong\'"' },
  'invalid-data-expression': { codes: [2339, 2551], message: /missingData/, html: ':data-qualification="missingData"', pug: ':data-qualification="missingData"' }
}
const selected = process.argv.slice(2)
assert(selected.length === 0 || (selected.length === 2 && selected[0] === '--case'), 'Usage: qualify-strict-templates.ts [--case valid|admission|<negative name>]')
const caseName = selected[1]
assert(!caseName || caseName === 'valid' || caseName === 'admission' || Object.hasOwn(negatives, caseName), `Unknown case ${caseName}; choose valid, admission, ${Object.keys(negatives).join(', ')}`)

function consumer(language: 'html' | 'pug', negative?: string): { source: string; diagnosticLine?: number } {
  const attrs = ['label="Title"', ':count="2"', 'v-model="model"', '@commit="acceptCount"', 'id="title"', 'name="title"', 'autocomplete="off"', ':disabled="false"', ':aria-hidden="false"', ':data-qualification="model"', 'aria-label="Title"', 'aria-describedby="help"']
  const slot = '#help="{ count }"'
  let content = '{{ count.toFixed(0) }}'
  let extra = ''
  const mutation = negative ? negatives[negative]![language] : ''
  if (negative === 'typo-prop') attrs.push(mutation)
  if (negative === 'invalid-model') attrs[2] = mutation
  if (negative === 'invalid-event' || negative === 'unknown-event') attrs[3] = mutation
  if (negative === 'invalid-native') attrs[7] = mutation
  if (negative === 'invalid-aria') attrs[8] = mutation
  if (negative === 'invalid-data-expression') attrs[9] = mutation
  if (negative === 'invalid-slot-payload') content = mutation
  if (negative === 'unknown-component') extra = mutation
  const script = `<script setup lang="ts">
import { ref } from 'vue'
import Control from './Control.vue'
import AutomaticControl from './AutomaticControl.vue'
const model = ref('Title')
const numericModel = ref(1)
function acceptCount(count: number): void { console.log(count) }
function acceptText(text: string): void { console.log(text) }
function acceptMouse(event: MouseEvent): void { console.log(event.clientX) }
</script>`
  const template = language === 'html'
    ? `<template>\n  <section>\n    <Control ${attrs.join(' ')}>\n      <template ${slot}>${content}</template>\n    </Control>\n    <AutomaticControl label="Native root" id="automatic" :disabled="false" :aria-hidden="false" data-kind="root" />\n    <input id="native" name="native" :disabled="false" :aria-hidden="false" :data-qualification="model" @click="acceptMouse" />\n    ${extra}\n  </section>\n</template>`
    : `<template lang="pug">\nsection\n  Control(${attrs.join(' ')})\n    template(${slot}) ${content}\n  AutomaticControl(label="Native root" id="automatic" :disabled="false" :aria-hidden="false" data-kind="root")\n  input(id="native" name="native" :disabled="false" :aria-hidden="false" :data-qualification="model" @click="acceptMouse")\n  ${extra}\n</template>`
  const source = `${script}\n${template}\n`
  return negative
    ? { source, diagnosticLine: source.split('\n').findIndex(line => line.includes(mutation)) + 1 }
    : { source }
}

const directory = fs.mkdtempSync(path.join(root, '.strict-qualification-'))
const project = path.join(directory, 'tsconfig.json')
const consumers = [
  { file: 'Html.vue', language: 'html' as const },
  { file: 'Pug.vue', language: 'pug' as const },
  // This extension exists only in the alternate profile, exposing a wrapper that
  // accidentally derives its extension inventory from tsconfig.client.json.
  { file: 'Extension.qualification', language: 'pug' as const }
]
const allFiles = ['Control.vue', 'AutomaticControl.vue', ...consumers.map(item => item.file)]
try {
  fs.writeFileSync(path.join(directory, 'Control.vue'), control)
  fs.writeFileSync(path.join(directory, 'AutomaticControl.vue'), automaticControl)
  fs.writeFileSync(project, JSON.stringify({ extends: path.join(root, 'tsconfig.strict-qualification.json'), files: allFiles, include: [], references: [] }, null, 2))
  const parsed = createParsedCommandLine(ts, ts.sys, project)
  assert.deepEqual(parsed.errors, [], 'Qualification project must parse')
  for (const option of ['strictVModel', 'checkUnknownProps', 'checkUnknownEvents', 'checkUnknownDirectives', 'checkUnknownComponents', 'fallthroughAttributes'] as const) {
    assert.equal(parsed.vueOptions[option], true, `${option} must remain enabled`)
  }
  assert.deepEqual(parsed.vueOptions.htmlAttributes, ['aria-hidden', 'aria-label', 'aria-describedby'])
  assert.equal(parsed.vueOptions.skipTemplateCodegen, false)
  assert.deepEqual(parsed.vueOptions.dataAttributes, ['data-*'])
  assert(parsed.vueOptions.plugins.length > 0, 'Pug plugin must resolve from the selected project')
  assert(parsed.vueOptions.extensions.includes('.qualification'))

  const invocations = [
    ['-p', path.relative(root, project)],
    ['--project', directory]
  ]
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [path.join(root, 'server/scripts/run-vue-tsc.ts'), ...args, '--noEmit', '--pretty', 'false', '--listFiles'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert.ifError(result.error)
    assert.equal(result.signal, null, 'Checker must exit normally')
    const output = `${result.stdout}\n${result.stderr}`
    for (const file of allFiles) assert(output.split(/\r?\n/).includes(path.join(directory, file)), `${file} was not admitted by ${args.join(' ')}\n${output}`)
    return { status: result.status, output }
  }
  const writeConsumers = (negative?: string) => new Map(consumers.map(item => {
    const fixture = consumer(item.language, negative)
    fs.writeFileSync(path.join(directory, item.file), fixture.source)
    return [item.file, fixture]
  }))

  writeConsumers()
  for (const invocation of invocations) {
    const result = run(invocation)
    assert.equal(result.status, 0, `Valid HTML/Pug/native/model/event/slot consumers must pass\n${result.output}`)
  }
  console.log('PASS valid contracts and alternate-project source admission (-p file / --project directory)')

  if (!caseName || (caseName !== 'valid' && caseName !== 'admission')) {
    for (const [name, expected] of Object.entries(negatives)) {
      if (caseName && name !== caseName) continue
      const fixtures = writeConsumers(name)
      const result = run(invocations[0]!)
      assert.equal(result.status, 2, `${name} must produce type diagnostics, not a skipped source or CLI failure\n${result.output}`)
      const diagnostics = [...result.output.matchAll(/^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$/gm)]
      assert(diagnostics.length > 0, `Expected mapped diagnostics for ${name}\n${result.output}`)
      for (const item of consumers) {
        const diagnosticLine = fixtures.get(item.file)!.diagnosticLine
        assert(diagnostics.some(match => path.resolve(root, match[1]!) === path.join(directory, item.file) && Number(match[2]) === diagnosticLine && expected.codes.includes(Number(match[4])) && expected.message.test(match[5]!)), `${name} must fail on its intended ${item.file}:${diagnosticLine} expression\n${result.output}`)
      }
      for (const diagnostic of diagnostics) {
        const file = consumers.find(item => path.join(directory, item.file) === path.resolve(root, diagnostic[1]!))
        assert(file && Number(diagnostic[2]) === fixtures.get(file.file)!.diagnosticLine, `Unrelated diagnostic must not satisfy ${name}\n${result.output}`)
      }
      console.log(`PASS rejected ${name} independently in HTML, Pug, and alternate extension`)
    }
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}
