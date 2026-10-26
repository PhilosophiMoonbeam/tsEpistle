import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import templateCompilerOptions from '@tresjs/core/template-compiler-options'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { vueSfcLintFixtures } from './vue-sfc-lint-fixtures.ts'

// Biome 2.5.11 treats <template lang="pug"> as raw text, not a Vue AST:
// https://github.com/biomejs/biome/blob/%40biomejs%2Fbiome%402.5.11/crates/biome_html_parser/src/syntax/mod.rs
// Keep Biome as the script linter. This bounded adjunct uses the same Vue/Pug
// compiler and Tres options as Vite for template syntax and directive validity;
// it neither formats templates nor claims a typecheck, import graph or build.
// Usage: bun server/scripts/lint-vue-sfc.ts [--qualify]
// --qualify additionally checks native processed counts and consumer negatives.
const root = path.resolve(import.meta.dir, '../..')
const client = path.join(root, 'client')
const biome = path.join(root, 'node_modules/@biomejs/biome/bin/biome')
const supportedScripts: Record<string, true> = { js: true, jsx: true, ts: true, tsx: true }

type Failure = { file: string; phase: 'admission' | 'template'; message: string }
type Admission = { file: string; scriptBlocks: number; templateLanguage: string | null; templateCompiled: boolean; failures: Failure[] }
type NativeReport = { processed: number; skipped: number; diagnostics: { file: string; category: string; message: string }[]; status: number }

async function collect(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    // Match the authored-source boundary: client/libs is vendored, and test
    // tooling is not production. No production component gets a lint exception.
    if (entry.isDirectory()) {
      if (['client/libs', 'client/test', 'client/tests'].includes(path.relative(root, filename).split(path.sep).join('/'))) continue
      files.push(...await collect(filename))
    } else if (entry.isFile() && entry.name.endsWith('.vue')) {
      files.push(path.relative(root, filename).split(path.sep).join('/'))
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Vue lint inventory cannot silently skip symlink ${filename}`)
    }
  }
  return files.sort()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inspect(file: string, source: string): Admission {
  const result: Admission = { file, scriptBlocks: 0, templateLanguage: null, templateCompiled: false, failures: [] }
  const fail = (phase: Failure['phase'], message: string) => result.failures.push({ file, phase, message })
  try {
    const { descriptor, errors } = parse(source, { filename: file, ignoreEmpty: false })
    for (const error of errors) fail('template', describe(error))
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue
      result.scriptBlocks++
      if (block.src) fail('admission', 'External script blocks need an explicit lint owner')
      if (!Object.hasOwn(supportedScripts, block.lang ?? 'js')) fail('admission', `Unsupported script language: ${block.lang}`)
    }
    const template = descriptor.template
    if (!template) return result
    result.templateLanguage = template.lang ?? 'html'
    if (template.src) {
      fail('admission', 'External template blocks need an explicit lint owner')
      return result
    }
    if (!['html', 'pug'].includes(result.templateLanguage)) {
      fail('template', `Unsupported template language: ${result.templateLanguage}`)
      return result
    }
    if (errors.length > 0) return result
    const scriptLanguage = descriptor.scriptSetup?.lang ?? descriptor.script?.lang
    const compiled = compileTemplate({
      source: template.content,
      filename: path.resolve(root, file),
      id: 'vue-lint',
      scoped: descriptor.styles.some(style => style.scoped),
      slotted: descriptor.slotted,
      ...(template.lang === 'pug' ? { preprocessLang: 'pug' } : {}),
      // Match @vitejs/plugin-vue's Pug default; otherwise native void elements
      // render with XML closing syntax rather than the host's HTML semantics.
      preprocessOptions: { doctype: 'html' },
      ...templateCompilerOptions.template,
      transformAssetUrls: false,
      compilerOptions: {
        ...templateCompilerOptions.template.compilerOptions,
        expressionPlugins: scriptLanguage === 'ts' || scriptLanguage === 'tsx' ? ['typescript'] : []
      }
    })
    for (const error of compiled.errors) fail('template', describe(error))
    for (const tip of compiled.tips) fail('template', tip)
    result.templateCompiled = compiled.errors.length === 0 && compiled.tips.length === 0
  } catch (error) {
    fail('template', describe(error))
  }
  return result
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(summary: Record<string, unknown>, key: string): number {
  const value = summary[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Biome JSON counter: ${key}`)
  return value
}

function nativeLint(files: string[]): NativeReport {
  const child = spawnSync(process.execPath, ['--bun', biome, 'lint', '--reporter=json', '--max-diagnostics=none', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  if (child.error) throw child.error
  if (child.signal || child.status === null) throw new Error(`Biome terminated without a result: ${child.signal}`)
  let report: unknown
  try {
    report = JSON.parse(child.stdout)
  } catch {
    throw new Error(`Biome did not produce its pinned JSON report:\n${child.stdout}\n${child.stderr}`)
  }
  if (!record(report) || !record(report.summary) || !Array.isArray(report.diagnostics)) throw new Error('Unsupported Biome JSON report shape')
  const diagnostics = report.diagnostics.map((diagnostic: unknown) => {
    if (!record(diagnostic) || typeof diagnostic.message !== 'string') throw new Error('Unsupported Biome diagnostic shape')
    return {
      file: record(diagnostic.location) && typeof diagnostic.location.path === 'string' ? diagnostic.location.path : '',
      category: typeof diagnostic.category === 'string' ? diagnostic.category : '',
      message: `${record(diagnostic.location) && typeof diagnostic.location.path === 'string' ? `${diagnostic.location.path}: ` : ''}${diagnostic.message}`
    }
  })
  const omitted = count(report.summary, 'diagnosticsNotPrinted')
  if (omitted !== 0) throw new Error(`Biome omitted ${omitted} diagnostics`)
  return {
    processed: count(report.summary, 'changed') + count(report.summary, 'unchanged'),
    skipped: count(report.summary, 'skipped'),
    diagnostics,
    status: child.status
  }
}

async function qualify(files: string[]): Promise<string[]> {
  const failures: string[] = []
  const native = nativeLint(files)
  console.log(JSON.stringify({ qualification: 'production-native-admission', intended: files.length, ...native }))
  if (native.processed !== files.length || native.skipped !== 0) failures.push(`Native SFC admission: intended ${files.length}, processed ${native.processed}, skipped ${native.skipped}`)
  if (native.status !== 0) failures.push('Production native SFC lint failed; diagnostics are included above')
  const directory = await mkdtemp(path.join(client, 'vue-lint-qualification-'))
  try {
    // Mutate copies of EVERY authored script block. Merely counting .vue paths
    // cannot detect a tool admitting markup while silently skipping its scripts.
    const scriptControls: { original: string; file: string; blocks: number }[] = []
    for (const [index, original] of files.entries()) {
      let source = await readFile(path.join(root, original), 'utf8')
      const { descriptor, errors } = parse(source, { filename: original, ignoreEmpty: false })
      if (errors.length > 0) {
        failures.push(`Cannot qualify script admission for unparseable SFC: ${original}`)
        continue
      }
      const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
      if (blocks.length === 0) continue
      for (const block of blocks.sort((left, right) => right.loc.end.offset - left.loc.end.offset)) {
        source = `${source.slice(0, block.loc.end.offset)}\ndebugger;\n${source.slice(block.loc.end.offset)}`
      }
      const file = path.relative(root, path.join(directory, `script-admission-${index}.vue`)).split(path.sep).join('/')
      await writeFile(path.join(root, file), source)
      scriptControls.push({ original, file, blocks: blocks.length })
    }
    if (scriptControls.length === 0) {
      failures.push('No authored SFC script blocks were available for admission controls')
    } else {
      const checked = nativeLint(scriptControls.map(control => control.file))
      const observed = scriptControls.map(control => ({
        original: control.original,
        intendedScriptBlocks: control.blocks,
        debuggerDiagnostics: checked.diagnostics.filter(diagnostic =>
          diagnostic.category === 'lint/suspicious/noDebugger' && path.resolve(root, diagnostic.file) === path.resolve(root, control.file)
        ).length
      }))
      const passed = checked.status !== 0 && checked.processed === scriptControls.length && checked.skipped === 0 &&
        observed.every(control => control.debuggerDiagnostics >= control.intendedScriptBlocks)
      console.log(JSON.stringify({ qualification: 'every-production-script-negative-control', passed, intendedSfcs: scriptControls.length, observed }))
      if (!passed) failures.push('At least one authored SFC script was ignored or did not emit its injected noDebugger diagnostic')
    }
    for (const fixture of vueSfcLintFixtures) {
      const file = path.relative(root, path.join(directory, `${fixture.name}.vue`)).split(path.sep).join('/')
      await writeFile(path.join(root, file), fixture.source)
      const admission = inspect(file, fixture.source)
      const checked = nativeLint([file])
      const templateFailures = admission.failures.filter(failure => failure.phase === 'template')
      const admissionFailures = admission.failures.filter(failure => failure.phase === 'admission')
      let passed: boolean
      if (fixture.expected === 'valid') {
        passed = admission.failures.length === 0 && admission.templateCompiled && checked.status === 0 && checked.processed === 1 && checked.skipped === 0
      } else if (fixture.expected === 'script') {
        passed = admission.failures.length === 0 && checked.status !== 0 && checked.diagnostics.some(diagnostic => diagnostic.category.startsWith(fixture.category))
      } else {
        const expectedFailures = fixture.expected === 'template' ? templateFailures : admissionFailures
        passed = expectedFailures.length > 0 && (!('message' in fixture) || expectedFailures.some(failure => failure.message.includes(fixture.message)))
      }
      console.log(JSON.stringify({ qualification: fixture.name, passed, admission, native: checked }))
      if (!passed) failures.push(`Consumer negative/positive control failed: ${fixture.name}`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  return failures
}

const args = process.argv.slice(2)
if (args.some(arg => arg !== '--qualify') || args.length > 1) throw new Error('Usage: bun server/scripts/lint-vue-sfc.ts [--qualify]')
const files = await collect(client)
if (files.length === 0) throw new Error('Vue SFC inventory is empty')
const admissions = await Promise.all(files.map(async file => inspect(file, await readFile(path.join(root, file), 'utf8'))))
for (const admission of admissions) console.log(JSON.stringify({ admission }))
const qualificationFailures = args.includes('--qualify') ? await qualify(files) : []
const failures = admissions.flatMap(admission => admission.failures)
console.log(JSON.stringify({
  intendedSfcs: files.length,
  inspectedSfcs: admissions.length,
  scriptBlocks: admissions.reduce((sum, admission) => sum + admission.scriptBlocks, 0),
  templatesCompiled: admissions.filter(admission => admission.templateCompiled).length,
  htmlTemplates: admissions.filter(admission => admission.templateLanguage === 'html').length,
  pugTemplates: admissions.filter(admission => admission.templateLanguage === 'pug').length,
  failures,
  qualificationFailures
}))
if (failures.length > 0 || qualificationFailures.length > 0) process.exitCode = 1
