import { z } from 'zod'

export const AgentSessionIdSchema = z.uuid()
export const isAgentSessionId = (value: unknown): value is string => AgentSessionIdSchema.safeParse(value).success

export const AGENT_CHAT_PIN_STORAGE_KEY = 'agents.chat-pin.v1'
export const AGENT_CHAT_PIN_VERSION = 1 as const

export interface AgentChatPin {
  readonly version: typeof AGENT_CHAT_PIN_VERSION
  readonly ownerId: number
  readonly sessionId: string
}

export interface AgentChatPinReadResult {
  readonly sessionId: string | null
  readonly available: boolean
}

let inMemoryPin: AgentChatPin | null = null

const validOwnerId = (ownerId: number): boolean => Number.isSafeInteger(ownerId) && ownerId > 0
const validPin = (value: unknown): value is AgentChatPin => {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.version === AGENT_CHAT_PIN_VERSION &&
    validOwnerId(record.ownerId as number) &&
    isAgentSessionId(record.sessionId) &&
    Object.keys(record).every(key => key === 'version' || key === 'ownerId' || key === 'sessionId')
  )
}

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
    if (raw === null) return { sessionId: null, available: true }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (!validPin(parsed)) {
      inMemoryPin = null
      return { sessionId: null, available: discardStoredPin(storage) }
    }
    if (parsed.ownerId !== ownerId) {
      inMemoryPin = null
      return { sessionId: null, available: discardStoredPin(storage) }
    }
    inMemoryPin = parsed
    return { sessionId: parsed.sessionId, available: true }
  } catch {
    return { sessionId: inMemoryPin?.ownerId === ownerId ? inMemoryPin.sessionId : null, available: false }
  }
}

export const writeAgentChatPin = (ownerId: number, sessionId: string): boolean => {
  if (!validOwnerId(ownerId) || !isAgentSessionId(sessionId)) return false
  const pin: AgentChatPin = { version: AGENT_CHAT_PIN_VERSION, ownerId, sessionId }
  inMemoryPin = pin
  try {
    window.sessionStorage.setItem(AGENT_CHAT_PIN_STORAGE_KEY, JSON.stringify(pin))
    return true
  } catch {
    return false
  }
}

export const clearAgentChatPin = (): boolean => {
  inMemoryPin = null
  try {
    window.sessionStorage.removeItem(AGENT_CHAT_PIN_STORAGE_KEY)
    return true
  } catch {
    return false
  }
}
