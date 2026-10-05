import { createHmac } from 'node:crypto'
import { createPinia, disposePinia, getActivePinia, type Pinia, setActivePinia } from 'pinia'
import type { AgentDraft } from '../../../client/helpers/agent-draft.ts'
import { useAgentsStore } from '../../../client/store/agents.ts'
import type { AgentGoalView, AgentRunView, AgentThreadState, CreateAgentGoalRequest, SubmitAgentMessageRequest } from '../../../shared/agents/contracts.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222'
const PROFILE = '33333333-3333-4333-8333-333333333333'
const OTHER_PROFILE = '44444444-4444-4444-8444-444444444444'
const REVISION = '55555555-5555-4555-8555-555555555555'
const OTHER_REVISION = '66666666-6666-4666-8666-666666666666'
const RUN = '99999999-9999-4999-8999-999999999999'
const GOAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DATE = '2026-01-01T00:00:00.000Z'

type Pins = {
  v: number
  ownerId: number
  sessionId: string
  sessionVersion: number
  profileId: string
  profileVersionId: string
  profileVersion: number
  profilePolicyVersion: number
  defaultGeneration: number
  executionMode: string
}
const pins = (overrides: Partial<Pins> = {}): Pins => ({
  v: 1,
  ownerId: 1,
  sessionId: SESSION,
  sessionVersion: 4,
  profileId: PROFILE,
  profileVersionId: REVISION,
  profileVersion: 2,
  profilePolicyVersion: 3,
  defaultGeneration: 8,
  executionMode: 'agent',
  ...overrides
})
// These keys are fixture-only. Real signature verification stays on the server;
// the store must use the issued token unchanged, not mint an admission itself.
const key = (kid: string): string => `client-admission-test-key-${kid}`
const token = (value: Pins, exp = 4_000_000_000, kid = 'renewed'): string => {
  const encoded = Buffer.from(JSON.stringify({ ...value, exp, kid })).toString('base64url')
  return `${kid}.${encoded}.${createHmac('sha256', key(kid)).update(encoded).digest('base64url')}`
}
const run = (sessionId = SESSION, active = false): AgentRunView => ({
  id: RUN,
  sessionId,
  status: active ? 'running' : 'succeeded',
  attempt: 1,
  eventSequence: 0,
  canCancel: active,
  createdAt: DATE,
  startedAt: DATE,
  completedAt: active ? null : DATE,
  errorCode: null,
  errorMessage: null
})
const goal = (sessionId = SESSION, status: AgentGoalView['status'] = 'completed'): AgentGoalView => ({
  id: GOAL,
  sessionId,
  objective: 'Accepted objective',
  status,
  version: 1,
  currentRunId: null,
  continuationCount: 0,
  maxContinuations: 5,
  consumedTokens: 0,
  maxTokens: 100_000,
  consumedToolCalls: 0,
  maxToolCalls: 100,
  budgetPolicyVersion: 1,
  budgetSelection: 'utility',
  tokenTier: 'standard',
  tokenAllowance: 100_000,
  budgetCycle: 0,
  budgetLimitReason: null,
  canRenewTokenBudget: false,
  startedAt: DATE,
  deadlineAt: '2026-01-02T00:00:00.000Z',
  completedAt: status === 'completed' ? DATE : null,
  errorCode: null,
  errorMessage: null,
  completion: null
})
const thread = (value = pins(), exp = 4_000_000_000): AgentThreadState => ({
  session: {
    id: value.sessionId,
    title: 'Quantum',
    retention: 'saved',
    folderId: null,
    status: 'active',
    executionMode: 'agent',
    version: value.sessionVersion,
    providerProfileId: null,
    profileResolutionToken: token(value, exp),
    skills: [],
    currentRun: null,
    createdAt: DATE,
    updatedAt: DATE,
    lastActivityAt: DATE,
    expiresAt: null
  },
  messages: [],
  tools: [],
  tasks: [],
  goal: null,
  proposals: [],
  artifacts: [],
  suggestions: [],
  routingDecisions: [],
  specialistInvocations: [],
  historyWindow: { messageLimit: 50, hasOlderMessages: false, runLimit: 20, hasOlderRuns: false }
})
const json = (value: unknown, status = 200): Response => Response.json(value, { status })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => {
    resolve = accept
  })
  return { promise, resolve }
}

type Submission = SubmitAgentMessageRequest | CreateAgentGoalRequest
interface HeldRead {
  started: Promise<void>
  response: Promise<Response>
  notify: () => void
  release: (value?: Response) => void
}
class AdmissionServer {
  ownerId = 1
  admissionPins = pins()
  current = thread()
  attempts: { mode: 'message' | 'goal'; body: Submission }[] = []
  accepted: { mode: 'message' | 'goal'; body: Submission }[] = []
  readStatus = 200
  postStatus = 200
  private nextRead: HeldRead | null = null
  private heldReads: HeldRead[] = []

  holdNextRead() {
    const started = deferred<void>()
    const response = deferred<Response>()
    const held: HeldRead = {
      started: started.promise,
      notify: () => started.resolve(undefined),
      release: (value = json(this.current)) => response.resolve(value),
      response: response.promise
    }
    this.nextRead = held
    this.heldReads.push(held)
    return held
  }
  releaseAll() {
    for (const held of this.heldReads) held.release()
  }
  readonly fetch: typeof fetch = async (input, init = {}) => {
    const path = new URL(String(input), 'https://wiki.example.test').pathname
    const method = init.method ?? 'GET'
    if (init.credentials !== 'same-origin') return json({ message: 'Authentication required' }, 401)
    if (method === 'GET') {
      if (path === '/_api/agents/sessions') return json({ sessions: [], nextCursor: null })
      if (path === '/_api/agents/conversation-folders') return json({ folders: [] })
      if (path === '/_api/agents/profiles') return json({ profiles: [] })
      if (path === '/_api/agents/skills') return json({ skills: [] })
      if (path.startsWith('/_api/agents/sessions/')) {
        if (this.nextRead) {
          const held = this.nextRead
          this.nextRead = null
          held.notify()
          // Deliberately settle even if aborted: cancellation alone must not be
          // the authorization/ownership fence for a delayed response.
          return held.response
        }
        return this.readStatus === 200 ? json(this.current) : json({ message: 'Read unavailable' }, this.readStatus)
      }
    }
    if (method === 'POST' && /\/(messages|goals)$/.test(path)) {
      const body = JSON.parse(String(init.body)) as Submission
      const mode = path.endsWith('/goals') ? 'goal' : 'message'
      this.attempts.push({ mode, body })
      if (new Headers(init.headers).get('x-wiki-csrf') !== 'test-csrf') return json({ message: 'CSRF required' }, 403)
      if (!this.admits(body)) return json({ message: 'Profile resolution token is stale' }, 409)
      if (this.postStatus !== 200) return json({ message: 'Admission rejected' }, this.postStatus)
      this.accepted.push({ mode, body })
      const acceptedRun = run(this.current.session.id)
      this.current = {
        ...this.current,
        session: { ...this.current.session, currentRun: acceptedRun },
        goal: mode === 'goal' ? goal(this.current.session.id) : null
      }
      return json({ run: acceptedRun, goal: this.current.goal, replayed: false })
    }
    throw new Error(`Unexpected endpoint: ${method} ${path}`)
  }
  private admits(body: Submission): boolean {
    try {
      const [kid, encoded, signature] = body.profileResolutionToken.split('.')
      if (!kid || !encoded || signature !== createHmac('sha256', key(kid)).update(encoded).digest('base64url')) return false
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as Pins & { exp: number }
      if (value.exp <= Math.floor(Date.now() / 1000) || value.ownerId !== this.ownerId || body.expectedSessionVersion !== this.current.session.version)
        return false
      const fields = [
        'v',
        'ownerId',
        'sessionId',
        'sessionVersion',
        'profileId',
        'profileVersionId',
        'profileVersion',
        'profilePolicyVersion',
        'defaultGeneration',
        'executionMode'
      ] as const
      return fields.every(field => value[field] === this.admissionPins[field])
    } catch {
      return false
    }
  }
}

const descriptors = new Map<string, PropertyDescriptor | undefined>()
const installGlobal = (name: string, value: unknown) => {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
class TestEventSource extends EventTarget {
  closed = false
  constructor(readonly url: string) {
    super()
  }
  close() {
    this.closed = true
  }
}
let server: AdmissionServer
let pinia: Pinia
let previousPinia: Pinia | undefined
let visibility: 'visible' | 'hidden'
const initialize = (ownerId = 1, sessionId = SESSION) =>
  useAgentsStore(pinia).initialize('test-csrf', { ownerId, resumeSessionId: sessionId, routeSync: false, allowCreate: false })
const waitForAdmission = async (held: HeldRead, sending: Promise<boolean>) => {
  await Promise.race([
    held.started,
    sending.then(() => {
      throw new Error('Send settled before the required admission read')
    })
  ])
}

beforeEach(() => {
  server = new AdmissionServer()
  const storage = new Map<string, string>()
  const documentEvents = new EventTarget()
  visibility = 'visible'
  installGlobal('document', {
    get visibilityState() {
      return visibility
    },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents)
  })
  installGlobal('window', {
    fetch: server.fetch,
    atob: globalThis.atob,
    location: { pathname: '/', origin: 'https://wiki.example.test' },
    sessionStorage: {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => {
        storage.set(name, value)
      },
      removeItem: (name: string) => {
        storage.delete(name)
      }
    },
    clearTimeout: globalThis.clearTimeout,
    setTimeout: globalThis.setTimeout
  })
  installGlobal('EventSource', TestEventSource)
  previousPinia = getActivePinia()
  pinia = createPinia()
  setActivePinia(pinia)
})
afterEach(() => {
  useAgentsStore(pinia).destroyWorkspace()
  server.releaseAll()
  disposePinia(pinia)
  setActivePinia(previousPinia)
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  descriptors.clear()
})

describe('Wiki Agent fresh admission through the public store', () => {
  it.each(['message', 'goal'] as const)('renews an expired token once and preserves a newer unsent draft during %s admission', async mode => {
    const store = useAgentsStore(pinia)
    server.current = thread(pins(), 1)
    expect(await initialize()).toBe(true)
    store.updateDraft(SESSION, { text: '  Explain quantum uncertainty  ', mode })
    server.current = thread()
    const held = server.holdNextRead()
    const sending = store.send(store.drafts[SESSION]!.text, [], mode)
    await waitForAdmission(held, sending)
    expect(server.attempts).toEqual([])
    expect(await store.send('Duplicate click')).toBe(false)
    store.updateDraft(SESSION, { text: 'New unsent question', mode: 'message', sources: [], scope: { kind: 'all' } })
    held.release()
    expect(await sending).toBe(true)
    expect(server.attempts).toHaveLength(1)
    expect(server.accepted).toHaveLength(1)
    expect(store.drafts[SESSION]!.text).toBe('New unsent question')
    expect(store.sending).toBe(false)
    expect(store.sessionMutationBusy).toBe(false)
  })

  it('accepts signing-key renewal without changing intent', async () => {
    const store = useAgentsStore(pinia)
    server.current = { ...thread(), session: { ...thread().session, profileResolutionToken: token(pins(), 1, 'old') } }
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Follow up')
    server.current = thread()
    expect(await store.send('Follow up')).toBe(true)
    expect(server.accepted).toHaveLength(1)
    expect(store.drafts[SESSION]!.text).toBe('')
  })

  const changes: [string, Partial<Pins>, Partial<AgentThreadState['session']>][] = [
    ['implicit default profile', { profileId: OTHER_PROFILE, defaultGeneration: 9 }, {}],
    ['immutable revision identifier', { profileVersionId: OTHER_REVISION }, {}],
    ['immutable revision number', { profileVersion: 3 }, {}],
    ['profile policy', { profilePolicyVersion: 4 }, {}],
    ['default generation with unchanged resolved profile', { defaultGeneration: 9 }, {}],
    ['session revision', { sessionVersion: 5 }, {}],
    ['selected public profile with unchanged resolution', {}, { providerProfileId: PROFILE }]
  ]
  it.each(changes)('retains fresh state and draft for explicit review after %s changes', async (_name, change, publicChange) => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.updateDraft(SESSION, { text: 'Do not silently rebase this goal', mode: 'goal' })
    const draft = JSON.parse(JSON.stringify(store.drafts[SESSION])) as AgentDraft
    server.admissionPins = pins(change)
    const fresh = thread(server.admissionPins)
    server.current = { ...fresh, session: { ...fresh.session, ...publicChange } }
    expect(await store.send(draft!.text, draft!.skillVersionIds, 'goal')).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.drafts[SESSION]).toEqual(draft)
    // A second explicit click is review, not an automatic resubmission.
    expect(await store.send(draft!.text, draft!.skillVersionIds, 'goal')).toBe(true)
    expect(server.accepted).toHaveLength(1)
  })

  it.each([
    ['unsupported version', token(pins({ v: 2 }))],
    ['malformed payload', 'renewed.not-json.signature'],
    ['missing revision pin', token({ ...pins(), profileVersionId: undefined } as unknown as Pins)],
    ['incompatible execution mode', token(pins({ executionMode: 'generation-only' }))]
  ] as const)('fails closed for %s even when cached and fresh tokens match', async (_name, invalidToken) => {
    const store = useAgentsStore(pinia)
    server.current = { ...thread(), session: { ...thread().session, profileResolutionToken: invalidToken } }
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Keep this question')
    expect(await store.send('Keep this question')).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.drafts[SESSION]!.text).toBe('Keep this question')
  })

  it.each([
    ['owner', pins({ ownerId: 2 })],
    ['session identifier', pins({ sessionId: OTHER_SESSION })],
    ['session revision', pins({ sessionVersion: 5 })]
  ] as const)('refuses a token whose %s disagrees with the authorized public session even if continuity pins match', async (_name, inconsistent) => {
    const store = useAgentsStore(pinia)
    server.current = { ...thread(), session: { ...thread().session, profileResolutionToken: token(inconsistent) } }
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Keep private intent')
    expect(await store.send('Keep private intent')).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.drafts[SESSION]!.text).toBe('Keep private intent')
  })

  it.each([503, 401])('never falls back to cached admission after an authenticated GET fails with %s', async status => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Not sent')
    server.readStatus = status
    expect(await store.send('Not sent')).toBe(false)
    expect(server.attempts).toEqual([])
    if (status === 401) {
      expect(store.thread).toBeNull()
      expect(store.pinOwnerId).toBeNull()
      expect(store.drafts).toEqual({})
    } else {
      expect(store.drafts[SESSION]!.text).toBe('Not sent')
      expect(store.networkPaused).toBe(true)
    }
  })

  it('does not dispatch when the admission read is skipped in a hidden document', async () => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Wait until visible')
    visibility = 'hidden'
    expect(await store.send('Wait until visible')).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.drafts[SESSION]!.text).toBe('Wait until visible')
  })

  it.each(['active', 'paused', 'blocked'] as const)('observes a newly %s goal rather than starting a conflicting message', async status => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Another question')
    server.current = { ...thread(), goal: goal(SESSION, status) }
    expect(await store.send('Another question')).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.thread!.goal!.status).toBe(status)
    expect(store.drafts[SESSION]!.text).toBe('Another question')
  })

  it('observes a run started by another actor during admission rather than creating a second run', async () => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Another question')
    server.current = { ...thread(), session: { ...thread().session, currentRun: run(SESSION, true) } }
    expect(await store.send('Another question')).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.drafts[SESSION]!.text).toBe('Another question')
  })

  it('does not refresh-and-repost a rejected POST; a later explicit submission gets a new admission', async () => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Explicit retry only')
    server.postStatus = 409
    expect(await store.send('Explicit retry only')).toBe(false)
    expect(server.attempts).toHaveLength(1)
    expect(server.accepted).toEqual([])
    expect(store.drafts[SESSION]!.text).toBe('Explicit retry only')
    server.postStatus = 200
    server.current = { ...thread(), session: { ...thread().session, profileResolutionToken: token(pins(), 4_000_000_001) } }
    expect(await store.send('Explicit retry only')).toBe(true)
    expect(server.attempts).toHaveLength(2)
    expect(server.accepted).toHaveLength(1)
  })

  it('does not post or overwrite a new owner after an old admission GET settles late', async () => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Owner one private question')
    const oldThread = json(server.current)
    const held = server.holdNextRead()
    const sending = store.send('Owner one private question')
    await waitForAdmission(held, sending)
    server.ownerId = 2
    server.admissionPins = pins({ ownerId: 2, sessionId: OTHER_SESSION })
    server.current = thread(server.admissionPins)
    expect(await initialize(2, OTHER_SESSION)).toBe(true)
    store.setDraft(OTHER_SESSION, 'Owner two private question')
    store.error = 'Owner two notice'
    held.release(oldThread)
    expect(await sending).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.pinOwnerId).toBe(2)
    expect(store.thread!.session.id).toBe(OTHER_SESSION)
    expect(store.drafts[SESSION]).toBeUndefined()
    expect(store.drafts[OTHER_SESSION]!.text).toBe('Owner two private question')
    expect(store.error).toBe('Owner two notice')
  })

  it('does not admit a closed workspace even when the delayed GET returns a valid token', async () => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Keep for reopen')
    const held = server.holdNextRead()
    const sending = store.send('Keep for reopen')
    await waitForAdmission(held, sending)
    store.closeWorkspace()
    held.release()
    expect(await sending).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.workspaceDisposed).toBe(true)
    expect(store.drafts[SESSION]!.text).toBe('Keep for reopen')
  })

  it('does not treat same-owner close/reopen as permission to initiate the old POST or release the newer send fence', async () => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Old clicked question')
    const oldRead = server.holdNextRead()
    const oldSend = store.send('Old clicked question')
    await waitForAdmission(oldRead, oldSend)
    store.closeWorkspace()
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'New explicit question')
    const newRead = server.holdNextRead()
    const newSend = store.send('New explicit question')
    await waitForAdmission(newRead, newSend)
    oldRead.release()
    expect(await oldSend).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.drafts[SESSION]!.text).toBe('New explicit question')
    expect(store.sending).toBe(true)
    expect(store.sessionMutationBusy).toBe(true)
    newRead.release()
    expect(await newSend).toBe(true)
    expect(server.accepted).toHaveLength(1)
    expect(server.accepted[0]!.body).toMatchObject({ content: 'New explicit question' })
  })

  it('does not post or replace newer authoritative state after its admission read is superseded', async () => {
    const store = useAgentsStore(pinia)
    expect(await initialize()).toBe(true)
    store.setDraft(SESSION, 'Review after revalidation')
    const oldResponse = json(server.current)
    const held = server.holdNextRead()
    const sending = store.send('Review after revalidation')
    await waitForAdmission(held, sending)
    server.admissionPins = pins({ sessionVersion: 5 })
    server.current = thread(server.admissionPins)
    expect(await store.refreshThread()).toMatchObject({ accepted: true, current: true })
    held.release(oldResponse)
    expect(await sending).toBe(false)
    expect(server.attempts).toEqual([])
    expect(store.thread!.session.version).toBe(5)
    expect(store.drafts[SESSION]!.text).toBe('Review after revalidation')
  })
})
