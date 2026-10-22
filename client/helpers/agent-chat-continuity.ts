import { z } from 'zod'

export const AgentSessionIdSchema = z.uuid()
export const isAgentSessionId = (value: unknown): value is string => AgentSessionIdSchema.safeParse(value).success
export const AGENT_CHAT_RECENT_STORAGE_KEY = 'agents.chat-recent.v1'
// A working day of closed-chat continuity, not an authorization or live-UI
// timeout. Reopening still reads current owner/session authority from the server.
export const AGENT_CHAT_RECENT_MAX_AGE = 8 * 60 * 60_000
const PageSelector = z.strictObject({ id: z.number().int().positive(), locale: z.string().min(1).max(35) })
const ContextSelector = z.strictObject({
  includeCurrentPage: z.boolean(),
  sources: z
    .array(PageSelector)
    .max(8)
    .refine(sources => new Set(sources.map(source => `${source.id}:${source.locale}`)).size === sources.length)
})
const RecentSchema = z.strictObject({
  version: z.literal(1),
  ownerId: z.number().int().positive(),
  sessionId: AgentSessionIdSchema,
  closedAt: z.number().int().nonnegative(),
  context: ContextSelector.optional()
})
export type AgentChatPageSelector = z.infer<typeof PageSelector>
export type AgentChatContextSelector = z.infer<typeof ContextSelector>
export type AgentChatRecent = z.infer<typeof RecentSchema>
let inMemoryRecent: AgentChatRecent | null = null
let storagePending = false
export const sameAgentChatPage = (left: AgentChatPageSelector | null | undefined, right: AgentChatPageSelector | null | undefined): boolean =>
  left == null || right == null ? left == null && right == null : left.id === right.id && left.locale === right.locale
const discardLegacySelector = (): void => {
  try {
    window.sessionStorage.removeItem('agents.chat-pin.v1')
  } catch {
    /* Storage-denied tabs still use owner-scoped memory continuity. */
  }
}
export const clearAgentChatRecent = (): void => {
  inMemoryRecent = null
  discardLegacySelector()
  try {
    window.sessionStorage.removeItem(AGENT_CHAT_RECENT_STORAGE_KEY)
    storagePending = false
  } catch {
    /* Memory-only continuity remains cleared. */
    storagePending = true
  }
}
export const writeAgentChatRecent = (ownerId: number, sessionId: string, closedAt: number, context?: AgentChatContextSelector): void => {
  discardLegacySelector()
  const parsed = RecentSchema.safeParse({ version: 1, ownerId, sessionId, closedAt, ...(context ? { context } : {}) })
  if (!parsed.success) {
    clearAgentChatRecent()
    return
  }
  inMemoryRecent = parsed.data
  try {
    window.sessionStorage.setItem(AGENT_CHAT_RECENT_STORAGE_KEY, JSON.stringify(parsed.data))
    storagePending = false
  } catch {
    /* This mounted app can still resume without storage. */
    storagePending = true
  }
}
export const readAgentChatRecent = (ownerId: number, now = Date.now()): AgentChatRecent | null => {
  discardLegacySelector()
  let recent = inMemoryRecent
  try {
    const storage = window.sessionStorage
    if (storagePending) {
      if (inMemoryRecent) storage.setItem(AGENT_CHAT_RECENT_STORAGE_KEY, JSON.stringify(inMemoryRecent))
      else storage.removeItem(AGENT_CHAT_RECENT_STORAGE_KEY)
      storagePending = false
    }
    const raw = storage.getItem(AGENT_CHAT_RECENT_STORAGE_KEY)
    let value: unknown = null
    try { value = raw && raw.length <= 4096 ? JSON.parse(raw) : null } catch { /* Malformed storage is discarded, never restored from memory. */ }
    const parsed = RecentSchema.safeParse(value)
    recent = parsed.success ? parsed.data : null
  } catch {
    /* The in-memory owner-scoped selector is the only fallback. */
  }
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !recent || recent.ownerId !== ownerId || recent.closedAt > now || now - recent.closedAt >= AGENT_CHAT_RECENT_MAX_AGE) {
    clearAgentChatRecent()
    return null
  }
  inMemoryRecent = recent
  return recent
}
