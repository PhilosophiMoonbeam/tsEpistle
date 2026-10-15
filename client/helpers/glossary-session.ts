export interface GlossarySessionIdentity {
  user: { id: number; authenticated: boolean; authVersion: number; iat: number; permissions: readonly string[] }
  authRefreshPending: boolean
  authRefreshOutcome: string | null
  offlineIdentityEpoch: number
}

/** Ephemeral request lifetime, never a persisted catalog or account cache key. */
export function glossaryIdentity(store: GlossarySessionIdentity): string {
  return JSON.stringify([
    store.user.id,
    store.user.authenticated,
    store.user.authVersion,
    store.user.iat,
    store.user.permissions,
    store.authRefreshPending,
    store.authRefreshOutcome,
    store.offlineIdentityEpoch
  ])
}
