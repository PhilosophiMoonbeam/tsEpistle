interface OwnerWindow {
  readonly expiresAt: number
  requests: number
}

/** Process-local admission, shared by every personal key belonging to an owner. */
export class McpOwnerRateLimiter {
  private readonly owners = new Map<number, OwnerWindow>()
  private readonly limit: number
  private readonly windowMs: number
  private readonly maxOwners: number
  private readonly now: () => number

  constructor(limit = 60, windowMs = 60_000, maxOwners = 10_000, now: () => number = () => performance.now()) {
    if (![limit, windowMs, maxOwners].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('MCP admission limits must be positive safe integers')
    }
    this.limit = limit
    this.windowMs = windowMs
    this.maxOwners = maxOwners
    this.now = now
  }

  /** Zero admits the request; otherwise returns the truthful Retry-After in seconds. */
  consume(ownerUserId: number): number {
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) throw new Error('MCP admission requires a current owner')
    const now = this.now()
    let window = this.owners.get(ownerUserId)
    if (window && window.expiresAt <= now) {
      this.owners.delete(ownerUserId)
      window = undefined
    }
    if (!window) {
      // Insertion order is expiry order: windows have identical duration and
      // renewing one removes its old entry. Never evict an active owner's debt.
      for (const [owner, candidate] of this.owners) {
        if (candidate.expiresAt > now) break
        this.owners.delete(owner)
      }
      if (this.owners.size >= this.maxOwners) {
        const oldest = this.owners.values().next().value!
        return Math.max(1, Math.ceil((oldest.expiresAt - now) / 1_000))
      }
      window = { expiresAt: now + this.windowMs, requests: 0 }
      this.owners.set(ownerUserId, window)
    }
    if (window.requests >= this.limit) return Math.max(1, Math.ceil((window.expiresAt - now) / 1_000))
    window.requests++
    return 0
  }
}
