import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { WikiQnaComparisonDriver } from './wiki-qna-comparison.ts'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid application accounting')
  return value
}

/** Normal application API only; credentials stay in an operator-owned private file. */
export const driver: WikiQnaComparisonDriver = {
  async prepare(corpus) {
    const authPath = process.env.WIKI_QNA_API_AUTH_FILE
    if (!authPath) throw new Error('WIKI_QNA_API_AUTH_FILE is required')
    const auth = object(JSON.parse(await readFile(authPath, 'utf8')))
    if (typeof auth.baseUrl !== 'string' || typeof auth.cookie !== 'string' || typeof auth.csrf !== 'string') throw new Error('Invalid protected API credentials')
    const base = new URL(auth.baseUrl)
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid application origin')
    let cookie = auth.cookie
    const request = async (path: string, method = 'GET', body?: unknown): Promise<Response> => {
      const response = await fetch(new URL(path, base), {
        method, headers: { accept: 'application/json', 'content-type': 'application/json', cookie, 'x-wiki-csrf': String(auth.csrf), origin: base.origin, referer: `${base.origin}/`, 'sec-fetch-site': 'same-origin' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(240_000)
      })
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';', 1)[0]!
        const name = pair.slice(0, pair.indexOf('='))
        cookie = [...cookie.split(';').map(value => value.trim()).filter(value => !value.startsWith(`${name}=`)), pair].join('; ')
      }
      if (!response.ok) {
        const failure = object(await response.json().catch(() => ({})))
        await writeFile(`${authPath}.last-http-error.json`, JSON.stringify({ method, path, status: response.status, code: failure.code, error: failure.error, message: failure.message }), { mode: 0o600 })
        throw new Error(`Application request failed (${response.status})`)
      }
      return response
    }
    const json = async (path: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> => object(await (await request(path, method, body)).json())
    const pages: { key: string; id: number; sourceRevision: string; bodySha256: string }[] = []
    const pageMetadata = new Map<number, Record<string, unknown>>()
    const sessions = new Map<string, string>()
    const receipts = new Map<string, Map<string, { id: number; sourceRevision: string; bodySha256: string; bodyBytes: number; receiptActionCallId: string }>>()
    const activeRuns = new Set<string>()
    const manifestPath = `${authPath}.owned-pages.json`
    const checkpoint = async () => writeFile(manifestPath, JSON.stringify({ pages, sessionIds: [...sessions.values()], activeRunIds: [...activeRuns] }), { mode: 0o600 })
    const close = async (): Promise<void> => {
      // Terminal SSE closes before run returns. A transport interruption requires explicit cancellation, not another inference.
      for (const id of activeRuns) await json(`/_api/agents/runs/${id}/cancel`, 'POST', {})
      if (activeRuns.size) throw new Error('Interrupted owned runs require a confirmed drain before page cleanup')
      for (const page of [...pages].reverse()) await json(`/_api/pages/${page.id}`, 'DELETE', { expectedSourceRevision: page.sourceRevision })
      pages.length = 0
      // Keep temporary run/session receipts and paid ledgers under normal retention.
      await checkpoint()
    }
    try {
      for (const page of corpus.pages) {
        const response = await json('/_api/pages', 'POST', {
          content: page.body, description: 'Owned fictional QnA efficiency benchmark; non-operative.', editor: 'markdown',
          isPublished: true, isSearchable: true, locale: page.locale, path: page.path, title: page.title,
          tags: ['agent-benchmark-fictional'], visibility: 'private'
        })
        const created = object(response.page)
        const id = count(created.id)
        if (!id || typeof created.sourceRevision !== 'string') throw new Error('Invalid created fixture identity')
        pages.push({ key: page.key, id, sourceRevision: created.sourceRevision, bodySha256: page.bodySha256 })
        pageMetadata.set(id, { id, locale: page.locale, path: page.path, title: page.title, visibility: 'private', sourceRevision: created.sourceRevision })
        await checkpoint()
      }
    } catch (error) {
      await close()
      throw error
    }
    return {
      pages,
      close,
      async run(input) {
        let sessionId = sessions.get(input.sessionKey)
        if (!sessionId) {
          const created = await json('/_api/agents/sessions', 'POST', { retention: 'temporary' })
          const session = object(created.session)
          if (typeof session.id !== 'string') throw new Error('Invalid session identity')
          sessionId = session.id
          sessions.set(input.sessionKey, sessionId)
          receipts.set(sessionId, new Map())
          await checkpoint()
        }
        const rankedSources: { id: number; sourceRevision: string; rank: number }[] = []
        const sources: Record<string, unknown>[] = []
        if (input.mode === 'ranked-source-selection') {
          const search = await json(`/_api/pages/search?${new URLSearchParams({ query: input.retrievalQuery, locale: 'en', paginated: 'true' })}`)
          if (!Array.isArray(search.results)) throw new Error('Invalid ranked search result')
          const ranked = search.results.slice(0, input.topK)
          for (const [rank, value] of ranked.entries()) {
            const row = object(value)
            const id = Number(row.id)
            const metadata = pageMetadata.get(id)
            if (!metadata) return { runId: '', status: 'not-admitted-non-owned-topk', rankedSources,
              accounting: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0, unknownExposureTokens: 0, unknownExposureCostMicros: 0 } }
            sources.push(metadata)
            rankedSources.push({ id, sourceRevision: String(metadata.sourceRevision), rank })
          }
        }
        const thread = await json(`/_api/agents/sessions/${sessionId}`)
        const session = object(thread.session)
        const admitted = await json(`/_api/agents/sessions/${sessionId}/messages`, 'POST', {
          clientRequestId: randomUUID(), expectedSessionVersion: session.version, profileResolutionToken: session.profileResolutionToken,
          content: input.userRequest, invokedSkillVersionIds: [], knowledgeContext: { scope: { kind: 'all' }, sources }
        })
        const run = object(admitted.run)
        if (typeof run.id !== 'string') throw new Error('Invalid admitted run identity')
        activeRuns.add(run.id)
        await checkpoint()
        const response = await request(`/_api/agents/runs/${run.id}/events?after=0`)
        const raw = await response.text()
        let terminal: { type: string; data: Record<string, unknown> } | undefined
        let usage: Record<string, unknown> | undefined
        const provenReceiptIds = new Set<string>()
        const sessionReceipts = receipts.get(sessionId)!
        for (const block of raw.split(/\r?\n\r?\n/u)) {
          const lines = block.split(/\r?\n/u)
          const type = lines.find(line => line.startsWith('event: '))?.slice(7)
          const line = lines.find(line => line.startsWith('data: '))
          if (!type || !line) continue
          const data = object(object(JSON.parse(line.slice(6))).data)
          input.onEvent(type, data)
          if (type === 'usage.updated') usage = data
          if (type === 'tool.completed' && data.actionName === 'pages.get' && typeof data.result === 'string' && typeof data.actionCallId === 'string') {
            const page = object(JSON.parse(data.result))
            const binding = pages.find(binding => binding.id === page.id)
            const fixture = binding && corpus.pages.find(page => page.key === binding.key)
            if (binding && fixture && typeof page.content === 'string' && page.sourceRevision === binding.sourceRevision && hash(page.content) === fixture.bodySha256 && data.contextExclusion === undefined && page.contentTruncated !== true) {
              const receiptActionCallId = typeof data.reusedActionCallId === 'string' ? data.reusedActionCallId : data.actionCallId
              sessionReceipts.set(receiptActionCallId, { id: binding.id, sourceRevision: binding.sourceRevision, bodySha256: fixture.bodySha256, bodyBytes: fixture.bodyBytes, receiptActionCallId })
            }
          }
          if (type === 'evidence.provenance' && data.accepted === true && Array.isArray(data.claims)) {
            for (const claim of data.claims) for (const receipt of Array.isArray(object(claim).readReceipts) ? object(claim).readReceipts as unknown[] : []) {
              const id = object(receipt).actionCallId
              if (typeof id === 'string') provenReceiptIds.add(id)
            }
            for (const retrieval of Array.isArray(data.retrievals) ? data.retrievals : []) {
              const record = object(retrieval)
              const receipt = typeof record.actionCallId === 'string' ? sessionReceipts.get(record.actionCallId) : undefined
              if (receipt && Array.isArray(record.evidenceIds) && record.evidenceIds.includes(`page:${receipt.id}:revision:${receipt.sourceRevision}`))
                provenReceiptIds.add(receipt.receiptActionCallId)
            }
          }
          if (['run.completed', 'run.partial', 'run.failed', 'run.cancelled', 'run.recovery_required'].includes(type)) terminal = { type, data }
        }
        if (!terminal || !usage) throw new Error('Application did not return a terminal accounting event')
        activeRuns.delete(run.id)
        await checkpoint()
        const final = await json(`/_api/agents/sessions/${sessionId}`)
        const messages = Array.isArray(final.messages) ? final.messages.map(object) : []
        const assistant = messages.find(message => message.runId === run.id && message.role === 'assistant')
        if (assistant && typeof assistant.content === 'string') input.onPublishedText(assistant.content)
        const exposure = object(terminal.data.unsettledExposure)
        return {
          runId: run.id, status: terminal.type.slice(4), rankedSources,
          retainedReads: [...provenReceiptIds].flatMap(id => sessionReceipts.has(id) ? [sessionReceipts.get(id)!] : []),
          accounting: { inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens), totalTokens: count(usage.totalTokens), costMicros: count(usage.costMicros),
            unknownExposureTokens: exposure.tokens === undefined ? 0 : count(exposure.tokens), unknownExposureCostMicros: exposure.costMicros === undefined ? 0 : count(exposure.costMicros) }
        }
      }
    }
  }
}
