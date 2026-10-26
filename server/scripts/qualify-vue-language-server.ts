import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ConnectionError, createMessageConnection, NullLogger, ResponseError, StreamMessageReader, StreamMessageWriter, type MessageConnection } from 'vscode-jsonrpc/node'
import {
  CodeLens, Diagnostic, DocumentLink, DocumentSymbol, Hover, Location, LocationLink, MarkupContent, Position,
  SymbolKind, TextDocumentEdit, TextEdit, WorkspaceEdit,
  type InitializeParams, type PublishDiagnosticsParams, type Range, type SymbolInformation
} from 'vscode-languageserver-protocol'
import { cleanEnvironment } from './local-ci-resources.ts'

// Consumer qualification: no bridge internals, fake declarations, source scans,
// or test-only server switches. Each session has the existing 30-second bound.
// Run: bun --no-env-file server/scripts/qualify-vue-language-server.ts [--editor-launcher]
const root = fileURLToPath(new URL('../../', import.meta.url))
const admissionMilliseconds = 30_000
const active = new Set<Client>()
let stage = 'fixture setup'

interface LaunchCommand { command: string; args: string[] }
let launcher: LaunchCommand = {
  command: process.execPath,
  args: ['--no-env-file', path.join(root, 'server/scripts/vue-language-server.ts'), '--stdio']
}

class QualificationFailure extends Error {}

function safeFailureReason(error: unknown): string {
  if (error instanceof QualificationFailure) return error.message
  if (error instanceof assert.AssertionError) return error.message.split('\n', 1)[0] ?? 'fixture assertion failed'
  if (error instanceof ResponseError) return `JSON-RPC request rejected (code ${error.code})`
  if (error instanceof ConnectionError) return `JSON-RPC connection failed (code ${error.code})`
  return 'unclassified operation failure'
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function editorLauncher(): LaunchCommand {
  const configuration: unknown = JSON.parse(fs.readFileSync(path.join(root, '.omp/lsp.json'), 'utf8'))
  assert(object(configuration) && object(configuration.servers), 'Editor configuration must declare language servers')
  const server = configuration.servers['vue-language-server']
  assert(object(server) && typeof server.command === 'string' && server.command.length > 0
    && Array.isArray(server.args) && server.args.every((argument: unknown) => typeof argument === 'string'),
  'Editor Vue server must declare a real command and string arguments')
  return { command: server.command, args: server.args }
}

function symbolInformation(value: unknown): value is SymbolInformation {
  return object(value) && typeof value.name === 'string' && typeof value.kind === 'number'
    && Number.isInteger(value.kind) && value.kind >= SymbolKind.File && value.kind <= SymbolKind.TypeParameter
    && Location.is(value.location)
    && (value.containerName === undefined || typeof value.containerName === 'string')
    && (value.deprecated === undefined || typeof value.deprecated === 'boolean')
    && (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every(tag => tag === 1)))
}

function transportErrorCode(error: unknown): string {
  if (object(error)) {
    switch (error.code) {
      case 'ERR_STREAM_WRITE_AFTER_END':
      case 'ERR_STREAM_DESTROYED':
      case 'EPIPE':
      case 'ECONNRESET':
        return error.code
    }
  }
  return 'unclassified'
}

function position(source: string, needle: string, offset = 0): Position {
  const index = source.indexOf(needle)
  assert(index >= 0, 'Qualification position must exist')
  const prefix = source.slice(0, index + offset)
  const lines = prefix.split('\n')
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length }
}

function contains(range: Range, point: Position): boolean {
  return (point.line > range.start.line || (point.line === range.start.line && point.character >= range.start.character))
    && (point.line < range.end.line || (point.line === range.end.line && point.character <= range.end.character))
}

function sourceRange(source: string, range: Range): string {
  const lines = source.split('\n')
  const offset = (point: Position): number => {
    assert(point.line >= 0 && point.line < lines.length, 'Mapped edit must stay inside fixture')
    assert(point.character >= 0 && point.character <= lines[point.line]!.length, 'Mapped edit must stay inside fixture line')
    return lines.slice(0, point.line).reduce((sum, line) => sum + line.length + 1, 0) + point.character
  }
  return source.slice(offset(range.start), offset(range.end))
}

interface ProcessIdentity { pid: number; start: string; kind: 'vue' | 'typescript' | 'tsserver' | 'other' }

function processIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    const kind = command.includes('@vue/language-server/') ? 'vue'
      : command.includes('typescript-language-server/') ? 'typescript'
        : /typescript\/lib\/(?:_)?tsserver\.js/.test(command) ? 'tsserver' : 'other'
    return { pid, start: fields[19]!, kind }
  } catch (error: unknown) {
    if (object(error) && (error.code === 'ENOENT' || error.code === 'ESRCH')) return undefined
    throw error
  }
}

function sameProcess(identity: ProcessIdentity): boolean {
  return processIdentity(identity.pid)?.start === identity.start
}

class Client {
  readonly child: ChildProcessWithoutNullStreams
  readonly connection: MessageConnection
  readonly deadline = Date.now() + admissionMilliseconds
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  readonly directory: string
  initializationResponseReceived = false
  private readonly observed = new Map<number, ProcessIdentity>()
  private readonly diagnostics = new Map<string, { sequence: number; params: PublishDiagnosticsParams }>()
  private readonly listeners = new Set<() => void>()
  private sequence = 0
  private fault: Error | undefined
  private rejectFailure!: (error: Error) => void
  private readonly failure = new Promise<never>((_resolve, reject) => { this.rejectFailure = reject })
  private readonly observer: NodeJS.Timeout
  private stopping = false
  private clientEOF = false

  constructor(directory: string) {
    this.directory = directory
    this.child = spawn(launcher.command, launcher.args, {
      cwd: root, env: cleanEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    active.add(this)
    this.failure.catch(() => undefined)
    this.child.stderr.resume() // Never disclose upstream source, paths, or environment.
    this.exited = new Promise(resolve => {
      this.child.once('exit', (code, signal) => {
        resolve({ code, signal })
        if (!this.stopping) this.fail('Bridge exited before client shutdown')
      })
      this.child.once('error', () => this.fail('Bridge could not be launched'))
    })
    const reader = new StreamMessageReader(this.child.stdout)
    const writer = new StreamMessageWriter(this.child.stdin)
    // vscode-jsonrpc 9 forwards these two events into connection.onError, losing
    // their origin. Retain that origin so malformed stdout can never be treated
    // as a normal consequence of deliberately ending the client's write side.
    reader.onError(() => this.fail('Bridge stdout JSON-RPC reader failed'))
    writer.onError(([error]) => {
      // Node defines this exact code as write() after end(). A server request
      // already in the RPC queue can race client EOF and attempt its reply.
      // No other writer error, or any reader error, is an expected EOF outcome.
      if (this.clientEOF && this.child.stdin.writableEnded && object(error) && error.code === 'ERR_STREAM_WRITE_AFTER_END') return
      this.fail(`Bridge client-input transport failed (${transportErrorCode(error)})`)
    })
    this.connection = createMessageConnection(reader, writer, NullLogger)
    this.connection.onClose(() => {
      if (!this.stopping) this.fail('Bridge closed its transport before shutdown')
    })
    this.connection.onNotification((method: string, value: unknown) => {
      if (method.startsWith('tsserver/')) this.fail('Internal tsserver notification leaked to the client')
      if (method !== 'textDocument/publishDiagnostics') return
      if (!object(value) || typeof value.uri !== 'string' || !Array.isArray(value.diagnostics)
        || !value.diagnostics.every(Diagnostic.is) || (value.version !== undefined && !Number.isInteger(value.version))) {
        this.fail('Bridge published malformed diagnostics')
        return
      }
      const params: PublishDiagnosticsParams = { uri: value.uri, diagnostics: value.diagnostics }
      if (typeof value.version === 'number') params.version = value.version
      this.diagnostics.set(value.uri, { sequence: ++this.sequence, params })
      for (const listener of this.listeners) listener()
    })
    this.connection.onRequest((method: string, value: unknown) => {
      if (method.startsWith('tsserver/')) {
        this.fail('Internal tsserver request leaked to the client')
        throw new Error('Internal bridge protocol must not be client-facing')
      }
      if (method === 'workspace/configuration' && object(value) && Array.isArray(value.items)) return value.items.map(() => null)
      if (method === 'workspace/workspaceFolders') return [{ uri: pathToFileURL(directory).href, name: 'qualification' }]
      if (method === 'window/workDoneProgress/create' || method === 'client/registerCapability' || method === 'client/unregisterCapability') return null
      this.fail('Bridge requested an unsupported client operation')
      throw new Error('Unsupported qualification client operation')
    })
    this.connection.listen()
    this.observer = setInterval(() => {
      try { this.observe() } catch { this.fail('Could not observe owned process lifecycle') }
    }, 25)
  }

  private fail(message: string): void {
    if (this.fault) return
    this.fault = new QualificationFailure(message)
    this.rejectFailure(this.fault)
  }

  async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([operation, this.failure, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new QualificationFailure('Vue bridge exceeded the 30-second qualification bound')), Math.max(0, this.deadline - Date.now()))
      })])
    } finally {
      clearTimeout(timer)
    }
  }

  async request(method: string, params?: object): Promise<unknown> {
    return this.bounded(params ? this.connection.sendRequest<unknown>(method, params) : this.connection.sendRequest<unknown>(method))
  }

  async notify(method: string, params?: object): Promise<void> {
    await this.bounded(params ? this.connection.sendNotification(method, params) : this.connection.sendNotification(method))
  }

  async initialize(): Promise<void> {
    const uri = pathToFileURL(this.directory).href
    const params: InitializeParams = {
      processId: process.pid, rootUri: uri, workspaceFolders: [{ uri, name: 'qualification' }],
      clientInfo: { name: 'tsEpistle Vue bridge qualification' },
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: true }, publishDiagnostics: { versionSupport: true, relatedInformation: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          definition: { linkSupport: true }, hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { snippetSupport: true } }, rename: { prepareSupport: false },
          codeLens: {}, documentLink: {}
        }
      }
    }
    const result = await this.request('initialize', params)
    this.initializationResponseReceived = true
    assert(object(result) && object(result.capabilities), 'Bridge must return actual initialization capabilities')
    for (const key of ['documentSymbolProvider', 'definitionProvider', 'referencesProvider', 'hoverProvider', 'renameProvider', 'completionProvider', 'documentFormattingProvider', 'codeLensProvider', 'documentLinkProvider']) {
      assert(result.capabilities[key], 'Required Vue editor capability must be advertised')
    }
    await this.notify('initialized', {})
    const referencesCodeLens = { enabled: true, showOnAllFunctions: true }
    await this.notify('workspace/didChangeConfiguration', {
      settings: { typescript: { referencesCodeLens }, javascript: { referencesCodeLens } }
    })
  }

  async open(file: string, text: string, languageId: 'vue' | 'typescript' = 'vue'): Promise<string> {
    const uri = pathToFileURL(path.join(this.directory, file)).href
    await this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } })
    return uri
  }

  checkpoint(): number { return this.sequence }

  async waitDiagnostics(uri: string, after: number, version: number, accept: (diagnostics: Diagnostic[]) => boolean): Promise<void> {
    let listener: (() => void) | undefined
    try {
      await this.bounded(new Promise<void>(resolve => {
        listener = () => {
          const report = this.diagnostics.get(uri)
          if (report && report.sequence > after && (report.params.version === undefined || report.params.version === version) && accept(report.params.diagnostics)) resolve()
        }
        this.listeners.add(listener)
        listener()
      }))
    } finally {
      if (listener) this.listeners.delete(listener)
    }
  }

  observe(): void {
    const visit = (pid: number): void => {
      const identity = processIdentity(pid)
      if (!identity) return
      this.observed.set(pid, identity)
      let children: string
      try { children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8') }
      catch (error: unknown) {
        if (object(error) && (error.code === 'ENOENT' || error.code === 'ESRCH')) return
        throw error
      }
      for (const child of children.trim().split(/\s+/).filter(Boolean)) visit(Number(child))
    }
    if (this.child.pid) visit(this.child.pid)
  }

  requireRealChildren(): void {
    this.observe()
    for (const kind of ['vue', 'typescript', 'tsserver']) {
      assert([...this.observed.values()].some(identity => identity.kind === kind && sameProcess(identity)), 'Qualification must observe both actual upstream servers and their real tsserver child')
    }
  }

  async waitForInitializationChild(initializationFinished: () => boolean): Promise<void> {
    await this.bounded((async () => {
      while (true) {
        this.observe()
        assert(!initializationFinished(), 'Interrupted initialization must not already have completed admission')
        if ([...this.observed.values()].some(identity => (identity.kind === 'vue' || identity.kind === 'typescript') && sameProcess(identity))) return
        await delay(1)
      }
    })())
  }

  async retire(mode: 'shutdown' | 'eof' | 'initialization-eof'): Promise<void> {
    stage = `${mode} retirement: real child ownership`
    if (mode === 'initialization-eof') {
      this.observe()
      assert([...this.observed.values()].some(identity => (identity.kind === 'vue' || identity.kind === 'typescript') && sameProcess(identity)),
        'Interrupted initialization must own an actual upstream server child')
    } else this.requireRealChildren()
    if (mode === 'shutdown') {
      stage = 'shutdown retirement: shutdown response'
      const result = await this.request('shutdown')
      assert.equal(result, null, 'LSP shutdown must acknowledge completion')
      this.stopping = true
      stage = 'shutdown retirement: exit notification'
      await this.notify('exit')
    } else {
      this.stopping = true
      stage = `${mode} retirement: closing client input`
      this.clientEOF = true
      this.child.stdin.end()
    }
    stage = `${mode} retirement: bridge exit`
    const exit = await this.bounded(this.exited)
    if (exit.signal !== null) throw new QualificationFailure(`Bridge was terminated by signal ${exit.signal}`)
    if (exit.code !== 0) throw new QualificationFailure(`Bridge exited unsuccessfully (code ${exit.code})`)
    stage = `${mode} retirement: observed descendants absent`
    await this.bounded((async () => {
      while ([...this.observed.values()].some(sameProcess)) await delay(25)
    })())
    assert(!this.fault, 'Bridge must not leak its internal protocol during teardown')
  }

  dispose(): void {
    this.stopping = true
    try { this.observe() } catch { /* Preserve the qualification failure during cleanup. */ }
    clearInterval(this.observer)
    this.connection.dispose()
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    // Failure cleanup is deliberately after lifecycle assertions; killing a leak
    // cannot turn retirement into a pass. Only signal identities still owned.
    for (const identity of this.observed.values()) {
      if (!sameProcess(identity)) continue
      try { process.kill(-identity.pid, 'SIGKILL') } catch { /* Not every descendant leads a group. */ }
      try { process.kill(identity.pid, 'SIGKILL') } catch { /* Already exited. */ }
    }
    if (this.child.pid && !this.observed.has(this.child.pid)) this.child.kill('SIGKILL')
    active.delete(this)
  }
}

const contracts = `export interface PublicEntry { label: string; count: number }
export function consumeCount(value: number): string {
  return value.toFixed(0)
}
`
const component = `<script setup lang="ts">
defineProps<{ count: number }>()
defineSlots<{ default(props: { count: number }): unknown }>()
</script>
<template><slot :count="count" /></template>
`

type TemplateKind = 'html' | 'pug'
function consumer(kind: TemplateKind, valid: boolean): string {
  const count = valid ? '1' : "'wrong'"
  const prop = valid ? 'entry.count' : "'wrong'"
  const interpolation = valid ? 'count.toFixed(0)' : 'count.toUpperCase()'
  const script = `<script setup lang="ts">
import CounterPanel from './CounterPanel.vue'
import { consumeCount, type PublicEntry } from './contracts'
const entry: PublicEntry = { label: 'Ready', count: ${count} }
function localFormat(value: number): string {
  return consumeCount(value)
}
const formatted = localFormat(1)
</script>`
  const template = kind === 'html'
    ? `<template>
  <section>
    <img src="qualification-missing.svg" alt="Qualification asset" />
    <CounterPanel :count="${prop}">
      <template #default="{ count }"><span>{{ ${interpolation} }}</span></template>
    </CounterPanel>
    <p>{{ localFormat(entry.count) }} {{ formatted }}</p>
  </section>
</template>`
    : `<template lang="pug">
section
  img(src="qualification-missing.svg" alt="Qualification asset")
  CounterPanel(:count="${prop}")
    template(#default="{ count }") {{ ${interpolation} }}
  p {{ localFormat(entry.count) }} {{ formatted }}
</template>`
  return `${script}\n${template}\n<style scoped>\nsection{color:red}\n</style>\n`
}

function functionSymbol(value: unknown, source: string, uri: string): boolean {
  if (!Array.isArray(value)) return false
  return value.some((symbol: unknown): boolean => {
    if (DocumentSymbol.is(symbol)) {
      return (symbol.name === 'localFormat' && symbol.kind === SymbolKind.Function
        && contains(symbol.selectionRange, position(source, 'function localFormat', 'function '.length)))
        || functionSymbol(symbol.children, source, uri)
    }
    return symbolInformation(symbol) && symbol.name === 'localFormat' && symbol.kind === SymbolKind.Function
      && symbol.location.uri === uri && contains(symbol.location.range, position(source, 'function localFormat', 'function '.length))
  })
}

function expectedErrors(source: string, diagnostics: Diagnostic[]): boolean {
  const matches = [
    { point: position(source, "count: 'wrong'", 1), code: 2322, message: /string.*number|number.*string/s },
    { point: position(source, ':count='), code: 2322, message: /string.*number|number.*string/s },
    { point: position(source, 'count.toUpperCase()', 'count.'.length), code: 2339, message: /toUpperCase.*number|number.*toUpperCase/s }
  ]
  // Prop errors can select only the attribute name, with or without its colon.
  matches[1]!.point.character += 1
  return matches.every(expected => diagnostics.some(diagnostic => diagnostic.severity === 1
    && Number(diagnostic.code) === expected.code && contains(diagnostic.range, expected.point)
    && expected.message.test(typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value)))
}

function completionLabels(value: unknown): string[] {
  const items: unknown = object(value) ? value.items : value
  assert(Array.isArray(items), 'Completion response must contain actual items')
  return items.map((item: unknown) => {
    assert(object(item) && typeof item.label === 'string', 'Completion items must have valid labels')
    return item.label
  })
}

async function semantics(client: Client, uri: string, source: string, kind: TemplateKind): Promise<void> {
  const textDocument = { uri }
  stage = `${kind} unresolved template asset document links`
  const links = await client.request('textDocument/documentLink', { textDocument })
  assert(Array.isArray(links) && links.every(DocumentLink.is), 'Template links must be actual mapped document links')
  const asset = position(source, 'qualification-missing.svg', 1)
  const assetUri = pathToFileURL(path.join(client.directory, 'qualification-missing.svg')).href
  assert(links.some(link => contains(link.range, asset) && typeof link.target === 'string'
    && new URL(link.target, uri).href === assetUri), 'Missing local template asset must retain its genuine unresolved document link')
  stage = `${kind} semantics after unresolved template asset`
  const symbols = await client.request('textDocument/documentSymbol', { textDocument })
  assert(functionSymbol(symbols, source, uri), 'SFC script function must be returned as a mapped semantic function symbol')
  const definition = await client.request('textDocument/definition', { textDocument, position: position(source, 'consumeCount(value)', 3) })
  const locations = Array.isArray(definition) ? definition : [definition]
  const targetUri = pathToFileURL(path.join(client.directory, 'contracts.ts')).href
  const declaration = position(contracts, 'function consumeCount', 'function '.length)
  assert(locations.some((location: unknown) => Location.is(location)
    ? location.uri === targetUri && contains(location.range, declaration)
    : LocationLink.is(location) && location.targetUri === targetUri && contains(location.targetSelectionRange, declaration)), 'Definition must resolve to the real imported function declaration')
  const atFunction = position(source, 'localFormat(entry.count)', 3)
  const references = await client.request('textDocument/references', { textDocument, position: atFunction, context: { includeDeclaration: true } })
  assert(Array.isArray(references) && references.every(Location.is), 'References must be actual mapped locations')
  for (const needle of ['function localFormat', 'localFormat(1)', 'localFormat(entry.count)']) {
    const point = position(source, needle, needle.startsWith('function') ? 'function '.length : 1)
    assert(references.some(location => location.uri === uri && contains(location.range, point)), 'References must include declaration, script call, and template call')
  }
  const hover = await client.request('textDocument/hover', { textDocument, position: atFunction })
  assert(Hover.is(hover), 'Template function hover must be semantic')
  const contents = MarkupContent.is(hover.contents) ? hover.contents.value
    : (Array.isArray(hover.contents) ? hover.contents : [hover.contents]).map(item => typeof item === 'string' ? item : item.value).join('\n')
  assert(/localFormat/.test(contents) && /number/.test(contents) && /string/.test(contents), 'Hover must preserve the actual parameter and return types')
  const rename = await client.request('textDocument/rename', { textDocument, position: atFunction, newName: 'formatQualifiedCount' })
  assert(WorkspaceEdit.is(rename), 'Rename must return an actual workspace edit')
  const edits: TextEdit[] = [...(rename.changes?.[uri] ?? [])]
  for (const change of rename.documentChanges ?? []) {
    assert(TextDocumentEdit.is(change), 'Local rename must not create or delete files')
    assert.equal(change.textDocument.uri, uri, 'Local rename must stay inside its owning SFC')
    for (const edit of change.edits) {
      assert(TextEdit.is(edit), 'Rename edits must be concrete source text edits')
      edits.push(edit)
    }
  }
  for (const needle of ['function localFormat', 'localFormat(1)', 'localFormat(entry.count)']) {
    const point = position(source, needle, needle.startsWith('function') ? 'function '.length : 1)
    assert(edits.some(edit => contains(edit.range, point) && sourceRange(source, edit.range) === 'localFormat' && edit.newText === 'formatQualifiedCount'), 'Rename must edit the declaration and both script/template uses')
  }
  const variables = completionLabels(await client.request('textDocument/completion', { textDocument, position: position(source, 'localFormat(entry.count)', 'local'.length), context: { triggerKind: 1 } }))
  assert(variables.includes('localFormat'), 'Template expression completion must include the declared function')
  const componentNeedle = kind === 'html' ? '<CounterPanel' : '  CounterPanel'
  const components = completionLabels(await client.request('textDocument/completion', { textDocument, position: position(source, componentNeedle, componentNeedle.length - 'Panel'.length), context: { triggerKind: 1 } }))
  assert(components.some(label => /^(CounterPanel|counter-panel)$/.test(label)), 'Template tag completion must include the real imported component')
  const formatting = await client.request('textDocument/formatting', { textDocument, options: { tabSize: 2, insertSpaces: true } })
  assert(Array.isArray(formatting) && formatting.length > 0 && formatting.every(TextEdit.is), 'Vue formatting must return real edits for unformatted style content')
  assert(formatting.some(edit => sourceRange(source, edit.range) !== edit.newText), 'Formatting must change actual fixture layout')
}

async function clientCommand(client: Client): Promise<void> {
  // Volar deliberately omits Vue navigation-tree children. Exercise TSLS's
  // reference lens on the real TS declaration, retaining both mapped Vue uses.
  stage = 'reference code lens client command'
  const uri = await client.open('contracts.ts', contracts, 'typescript')
  const lenses = await client.request('textDocument/codeLens', { textDocument: { uri } })
  assert(Array.isArray(lenses) && lenses.every(CodeLens.is), 'Enabled reference lenses must return actual code lenses')
  const declaration = position(contracts, 'function consumeCount', 'function '.length)
  const lens = lenses.find(item => contains(item.range, declaration))
  assert(lens, 'Reference code lens must cover its eligible exported declaration')
  const resolved = await client.request('codeLens/resolve', lens)
  assert(CodeLens.is(resolved) && resolved.command, 'Reference code lens must resolve to a concrete command')
  assert.equal(resolved.command.command, 'editor.action.showReferences', 'Reference code lens must preserve its client-owned navigation command')
  const args: unknown = resolved.command.arguments
  assert(Array.isArray(args) && args.length === 3 && args[0] === uri
    && Position.is(args[1]) && contains(lens.range, args[1])
    && Array.isArray(args[2]) && args[2].every(Location.is),
  'Reference code lens must retain its genuine URI, position and reference locations')
  for (const kind of ['html', 'pug'] as const) {
    const consumerUri = pathToFileURL(path.join(client.directory, kind === 'html' ? 'Html.vue' : 'Pug.vue')).href
    const point = position(consumer(kind, true), 'consumeCount(value)', 3)
    assert(args[2].some((location: Location) => location.uri === consumerUri && contains(location.range, point)),
      'Reference navigation must include the actual HTML and Pug consumers')
  }
}

async function qualify(directory: string): Promise<void> {
  const client = new Client(directory)
  try {
    stage = 'semantic admission'
    await client.initialize()
    const fixtures = []
    for (const kind of ['html', 'pug'] as const) {
      const source = consumer(kind, false)
      const uri = await client.open(kind === 'html' ? 'Html.vue' : 'Pug.vue', source)
      fixtures.push({ kind, source, uri })
    }
    // The README admission contract is symbols + real declaration + diagnostics
    // within one deadline, not repeated 30-second request retries.
    for (const fixture of fixtures) {
      stage = `${fixture.kind} semantic admission`
      const textDocument = { uri: fixture.uri }
      const symbols = await client.request('textDocument/documentSymbol', { textDocument })
      assert(functionSymbol(symbols, fixture.source, fixture.uri), 'Semantic admission requires the real SFC function symbol')
      const definition = await client.request('textDocument/definition', { textDocument, position: position(fixture.source, 'consumeCount(value)', 3) })
      const targets = Array.isArray(definition) ? definition : [definition]
      const targetUri = pathToFileURL(path.join(directory, 'contracts.ts')).href
      const declaration = position(contracts, 'function consumeCount', 'function '.length)
      assert(targets.some((target: unknown) => Location.is(target)
        ? target.uri === targetUri && contains(target.range, declaration)
        : LocationLink.is(target) && target.targetUri === targetUri && contains(target.targetSelectionRange, declaration)), 'Semantic admission must resolve a real declaration')
      stage = `${fixture.kind} negative diagnostics admission`
      await client.waitDiagnostics(fixture.uri, 0, 1, diagnostics => expectedErrors(fixture.source, diagnostics))
    }
    client.requireRealChildren()
    for (const fixture of fixtures) {
      stage = `${fixture.kind} corrected diagnostics`
      const source = consumer(fixture.kind, true)
      const after = client.checkpoint()
      await client.notify('textDocument/didChange', { textDocument: { uri: fixture.uri, version: 2 }, contentChanges: [{ text: source }] })
      await semantics(client, fixture.uri, source, fixture.kind)
      await client.waitDiagnostics(fixture.uri, after, 2, diagnostics => diagnostics.every(diagnostic => diagnostic.severity !== 1))
    }
    await clientCommand(client)
    stage = 'shutdown and exit retirement'
    await client.retire('shutdown')
  } finally { client.dispose() }

  const eof = new Client(directory)
  try {
    stage = 'client EOF admission'
    await eof.initialize()
    const source = consumer('html', true)
    const uri = await eof.open('Html.vue', source)
    const symbols = await eof.request('textDocument/documentSymbol', { textDocument: { uri } })
    assert(functionSymbol(symbols, source, uri), 'EOF session must admit real semantic work before disconnect')
    stage = 'client EOF retirement'
    await eof.retire('eof')
  } finally { eof.dispose() }

  const interruptedInitialization = new Client(directory)
  let initializationFinished = false
  const initializing = interruptedInitialization.initialize().then(
    () => { initializationFinished = true },
    () => { initializationFinished = true }
  )
  try {
    stage = 'pending initialization owned-child admission'
    // Observe a real upstream CLI while initialize is still pending. Requiring
    // tsserver here would introduce a race: TSLS starts it and returns its own
    // initialize result synchronously. No artificial backend delay is used.
    await interruptedInitialization.waitForInitializationChild(() => initializationFinished || interruptedInitialization.initializationResponseReceived)
    assert(!initializationFinished && !interruptedInitialization.initializationResponseReceived,
      'EOF interruption must precede the actual initialize response')
    await interruptedInitialization.retire('initialization-eof')
  } finally {
    interruptedInitialization.dispose()
    await initializing
  }
}

let directory: string | undefined
const interrupted = (): void => {
  for (const client of active) client.dispose()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  process.exitCode = 1
}
process.once('SIGTERM', interrupted)
process.once('SIGINT', interrupted)
try {
  assert(process.versions.bun, 'Qualification must run with the repository Bun launcher')
  assert.equal(process.platform, 'linux', 'Process lifecycle qualification requires Linux procfs')
  const arguments_ = process.argv.slice(2)
  assert(arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--editor-launcher'),
    'Qualification accepts only the optional --editor-launcher argument')
  if (arguments_.length === 1) launcher = editorLauncher()
  directory = fs.mkdtempSync(path.join(root, '.vue-lsp-qualification-'))
  fs.writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true, noEmit: true, types: [], lib: ['ESNext', 'DOM'] },
    vueCompilerOptions: { strictTemplates: true, plugins: ['@vue/language-plugin-pug'] },
    files: ['contracts.ts', 'CounterPanel.vue', 'Html.vue', 'Pug.vue'], include: []
  }))
  fs.writeFileSync(path.join(directory, 'contracts.ts'), contracts)
  fs.writeFileSync(path.join(directory, 'CounterPanel.vue'), component)
  fs.writeFileSync(path.join(directory, 'Html.vue'), consumer('html', false))
  fs.writeFileSync(path.join(directory, 'Pug.vue'), consumer('pug', false))
  await qualify(directory)
  console.log('PASS Vue bridge: HTML/Pug semantics, missing-asset links, reference lens client command, diagnostics correction, template completion, formatting, shutdown/exit, client EOF, interrupted initialization')
} catch (error: unknown) {
  // Only author-owned categories and numeric public protocol codes are safe;
  // never forward upstream messages, actual values, source paths, or payloads.
  console.error(`FAIL Vue bridge qualification: ${stage}: ${safeFailureReason(error)}`)
  process.exitCode = 1
} finally {
  for (const client of active) client.dispose()
  process.removeListener('SIGTERM', interrupted)
  process.removeListener('SIGINT', interrupted)
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
}
