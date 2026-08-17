import { createHash, randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import type { BrowserObservation } from '../../../shared/agents/contracts.ts'
import { assertPublicBrowserTarget } from './egress.ts'
import { BrowserWorkerError } from './errors.ts'
import { BrowserTargetError, parseCanonicalBrowserTarget } from './target.ts'

const MAX_TEXT = 50_000
const MAX_REFS = 200
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const blockedResourceTypes = new Set(['websocket', 'eventsource'])
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bounded = (value: string, maximum = MAX_TEXT): string => value.length <= maximum ? value : `${value.slice(0, maximum)}\n[truncated]`


export interface BrowserWorkerLimits {
  readonly contextTtlMilliseconds: number
  readonly maximumActions: number
  readonly maximumNavigations: number
  readonly maximumResponseBytes: number
}

export type BrowserWorkerAction =
  | { readonly kind: 'navigate'; readonly url: string; readonly attestedUrls: readonly string[] }
  | { readonly kind: 'observe' }
  | { readonly kind: 'act'; readonly action: 'scrollIntoView' | 'followLink'; readonly ref: string; readonly documentEpoch: string; readonly attestedUrls: readonly string[] }
  | { readonly kind: 'extract' }
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'close' }

export interface BrowserWorkerRequest {
  readonly contextId: string
  readonly actionCallId: string
  readonly sequence: number
  readonly action: BrowserWorkerAction
  readonly limits: BrowserWorkerLimits
}

export type BrowserWorkerResult =
  | { readonly kind: 'navigated'; readonly observation: BrowserObservation }
  | { readonly kind: 'observed'; readonly observation: BrowserObservation }
  | { readonly kind: 'acted'; readonly observation: BrowserObservation }
  | { readonly kind: 'extracted'; readonly url: string; readonly text: string; readonly links: readonly { text: string; href: string }[]; readonly observedAt: string }
  | { readonly kind: 'screenshot'; readonly bytes: Buffer; readonly mimeType: 'image/png'; readonly width: number; readonly height: number }
  | { readonly kind: 'closed' }

interface RefEntry { readonly locator: Locator; readonly href: string | null; readonly role: string; readonly name: string }
interface CachedResult { readonly hash: string; readonly result: BrowserWorkerResult }
interface WorkerContext {
  readonly browserContext: BrowserContext
  readonly page: Page
  readonly expiresAt: number
  readonly results: Map<string, CachedResult>
  readonly refs: Map<string, RefEntry>
  sequence: number
  actions: number
  navigations: number
  responseBytes: number
  documentEpoch: string
  allowedUrls: Set<string>
}

export interface BrowserWorkerOptions { readonly executablePath?: string; readonly now?: () => number }

export class IsolatedBrowserWorker {
  readonly #options: BrowserWorkerOptions
  readonly #contexts = new Map<string, WorkerContext>()
  #browser: Browser | null = null
  constructor(options: BrowserWorkerOptions = {}) { this.#options = options }

  async #browserInstance(): Promise<Browser> {
    this.#browser ??= await chromium.launch({ headless: true, ...(this.#options.executablePath ? { executablePath: this.#options.executablePath } : {}) })
    return this.#browser
  }

  async #create(request: BrowserWorkerRequest): Promise<WorkerContext> {
    if (request.sequence !== 1 || request.action.kind !== 'navigate') throw new BrowserWorkerError('CONTEXT_LOST', 'Browser context does not exist', 404)
    const browserContext = await (await this.#browserInstance()).newContext({ acceptDownloads: false, bypassCSP: false, ignoreHTTPSErrors: false, javaScriptEnabled: true, serviceWorkers: 'block', viewport: { width: 1280, height: 720 } })
    const page = await browserContext.newPage()
    const context: WorkerContext = { browserContext, page, expiresAt: (this.#options.now?.() ?? Date.now()) + request.limits.contextTtlMilliseconds, results: new Map(), refs: new Map(), sequence: 0, actions: 0, navigations: 0, responseBytes: 0, documentEpoch: randomUUID(), allowedUrls: new Set() }
    page.on('popup', popup => { void popup.close() })
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) { context.documentEpoch = randomUUID(); context.refs.clear() } })
    await browserContext.route('**/*', async route => {
      const resourceRequest = route.request()
      if (resourceRequest.method() !== 'GET' || blockedResourceTypes.has(resourceRequest.resourceType())) return route.abort('blockedbyclient')
      let canonical: string
      try { canonical = parseCanonicalBrowserTarget(resourceRequest.url()).canonicalUrl } catch { return route.abort('blockedbyclient') }
      if (!context.allowedUrls.has(canonical)) return route.abort('blockedbyclient')
      try { await assertPublicBrowserTarget(canonical) } catch { return route.abort('blockedbyclient') }
      return route.continue()
    })
    this.#contexts.set(request.contextId, context)
    return context
  }

  #attested(urls: readonly string[]): Set<string> {
    if (urls.length < 1 || urls.length > 100) throw new BrowserWorkerError('INVALID_ATTESTED_TARGETS', 'Attested target set is invalid', 400)
    return new Set(urls.map(url => parseCanonicalBrowserTarget(url).canonicalUrl))
  }

  async execute(request: BrowserWorkerRequest): Promise<BrowserWorkerResult> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(request.contextId) || !/^[A-Za-z0-9_-]{16,128}$/.test(request.actionCallId)) throw new BrowserWorkerError('INVALID_BROWSER_REQUEST', 'Browser request identity is invalid', 400)
    let context = this.#contexts.get(request.contextId)
    if (!context) context = await this.#create(request)
    if ((this.#options.now?.() ?? Date.now()) >= context.expiresAt) { await this.#closeContext(request.contextId, context); throw new BrowserWorkerError('CONTEXT_EXPIRED', 'Browser context expired', 410) }
    const requestHash = digest(request)
    const cached = context.results.get(request.actionCallId)
    if (cached) {
      if (cached.hash !== requestHash) throw new BrowserWorkerError('ACTION_NONCE_REUSED', 'Browser action identifier was reused with different input')
      return cached.result
    }
    if (request.sequence !== context.sequence + 1) throw new BrowserWorkerError('ACTION_SEQUENCE_INVALID', 'Browser action sequence is stale or reordered')
    if (++context.actions > request.limits.maximumActions) throw new BrowserWorkerError('ACTION_BUDGET_EXCEEDED', 'Browser action budget is exhausted', 429)
    let result: BrowserWorkerResult
    try {
      result = await this.#dispatch(context, request.action, request.limits)
    } catch (error) {
      if (error instanceof BrowserWorkerError || error instanceof BrowserTargetError) throw error
      throw new BrowserWorkerError('BROWSER_ACTION_FAILED', 'Browser action failed', 502)
    }
    context.sequence = request.sequence
    context.results.set(request.actionCallId, { hash: requestHash, result })
    return result
  }

  async #dispatch(context: WorkerContext, action: BrowserWorkerAction, limits: BrowserWorkerLimits): Promise<BrowserWorkerResult> {
    if (action.kind === 'close') { const id = [...this.#contexts].find(([, value]) => value === context)?.[0]; if (id) await this.#closeContext(id, context); return { kind: 'closed' } }
    if (action.kind === 'navigate') {
      if (++context.navigations > limits.maximumNavigations) throw new BrowserWorkerError('NAVIGATION_BUDGET_EXCEEDED', 'Browser navigation budget is exhausted', 429)
      const target = parseCanonicalBrowserTarget(action.url)
      await assertPublicBrowserTarget(target.canonicalUrl)
      context.allowedUrls = this.#attested(action.attestedUrls)
      if (!context.allowedUrls.has(target.canonicalUrl)) throw new BrowserWorkerError('TARGET_NOT_ATTESTED', 'Browser target is not attested', 403)
      const response = await context.page.goto(target.canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
      const contentLength = Number(response?.headers()['content-length'] ?? 0)
      if (Number.isSafeInteger(contentLength) && contentLength > 0) context.responseBytes += contentLength
      if (context.responseBytes > limits.maximumResponseBytes) throw new BrowserWorkerError('BYTE_BUDGET_EXCEEDED', 'Browser response byte budget is exhausted', 429)
      return { kind: 'navigated', observation: await this.#observe(context) }
    }
    if (action.kind === 'observe') return { kind: 'observed', observation: await this.#observe(context) }
    if (action.kind === 'extract') {
      const text = bounded(await context.page.locator('body').innerText({ timeout: 5_000 }))
      const anchors = context.page.locator('a[href]')
      const count = Math.min(await anchors.count(), MAX_REFS)
      const links: Array<{ text: string; href: string }> = []
      for (let index = 0; index < count; index++) {
        const anchor = anchors.nth(index)
        const href = await anchor.getAttribute('href')
        if (!href) continue
        try { links.push({ text: bounded((await anchor.innerText()).trim(), 512), href: new URL(href, context.page.url()).toString() }) } catch { /* omit malformed page href */ }
      }
      return { kind: 'extracted', url: context.page.url(), text, links, observedAt: new Date().toISOString() }
    }
    if (action.kind === 'screenshot') {
      const bytes = await context.page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' })
      if (bytes.byteLength > MAX_SCREENSHOT_BYTES || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new BrowserWorkerError('SCREENSHOT_INVALID', 'Browser screenshot exceeds limits or is invalid', 502)
      return { kind: 'screenshot', bytes, mimeType: 'image/png', width: 1280, height: 720 }
    }
    if (action.documentEpoch !== context.documentEpoch) throw new BrowserWorkerError('STALE_BROWSER_REF', 'Browser reference belongs to an old document')
    const ref = context.refs.get(action.ref)
    if (!ref) throw new BrowserWorkerError('STALE_BROWSER_REF', 'Browser reference is unavailable')
    if (action.action === 'scrollIntoView') await ref.locator.scrollIntoViewIfNeeded({ timeout: 5_000 })
    else {
      if (!ref.href || ref.role !== 'link') throw new BrowserWorkerError('REF_NOT_LINK', 'Browser reference is not a link')
      if (++context.navigations > limits.maximumNavigations) throw new BrowserWorkerError('NAVIGATION_BUDGET_EXCEEDED', 'Browser navigation budget is exhausted', 429)
      const target = parseCanonicalBrowserTarget(new URL(ref.href, context.page.url()).toString())
      await assertPublicBrowserTarget(target.canonicalUrl)
      context.allowedUrls = this.#attested(action.attestedUrls)
      if (!context.allowedUrls.has(target.canonicalUrl)) throw new BrowserWorkerError('TARGET_NOT_ATTESTED', 'Browser target is not attested', 403)
      await context.page.goto(target.canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    }
    return { kind: 'acted', observation: await this.#observe(context) }
  }

  async #observe(context: WorkerContext): Promise<BrowserObservation> {
    context.refs.clear()
    const refs: BrowserObservation['refs'][number][] = []
    const groups = [
      { selector: 'a[href]', role: 'link', hasHref: true },
      { selector: 'button, [role="button"]', role: 'button', hasHref: false },
      { selector: 'h1, h2, h3', role: 'heading', hasHref: false }
    ] as const
    for (const group of groups) {
      const candidates = context.page.locator(group.selector)
      const count = Math.min(await candidates.count(), MAX_REFS - refs.length)
      for (let index = 0; index < count; index++) {
        const locator = candidates.nth(index)
        if (!await locator.isVisible().catch(() => false)) continue
        const name = bounded((await locator.innerText().catch(() => '')).trim(), 512)
        const href = group.hasHref ? await locator.getAttribute('href') : null
        const ref = `e${refs.length + 1}`
        context.refs.set(ref, { locator, href, role: group.role, name })
        refs.push({ ref, role: group.role, name, href: href ? new URL(href, context.page.url()).toString() : null })
      }
    }
    return { contextId: [...this.#contexts].find(([, value]) => value === context)?.[0] ?? '', documentEpoch: context.documentEpoch, url: context.page.url(), title: bounded(await context.page.title(), 512), text: bounded(await context.page.locator('body').innerText({ timeout: 5_000 })), refs, observedAt: new Date().toISOString() }
  }

  async #closeContext(id: string, context: WorkerContext): Promise<void> { this.#contexts.delete(id); await context.browserContext.close() }
  async shutdown(): Promise<void> { await Promise.all([...this.#contexts].map(([id, context]) => this.#closeContext(id, context))); await this.#browser?.close(); this.#browser = null }
}
