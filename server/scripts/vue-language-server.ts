import {
  CancellationToken,
  createMessageConnection,
  ErrorCodes,
  NullLogger,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection
} from 'vscode-jsonrpc/node'
import { fields, isFields, localTypescript, localVuePlugin, Upstream, type Backend, type Fields } from './vue-language-server-upstream.ts'

type Strategy = 'typescript' | 'vue' | 'merge' | 'completion' | 'semanticFirst' | 'vueFirst'
interface Feature {
  capability: string
  strategy: Strategy
  resolve?: string
}
interface DiagnosticReport {
  diagnostics: unknown[]
  version: number | undefined
}
interface ItemOrigin {
  backend: Backend
  data: unknown
}
type TsserverRequest = [number, string, unknown]

// Routing is by actual upstream capability, never by inspecting SFC source text.
const features: Record<string, Feature> = {
  'textDocument/completion': { capability: 'completionProvider', strategy: 'completion', resolve: 'completionItem/resolve' },
  'textDocument/codeAction': { capability: 'codeActionProvider', strategy: 'merge', resolve: 'codeAction/resolve' },
  'textDocument/documentSymbol': { capability: 'documentSymbolProvider', strategy: 'merge' },
  'textDocument/codeLens': { capability: 'codeLensProvider', strategy: 'merge', resolve: 'codeLens/resolve' },
  'textDocument/inlayHint': { capability: 'inlayHintProvider', strategy: 'merge', resolve: 'inlayHint/resolve' },
  'textDocument/documentLink': { capability: 'documentLinkProvider', strategy: 'vue', resolve: 'documentLink/resolve' },
  'textDocument/definition': { capability: 'definitionProvider', strategy: 'merge' },
  'textDocument/declaration': { capability: 'declarationProvider', strategy: 'merge' },
  'textDocument/typeDefinition': { capability: 'typeDefinitionProvider', strategy: 'merge' },
  'textDocument/implementation': { capability: 'implementationProvider', strategy: 'merge' },
  'textDocument/references': { capability: 'referencesProvider', strategy: 'merge' },
  'textDocument/documentHighlight': { capability: 'documentHighlightProvider', strategy: 'merge' },
  'textDocument/hover': { capability: 'hoverProvider', strategy: 'semanticFirst' },
  'textDocument/rename': { capability: 'renameProvider', strategy: 'vueFirst' },
  'textDocument/prepareRename': { capability: 'renameProvider', strategy: 'vueFirst' },
  'textDocument/signatureHelp': { capability: 'signatureHelpProvider', strategy: 'typescript' },
  'textDocument/formatting': { capability: 'documentFormattingProvider', strategy: 'vue' },
  'textDocument/rangeFormatting': { capability: 'documentRangeFormattingProvider', strategy: 'vue' },
  'textDocument/onTypeFormatting': { capability: 'documentOnTypeFormattingProvider', strategy: 'vue' },
  'textDocument/foldingRange': { capability: 'foldingRangeProvider', strategy: 'vue' },
  'textDocument/selectionRange': { capability: 'selectionRangeProvider', strategy: 'vue' },
  'textDocument/linkedEditingRange': { capability: 'linkedEditingRangeProvider', strategy: 'vue' },
  'textDocument/documentColor': { capability: 'colorProvider', strategy: 'vue' },
  'textDocument/colorPresentation': { capability: 'colorProvider', strategy: 'vue' },
  'textDocument/semanticTokens/full': { capability: 'semanticTokensProvider', strategy: 'vue' },
  'textDocument/semanticTokens/full/delta': { capability: 'semanticTokensProvider', strategy: 'vue' },
  'textDocument/semanticTokens/range': { capability: 'semanticTokensProvider', strategy: 'vue' },
  'workspace/symbol': { capability: 'workspaceSymbolProvider', strategy: 'typescript' },
  'workspaceSymbol/resolve': { capability: 'workspaceSymbolProvider', strategy: 'typescript' },
  'textDocument/prepareCallHierarchy': { capability: 'callHierarchyProvider', strategy: 'typescript' },
  'callHierarchy/incomingCalls': { capability: 'callHierarchyProvider', strategy: 'typescript' },
  'callHierarchy/outgoingCalls': { capability: 'callHierarchyProvider', strategy: 'typescript' },
  'textDocument/prepareTypeHierarchy': { capability: 'typeHierarchyProvider', strategy: 'typescript' },
  'typeHierarchy/supertypes': { capability: 'typeHierarchyProvider', strategy: 'typescript' },
  'typeHierarchy/subtypes': { capability: 'typeHierarchyProvider', strategy: 'typescript' }
}
const bridgeCommand = 'tsepistle.vue.execute'
const internalCommand = 'typescript.tsserverRequest'
const completionCodeActionCommand = '_typescript.applyCompletionCodeAction'

function distinct(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = JSON.stringify(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isTsserverRequest(value: unknown): value is TsserverRequest {
  return Array.isArray(value) && value.length === 3 && typeof value[0] === 'number' && typeof value[1] === 'string'
}

function itemOrigin(item: Fields): ItemOrigin {
  const origin = fields(fields(item.data).tsepistleVueBridge)
  if (origin.backend !== 'typescript' && origin.backend !== 'vue') {
    throw new ResponseError(ErrorCodes.InvalidParams, 'The item has no language-server origin.')
  }
  return { backend: origin.backend, data: origin.data }
}

function isServerCommand(upstream: Upstream, command: string): boolean {
  if (command === internalCommand || command === bridgeCommand) return false
  // TSLS emits this completion command and handles it, but omits it from its
  // executeCommandProvider list (5.3.0 cli.mjs:21393 and 24543).
  if (upstream.backend === 'typescript' && command === completionCodeActionCommand) return true
  const declared = fields(upstream.capabilities.executeCommandProvider).commands
  return Array.isArray(declared) && declared.includes(command)
}

function wrapCommand(command: Fields, upstream: Upstream): Fields {
  if (typeof command.command !== 'string' || !isServerCommand(upstream, command.command)) return command
  return {
    ...command,
    command: bridgeCommand,
    arguments: [{ backend: upstream.backend, command: command.command, arguments: command.arguments }]
  }
}

function ownItem(value: unknown, upstream: Upstream): unknown {
  if (!isFields(value)) throw new ResponseError(ErrorCodes.InternalError, 'A language server returned an invalid resolvable item.')
  if (typeof value.command === 'string') return wrapCommand(value, upstream)
  return {
    ...value,
    ...(isFields(value.command) ? { command: wrapCommand(value.command, upstream) } : {}),
    data: { tsepistleVueBridge: { backend: upstream.backend, data: value.data } }
  }
}

function unownItem(value: Fields): Fields {
  const { data: _data, ...item } = value
  const origin = itemOrigin(value)
  if (origin.data !== undefined) item.data = origin.data
  if (isFields(item.command) && item.command.command === bridgeCommand) {
    const args = item.command.arguments
    if (Array.isArray(args) && isFields(args[0])) {
      item.command = { ...item.command, command: args[0].command, arguments: args[0].arguments }
    }
  }
  return item
}

function completionItems(result: unknown): Fields[] {
  const list = fields(result)
  const defaults = fields(list.itemDefaults)
  const items = Array.isArray(result) ? result : list.items
  if (result === null || result === undefined) return []
  if (!Array.isArray(items)) throw new ResponseError(ErrorCodes.InternalError, 'A language server returned an invalid completion list.')
  return items.map(value => {
    if (!isFields(value)) throw new ResponseError(ErrorCodes.InternalError, 'A language server returned an invalid completion item.')
    const item = { ...value }
    for (const key of ['commitCharacters', 'insertTextFormat', 'insertTextMode', 'data']) {
      if (item[key] === undefined && defaults[key] !== undefined) item[key] = defaults[key]
    }
    if (item.textEdit === undefined && isFields(defaults.editRange)) {
      const newText = item.textEditText ?? item.insertText ?? item.label
      item.textEdit = defaults.editRange.start !== undefined
        ? { range: defaults.editRange, newText }
        : { ...defaults.editRange, newText }
    }
    return item
  })
}

function upstreamCapabilities(input: Fields): Fields {
  const capabilities = fields(input.capabilities)
  const textDocument = fields(capabilities.textDocument)
  const workspace = fields(capabilities.workspace)
  // One public push-diagnostic stream. Neither upstream may dynamically claim
  // editor features or negotiate a separate pull-diagnostic owner.
  return {
    ...capabilities,
    window: { ...fields(capabilities.window), workDoneProgress: false },
    textDocument: Object.fromEntries(Object.entries(textDocument).map(([key, value]) => [
      key, isFields(value) ? { ...value, dynamicRegistration: false } : value
    ]).filter(([key]) => key !== 'diagnostic')),
    workspace: { ...workspace, diagnostics: undefined, semanticTokens: { ...fields(workspace.semanticTokens), refreshSupport: false } }
  }
}

class VueLanguageBridge {
  private readonly client: MessageConnection
  private readonly upstreams: Upstream[] = []
  private readonly versions = new Map<string, number>()
  private readonly closedDocuments = new Set<string>()
  private readonly diagnostics: Record<Backend, Map<string, DiagnosticReport>> = {
    typescript: new Map(), vue: new Map()
  }
  private readonly commands = new Map<string, Upstream>()
  private notificationBarrier: Promise<void> = Promise.resolve()
  private initializePromise: Promise<unknown> | undefined
  private shutdownPromise: Promise<void> | undefined
  private initialized = false
  private exiting = false
  private failed = false

  constructor() {
    this.client = createMessageConnection(
      new StreamMessageReader(process.stdin),
      new StreamMessageWriter(process.stdout),
      NullLogger
    )
    this.client.onRequest((method: string, params: unknown, token: CancellationToken) => this.request(method, params, token))
    this.client.onNotification((method: string, params: unknown) => {
      if (method === 'exit') {
        void this.exit(this.shutdownPromise ? 0 : 1)
        return
      }
      if (this.exiting) return
      this.notificationBarrier = this.notificationBarrier.then(() => this.notify(method, params))
      void this.notificationBarrier.catch(() => this.failure())
    })
    this.client.onClose(() => { void this.exit(this.failed ? 1 : 0) })
    this.client.onError(() => this.failure())
    process.stdin.on('end', () => { void this.exit(this.failed ? 1 : 0) })
    process.stdin.on('error', () => this.failure())
    process.stdout.on('error', () => { void this.exit(1) })
    process.once('SIGTERM', () => { void this.exit(0) })
    process.once('SIGINT', () => { void this.exit(0) })
    process.once('SIGHUP', () => { void this.exit(0) })
    process.once('exit', () => {
      for (const upstream of this.upstreams) upstream.killGroup('SIGKILL')
    })
  }

  listen(): void {
    this.client.listen()
  }

  private failure(): void {
    if (this.failed || this.exiting) return
    this.failed = true
    process.stderr.write('Vue language bridge: an upstream or protocol operation failed.\n')
    void this.exit(1)
  }

  private async exit(code: number): Promise<void> {
    if (this.exiting) return
    this.exiting = true
    try {
      await this.shutdown()
    } catch {
      code = 1
    } finally {
      this.client.dispose()
      process.exit(code)
    }
  }

  private shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      // VueLS may finish background work through tsserver while shutting down.
      // Retire the dependent first, keeping its semantic host alive throughout.
      let failed = false
      for (let index = this.upstreams.length - 1; index >= 0; index--) {
        try {
          await this.upstreams[index]!.stop()
        } catch {
          failed = true
        }
      }
      if (failed) {
        throw new ResponseError(ErrorCodes.InternalError, 'An upstream language server failed to shut down.')
      }
    })()
    return this.shutdownPromise
  }

  private backend(name: Backend): Upstream {
    const upstream = this.upstreams.find(candidate => candidate.backend === name)
    if (!upstream) throw new ResponseError(ErrorCodes.ServerNotInitialized, 'The Vue language bridge is not initialized.')
    return upstream
  }

  private async initialize(params: unknown, token: CancellationToken): Promise<unknown> {
    if (!isFields(params)) throw new ResponseError(ErrorCodes.InvalidParams, 'Expected LSP initialize parameters.')
    for (const name of ['typescript', 'vue'] satisfies Backend[]) {
      const upstream = new Upstream(name, () => this.failure())
      this.upstreams.push(upstream)
      upstream.connection.onRequest((method: string, value: unknown, cancellation: CancellationToken) => this.upstreamRequest(upstream, method, value, cancellation))
      upstream.connection.onNotification((method: string, value: unknown) => this.upstreamNotification(upstream, method, value).catch(() => {
        // An in-flight notification can complete after its intentionally stopped
        // recipient has closed. Its transport is already owned by stop().
        if (!upstream.stopping) this.failure()
      }))
      upstream.connection.listen()
    }
    const capabilities = upstreamCapabilities(params)
    const options = fields(params.initializationOptions)
    const typescriptOptions = {
      ...options,
      disableAutomaticTypingAcquisition: true,
      hostInfo: 'tsepistle-vue-bridge',
      plugins: [{ name: '@vue/typescript-plugin', location: localVuePlugin, languages: ['vue'] }],
      tsserver: { path: localTypescript, useSyntaxServer: 'never', logVerbosity: 'off', trace: 'off' }
    }
    // Initialize the semantic host first so every subsequent Vue custom request
    // reaches the real, plugin-enabled tsserver rather than an absent service.
    for (const upstream of this.upstreams) {
      const result = await upstream.request('initialize', {
        ...params,
        processId: process.pid,
        capabilities,
        initializationOptions: upstream.backend === 'typescript'
          ? typescriptOptions
          : { ...options, typescript: { tsdk: localTypescript } }
      }, token)
      if (!isFields(result) || !isFields(result.capabilities)) {
        throw new ResponseError(ErrorCodes.InternalError, 'An upstream returned invalid initialization capabilities.')
      }
      upstream.capabilities = result.capabilities
      upstream.initialized = true
    }
    this.initialized = true
    return {
      capabilities: this.capabilities(),
      serverInfo: { name: 'tsepistle-vue-language-bridge', version: '3.3.9' }
    }
  }

  private candidates(feature: Feature): Upstream[] {
    const order: Backend[] = feature.strategy === 'typescript' ? ['typescript']
      : feature.strategy === 'vue' ? ['vue']
      : feature.strategy === 'vueFirst' ? ['vue', 'typescript'] : ['typescript', 'vue']
    return order.map(name => this.backend(name)).filter(upstream => Boolean(upstream.capabilities[feature.capability]))
  }

  private capabilities(): Fields {
    const capabilities: Fields = {
      textDocumentSync: { openClose: true, change: 2, save: { includeText: false } }
    }
    for (const feature of Object.values(features)) {
      if (capabilities[feature.capability] !== undefined) continue
      const candidates = this.candidates(feature)
      if (!candidates.length) continue
      const providers = candidates.map(upstream => upstream.capabilities[feature.capability])
      if (providers.every(value => value === true)) {
        capabilities[feature.capability] = true
        continue
      }
      const provider = { ...fields(providers[0]) }
      // A merged provider can resolve an item whenever its owning upstream can.
      for (const key of ['triggerCharacters', 'allCommitCharacters', 'codeActionKinds', 'retriggerCharacters']) {
        const values = providers.flatMap(value => {
          const entries = fields(value)[key]
          return Array.isArray(entries) ? entries : []
        })
        if (values.length) provider[key] = distinct(values)
      }
      for (const key of ['resolveProvider', 'prepareProvider']) {
        if (providers.some(value => fields(value)[key] === true)) provider[key] = true
      }
      capabilities[feature.capability] = Object.keys(provider).length ? provider : providers[0]
    }
    const commands: string[] = []
    for (const upstream of this.upstreams) {
      const declared = fields(upstream.capabilities.executeCommandProvider).commands
      if (!Array.isArray(declared)) continue
      for (const command of declared) {
        if (typeof command !== 'string' || command === internalCommand) continue
        if (!this.commands.has(command)) this.commands.set(command, upstream)
        commands.push(command)
      }
    }
    this.commands.set(completionCodeActionCommand, this.backend('typescript'))
    commands.push(completionCodeActionCommand)
    if (commands.length) capabilities.executeCommandProvider = { commands: distinct([...commands, bridgeCommand]) }
    const vue = this.backend('vue').capabilities
    const typescript = this.backend('typescript').capabilities
    if (vue.positionEncoding || typescript.positionEncoding) capabilities.positionEncoding = vue.positionEncoding ?? typescript.positionEncoding
    capabilities.workspace = {
      workspaceFolders: { supported: true, changeNotifications: true },
      ...(fields(typescript.workspace).fileOperations ? { fileOperations: fields(typescript.workspace).fileOperations } : {})
    }
    return capabilities
  }

  private async request(method: string, params: unknown, token: CancellationToken): Promise<unknown> {
    if (method === 'initialize') {
      if (this.initializePromise) throw new ResponseError(ErrorCodes.InvalidRequest, 'The bridge has already received initialize.')
      this.initializePromise = this.initialize(params, token)
      try {
        return await this.initializePromise
      } catch (error) {
        this.failure()
        throw error
      }
    }
    if (method === 'shutdown') {
      await this.shutdown()
      return null
    }
    if (!this.initialized) throw new ResponseError(ErrorCodes.ServerNotInitialized, 'The Vue language bridge is not initialized.')
    if (this.shutdownPromise) throw new ResponseError(ErrorCodes.InvalidRequest, 'The Vue language bridge has shut down.')
    await this.notificationBarrier
    if (token.isCancellationRequested) throw new ResponseError(-32800, 'The client cancelled the request.')
    if (method === 'workspace/executeCommand') return await this.executeCommand(params, token)
    if (method === 'workspace/willRenameFiles') return await this.backend('typescript').request(method, params, token)
    const resolver = Object.values(features).find(feature => feature.resolve === method)
    if (resolver) {
      if (!isFields(params)) throw new ResponseError(ErrorCodes.InvalidParams, 'Expected a resolvable language-server item.')
      const origin = itemOrigin(params)
      const upstream = this.backend(origin.backend)
      const item = unownItem(params)
      if (fields(upstream.capabilities[resolver.capability]).resolveProvider !== true) return params
      const result = await upstream.request(method, item, token)
      return ownItem(result, upstream)
    }
    const feature = features[method]
    if (!feature) {
      // Vue's public custom requests (auto-insertion, virtual files, etc.) retain
      // their upstream implementation; the tsserver transport stays private.
      if (method.startsWith('vue/') || method.startsWith('volar/')) return await this.backend('vue').request(method, params, token)
      throw new ResponseError(ErrorCodes.MethodNotFound, 'The Vue language bridge does not implement this method.')
    }
    const candidates = this.candidates(feature).filter(upstream => method !== 'textDocument/prepareRename'
      || fields(upstream.capabilities.renameProvider).prepareProvider === true)
    if (!candidates.length) throw new ResponseError(ErrorCodes.MethodNotFound, 'Neither upstream supports this language feature.')
    if (feature.strategy === 'semanticFirst' || feature.strategy === 'vueFirst') {
      for (const upstream of candidates) {
        const result = await upstream.request(method, params, token)
        if (result !== undefined && result !== null) return result
      }
      return null
    }
    const merge = feature.strategy === 'merge' || feature.strategy === 'completion'
    const requestParams = merge && isFields(params) ? { ...params, partialResultToken: undefined, workDoneToken: undefined } : params
    const results = await Promise.all(candidates.map(upstream => upstream.request(method, requestParams, token)))
    if (feature.strategy === 'completion') {
      return {
        isIncomplete: results.some(result => fields(result).isIncomplete === true),
        items: results.flatMap((result, index) => completionItems(result).map(item => ownItem(item, candidates[index]!)))
      }
    }
    if (merge) {
      const items = results.flatMap((result, index) => {
        if (result === undefined || result === null) return []
        // Location is legal as a single definition result, unlike list features.
        const values = Array.isArray(result) ? result : [result]
        return feature.resolve ? values.map(item => ownItem(item, candidates[index]!)) : values
      })
      return distinct(items)
    }
    const result = results[0]
    return feature.resolve && Array.isArray(result) ? result.map(item => ownItem(item, candidates[0]!)) : result ?? null
  }

  private async executeCommand(params: unknown, token: CancellationToken): Promise<unknown> {
    const request = fields(params)
    if (request.command === bridgeCommand) {
      const argument = Array.isArray(request.arguments) ? fields(request.arguments[0]) : {}
      if ((argument.backend !== 'typescript' && argument.backend !== 'vue') || typeof argument.command !== 'string'
        || argument.command === internalCommand || argument.command === bridgeCommand) {
        throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid language-server command origin.')
      }
      if (!isServerCommand(this.backend(argument.backend), argument.command)) {
        throw new ResponseError(ErrorCodes.MethodNotFound, 'The command belongs to the editor, not this language server.')
      }
      return await this.backend(argument.backend).request('workspace/executeCommand', {
        command: argument.command, arguments: argument.arguments
      }, token)
    }
    if (typeof request.command !== 'string' || !this.commands.has(request.command)) {
      throw new ResponseError(ErrorCodes.MethodNotFound, 'The language-server command is not public.')
    }
    return await this.commands.get(request.command)!.request('workspace/executeCommand', params, token)
  }

  private async notify(method: string, params: unknown): Promise<void> {
    if (method.startsWith('tsserver/') || method === '$/cancelRequest') return
    if (this.initializePromise) await this.initializePromise
    if (!this.initialized || this.shutdownPromise) return
    const request = fields(params)
    const document = fields(request.textDocument)
    if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
      if (typeof document.uri === 'string' && typeof document.version === 'number') {
        this.versions.set(document.uri, document.version)
        this.closedDocuments.delete(document.uri)
        if (method === 'textDocument/didOpen') {
          for (const reports of Object.values(this.diagnostics)) reports.delete(document.uri)
        }
      }
    } else if (method === 'textDocument/didClose' && typeof document.uri === 'string') {
      this.versions.delete(document.uri)
      this.closedDocuments.add(document.uri)
      for (const reports of Object.values(this.diagnostics)) reports.delete(document.uri)
    }
    // Pipe writes are awaited in client order, with semantic open/change before
    // Vue. A Vue projectInfo notification therefore cannot overtake TSLS's open.
    for (const upstream of this.upstreams) await upstream.notify(method, params)
    if (method === 'textDocument/didClose' && typeof document.uri === 'string') {
      await this.client.sendNotification('textDocument/publishDiagnostics', { uri: document.uri, diagnostics: [] })
    }
  }

  private async upstreamRequest(upstream: Upstream, method: string, params: unknown, token: CancellationToken): Promise<unknown> {
    if (this.exiting) throw new ResponseError(-32800, 'The editor transport is closing.')
    if (method.startsWith('tsserver/')) throw new ResponseError(ErrorCodes.MethodNotFound, 'The tsserver transport is internal.')
    if (method === 'client/registerCapability' || method === 'client/unregisterCapability') {
      const key = method === 'client/registerCapability' ? 'registrations' : 'unregisterations'
      const registrations = fields(params)[key]
      if (Array.isArray(registrations)) {
        params = {
          ...fields(params),
          [key]: registrations.map(value => ({ ...fields(value), id: `${upstream.backend}:${fields(value).id}` }))
        }
      }
    }
    if (Array.isArray(params)) return await this.client.sendRequest<unknown>(method, ...params, token)
    if (params === undefined) return await this.client.sendRequest<unknown>(method, token)
    return await this.client.sendRequest<unknown>(method, params, token)
  }

  private async upstreamNotification(upstream: Upstream, method: string, params: unknown): Promise<void> {
    if (method === 'tsserver/request') {
      if (upstream.backend !== 'vue') throw new Error('Unexpected tsserver bridge origin.')
      const requests = isTsserverRequest(params) ? [params] : params
      if (!Array.isArray(requests) || !requests.every(isTsserverRequest)) throw new Error('Invalid Vue tsserver bridge request.')
      await Promise.all(requests.map(async ([id, command, args]) => {
        const response = await this.backend('typescript').request('workspace/executeCommand', {
          command: internalCommand,
          arguments: [command, args, { executionTarget: 0, expectsResult: true, isAsync: false, lowPriority: true }]
        }, CancellationToken.None)
        if (isFields(response) && response.type === 'noContent') {
          // TSLS maps tsserver's "No content available." to this explicit
          // successful-absence discriminator. Vue's response slot is absent.
          await upstream.notify('tsserver/response', [[id, null]])
          return
        }
        if (!isFields(response) || response.type !== 'response' || response.success !== true) {
          throw new Error('The semantic tsserver rejected a Vue bridge request.')
        }
        // TSLS returns the actual tsserver envelope; VueLS expects its body.
        await upstream.notify('tsserver/response', [[id, response.body ?? null]])
      }))
      return
    }
    if (method.startsWith('tsserver/') || method === 'window/logMessage' || method === '$/logTrace' || method === 'window/showMessage') return
    if (method === 'textDocument/publishDiagnostics') {
      await this.publishDiagnostics(upstream.backend, params)
      return
    }
    if (this.exiting || this.shutdownPromise) return
    if (Array.isArray(params)) await this.client.sendNotification(method, ...params)
    else if (params === undefined) await this.client.sendNotification(method)
    else await this.client.sendNotification(method, params)
  }

  private async publishDiagnostics(backend: Backend, params: unknown): Promise<void> {
    const report = fields(params)
    if (typeof report.uri !== 'string' || !Array.isArray(report.diagnostics)) throw new Error('Invalid upstream diagnostics.')
    const uri = report.uri
    if (this.closedDocuments.has(uri) || this.exiting || this.shutdownPromise) return
    const version = typeof report.version === 'number' ? report.version : undefined
    const currentVersion = this.versions.get(uri)
    if (version !== undefined && currentVersion !== undefined && version < currentVersion) return
    this.diagnostics[backend].set(uri, { diagnostics: report.diagnostics, version })
    const reports = Object.values(this.diagnostics).flatMap(reports => {
      const cached = reports.get(uri)
      if (!cached || (cached.version !== undefined && currentVersion !== undefined && cached.version < currentVersion)) return []
      return [cached]
    })
    const knownVersion = reports.length > 0 && reports.every(value => value.version !== undefined && value.version === reports[0]!.version)
      ? reports[0]!.version : undefined
    await this.client.sendNotification('textDocument/publishDiagnostics', {
      uri,
      diagnostics: distinct(reports.flatMap(value => value.diagnostics)),
      ...(knownVersion !== undefined ? { version: knownVersion } : {})
    })
  }
}

if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== '--stdio') {
    process.stderr.write('Usage: bun --no-env-file server/scripts/vue-language-server.ts --stdio\n')
    process.exitCode = 1
  } else {
    try {
      new VueLanguageBridge().listen()
    } catch {
      process.stderr.write('Vue language bridge: startup failed.\n')
      process.exitCode = 1
    }
  }
}
