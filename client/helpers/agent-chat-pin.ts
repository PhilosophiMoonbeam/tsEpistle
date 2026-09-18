import { z } from 'zod'

export const AgentSessionIdSchema = z.uuid()
export const isAgentSessionId = (value: unknown): value is string => AgentSessionIdSchema.safeParse(value).success
export const AGENT_CHAT_PIN_STORAGE_KEY = 'agents.chat-pin.v1'
export const AGENT_CHAT_RECENT_STORAGE_KEY = 'agents.chat-recent.v1'
export const AGENT_CHAT_PIN_VERSION = 1 as const
export const AGENT_CHAT_RECENT_MAX_AGE = 15 * 60_000
const PageSelector = z.strictObject({ id: z.number().int().positive(), locale: z.string().min(1).max(35) })
const ContextSelector = z.strictObject({
  page: PageSelector.nullable(),
  includeCurrentPage: z.boolean(),
  sources: z
    .array(PageSelector)
    .max(8)
    .refine(sources => new Set(sources.map(source => `${source.id}:${source.locale}`)).size === sources.length)
})
const PinSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.number().int().positive(),
  sessionId: AgentSessionIdSchema,
  context: ContextSelector.optional()
})
const RecentSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.number().int().positive(),
  sessionId: AgentSessionIdSchema,
  page: PageSelector.nullable(),
  closedAt: z.number().int().nonnegative()
})
export type AgentChatPageSelector = z.infer<typeof PageSelector>
export type AgentChatContextSelector = z.infer<typeof ContextSelector>
export type AgentChatPin = z.infer<typeof PinSchema>
export type AgentChatRecent = z.infer<typeof RecentSchema>
export interface AgentChatPinReadResult {
  readonly sessionId: string | null
  readonly available: boolean
  readonly context?: AgentChatContextSelector
}
let inMemoryPin: AgentChatPin | null = null
let inMemoryRecent: AgentChatRecent | null = null
const validOwnerId = (ownerId: number): boolean => Number.isSafeInteger(ownerId) && ownerId > 0
export const sameAgentChatPage = (left: AgentChatPageSelector | null | undefined, right: AgentChatPageSelector | null | undefined): boolean =>
  left == null || right == null ? left == null && right == null : left.id === right.id && left.locale === right.locale
export const agentChatPageSelector = (page: { readonly id: number; readonly locale: string } | null | undefined): AgentChatPageSelector | null =>
  page ? { id: page.id, locale: page.locale } : null
const discardStoredPin = (storage: Storage): boolean => {
  try {
    storage.removeItem(AGENT_CHAT_PIN_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
export const readAgentChatPin = (ownerId: number): AgentChatPinReadResult => {
  if (!validOwnerId(ownerId)) return { sessionId: null, available: false }
  try {
    const storage = window.sessionStorage
    const raw = storage.getItem(AGENT_CHAT_PIN_STORAGE_KEY)
    if (raw === null) {
      inMemoryPin = null
      return { sessionId: null, available: true }
    }
    let parsed: ReturnType<typeof PinSchema.safeParse>
    try {
      parsed = PinSchema.safeParse(raw.length <= 4096 ? JSON.parse(raw) : null)
    } catch {
      parsed = PinSchema.safeParse(null)
    }
    if (!parsed.success || parsed.data.ownerId !== ownerId) {
      inMemoryPin = null
      return { sessionId: null, available: discardStoredPin(storage) }
    }
    inMemoryPin = parsed.data
    return { sessionId: parsed.data.sessionId, available: true, ...(parsed.data.context ? { context: parsed.data.context } : {}) }
  } catch {
    const pin = inMemoryPin?.ownerId === ownerId ? inMemoryPin : null
    return { sessionId: pin?.sessionId ?? null, available: false, ...(pin?.context ? { context: pin.context } : {}) }
  }
}
export const writeAgentChatPin = (ownerId: number, sessionId: string, context?: AgentChatContextSelector): boolean => {
  const parsed = PinSchema.safeParse({ version: AGENT_CHAT_PIN_VERSION, ownerId, sessionId, ...(context ? { context } : {}) })
  if (!parsed.success) return false
  inMemoryPin = parsed.data
  try {
    window.sessionStorage.setItem(AGENT_CHAT_PIN_STORAGE_KEY, JSON.stringify(parsed.data))
    return true
  } catch {
    return false
  }
}
export const clearAgentChatRecent = (): void => {
  inMemoryRecent = null
  try {
    window.sessionStorage.removeItem(AGENT_CHAT_RECENT_STORAGE_KEY)
  } catch {
    /* Memory-only continuity remains cleared. */
  }
}
export const writeAgentChatRecent = (ownerId: number, sessionId: string, page: AgentChatPageSelector | null, closedAt: number): void => {
  const parsed = RecentSchema.safeParse({ version: 1, ownerId, sessionId, page, closedAt })
  if (!parsed.success) {
    clearAgentChatRecent()
    return
  }
  inMemoryRecent = parsed.data
  try {
    window.sessionStorage.setItem(AGENT_CHAT_RECENT_STORAGE_KEY, JSON.stringify(parsed.data))
  } catch {
    /* This mounted app can still resume without storage. */
  }
}
export const readAgentChatRecent = (ownerId: number, page: AgentChatPageSelector | null, now = Date.now()): AgentChatRecent | null => {
  let recent = inMemoryRecent
  try {
    const raw = window.sessionStorage.getItem(AGENT_CHAT_RECENT_STORAGE_KEY)
    let value: unknown = null
    try { value = raw && raw.length <= 4096 ? JSON.parse(raw) : null } catch { /* Malformed storage is discarded, never restored from memory. */ }
    const parsed = RecentSchema.safeParse(value)
    recent = parsed.success ? parsed.data : null
  } catch {
    /* The in-memory owner-scoped selector is the only fallback. */
  }
  if (
    !recent ||
    recent.ownerId !== ownerId ||
    !sameAgentChatPage(recent.page, page) ||
    recent.closedAt > now ||
    now - recent.closedAt >= AGENT_CHAT_RECENT_MAX_AGE
  ) {
    clearAgentChatRecent()
    return null
  }
  inMemoryRecent = recent
  return recent
}
export const clearAgentChatPin = (): boolean => {
  inMemoryPin = null
  clearAgentChatRecent()
  try {
    window.sessionStorage.removeItem(AGENT_CHAT_PIN_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
