import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import type { TlsConfigurationEvent, TlsConfigurationWorkspace, TlsListenerSnapshot } from '../../shared/tls-workspace.ts'
import { requireSystemAuthority, type SystemRequester } from '../helpers/system-authority.ts'
import { describeTlsCertificate } from '../repositories/tls-material.ts'
import { publicTlsTarget } from '../repositories/tls-probe.ts'
import errors from './errors.ts'

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const SaveSchema = z
  .object({
    enabled: z.boolean(),
    fingerprint: z.string().length(64),
    reason: z.string().trim().min(3).max(1000),
    verifiedCheckId: z.string().uuid().optional()
  })
  .strict()
const EventSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  actorId: z.number().int().positive().nullable(),
  apiKeyId: z.number().int().positive().nullable(),
  reason: z.string().max(1000),
  enabled: z.boolean()
})
const history = (metadata: Record<string, unknown>): TlsConfigurationEvent[] =>
  (Array.isArray(metadata.history) ? metadata.history.slice(0, 50) : []).flatMap(value => {
    const parsed = EventSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
interface Row {
  key: string
  value: unknown
  updatedAt: string
}
interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  listeners(): TlsListenerSnapshot
  verifyEndpoint(tx: Knex.Transaction, checkId: string, publicUrl: string, fingerprint: string): Promise<void>
  now?(): Date
}
export const tlsRedirectEligibility = (publicUrl: unknown, trustedProxy: boolean, httpsPort: number | null): string | null => {
  if (!publicTlsTarget(publicUrl)) return 'Set a valid public HTTPS origin in General before enabling redirection.'
  if (!httpsPort && !trustedProxy) return 'Start application HTTPS or configure a trusted proxy in Security before enabling redirection.'
  return null
}
export const createTlsConfigurationStore = (deps: Dependencies) => {
  const now = () => deps.now?.() ?? new Date()
  const state = async (tx: Knex.Transaction, requester: SystemRequester, lock = false) => {
    const authority = await requireSystemAuthority(tx, requester, lock, now())
    const sq = tx<Row>('settings').whereIn('key', ['server', 'sslAdministration', 'host', 'security', 'offline', 'letsencrypt']).orderBy('key')
    const settings = await (lock ? sq.forUpdate() : sq),
      fallback = deps.fallback()
    const configuration = {
      ...fallback,
      ...Object.fromEntries(settings.map(row => [row.key, ['host', 'offline'].includes(row.key) ? (record(row.value).v ?? row.value) : row.value]))
    }
    const server = record(configuration.server),
      metadata = record(configuration.sslAdministration),
      deployment = record(fallback.ssl),
      listeners = deps.listeners()
    const trustedProxy = record(configuration.security).securityTrustProxy === true,
      publicUrl = typeof configuration.host === 'string' ? configuration.host : ''
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(
        stable([
          settings,
          configuration.server,
          configuration.sslAdministration,
          configuration.host,
          configuration.security,
          configuration.offline,
          configuration.letsencrypt,
          deployment,
          authority,
          listeners.httpPort,
          listeners.httpsPort,
          listeners.material?.revision,
          listeners.replacementMode
        ])
      )
      .digest('hex')
    // ACME persists its own account/certificate state between effects. Fence the
    // reviewed policy and authority independently so those owned writes do not
    // invalidate the request that is performing them.
    const effectFingerprint = createHmac('sha256', deps.reviewKey)
      .update(
        stable([
          configuration.server,
          configuration.host,
          configuration.security,
          configuration.offline,
          deployment,
          authority,
          listeners.httpPort,
          listeners.httpsPort,
          listeners.material?.revision,
          listeners.replacementMode
        ])
      )
      .digest('hex')
    const activeHost = typeof fallback.host === 'string' ? fallback.host : ''
    const activeProxy = record(fallback.security).securityTrustProxy === true
    const activeEnabled = record(fallback.server).sslRedir === true
    const runtimeRedirection = {
      enabled: activeEnabled,
      eligible: !tlsRedirectEligibility(activeHost, activeProxy, listeners.httpsPort),
      publicUrl: activeHost,
      settingsCurrent: activeHost === publicUrl && activeProxy === trustedProxy && activeEnabled === (server.sslRedir === true)
    }
    return { configuration, server, metadata, deployment, listeners, publicUrl, trustedProxy, fingerprint, effectFingerprint, runtimeRedirection, ...authority }
  }
  const present = (current: Awaited<ReturnType<typeof state>>): TlsConfigurationWorkspace => {
    const { deployment, listeners, metadata } = current
    let savedCertificate: TlsConfigurationWorkspace['savedCertificate'] = null,
      savedCertificateIssue: string | null = null
    const saved = record(current.configuration.letsencrypt),
      payload = record(saved.payload)
    if (typeof payload.cert === 'string' && payload.cert) {
      try {
        savedCertificate = describeTlsCertificate(payload.cert, now())
      } catch {
        savedCertificateIssue = 'The saved ACME certificate could not be read. Inspect deployment recovery material before requesting another certificate.'
      }
    }
    const reason = tlsRedirectEligibility(current.publicUrl, current.trustedProxy, listeners.httpsPort)
    return {
      fingerprint: current.fingerprint,
      revision: typeof metadata.revision === 'string' ? metadata.revision : '',
      observedAt: now().toISOString(),
      publicUrl: current.publicUrl,
      offline: current.configuration.offline === true,
      redirection: { enabled: current.server.sslRedir === true, eligible: !reason, reason, trustedProxy: current.trustedProxy },
      deployment: {
        enabled: deployment.enabled === true,
        provider: typeof deployment.provider === 'string' ? deployment.provider : null,
        format: typeof deployment.format === 'string' ? deployment.format : null,
        source: deployment.inline === true ? 'inline' : 'file',
        domain: typeof deployment.domain === 'string' ? deployment.domain : null,
        subscriberEmail: typeof deployment.subscriberEmail === 'string' ? deployment.subscriberEmail : null
      },
      listeners,
      runtimeRedirection: current.runtimeRedirection,
      savedCertificate,
      savedCertificateIssue,
      history: history(metadata)
    }
  }
  const inspect = async (requester: SystemRequester): Promise<TlsConfigurationWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const result = present(await state(tx, requester))
      await tx.commit()
      return result
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  return {
    inspect,
    reviewState: state,
    presentState: present,
    async save(requester: SystemRequester, input: unknown, transaction?: Knex.Transaction) {
      const parsed = SaveSchema.safeParse(input)
      if (!parsed.success) return fail('Review the redirect policy and provide a reason before saving.')
      const publish = async (tx: Knex.Transaction) => {
        const current = await state(tx, requester, true),
          draft = parsed.data
        if (draft.fingerprint !== current.fingerprint) return fail('HTTPS settings, listeners or your access changed. Reload and review again.', 409)
        if (draft.enabled === (current.server.sslRedir === true)) return fail('There is no redirect policy change to save.')
        if (draft.enabled) {
          const reason = tlsRedirectEligibility(current.publicUrl, current.trustedProxy, current.listeners.httpsPort)
          if (reason) return fail(reason)
          if (!draft.verifiedCheckId) return fail('Run a successful public TLS check before enabling redirection.')
          await deps.verifyEndpoint(tx, draft.verifiedCheckId, current.publicUrl, current.fingerprint)
        }
        const event: TlsConfigurationEvent = {
          id: randomUUID(),
          createdAt: now().toISOString(),
          actorId: current.actorId,
          apiKeyId: current.apiKeyId,
          reason: draft.reason,
          enabled: draft.enabled
        }
        for (const [key, value] of [
          ['server', { ...current.server, sslRedir: draft.enabled }],
          ['sslAdministration', { ...current.metadata, revision: event.id, history: [event, ...history(current.metadata)].slice(0, 50) }]
        ] as const) {
          await tx('settings')
            .insert({ key, value: JSON.stringify(value), updatedAt: event.createdAt })
            .onConflict('key')
            .merge(['value', 'updatedAt'])
        }
        return { revision: event.id, enabled: draft.enabled }
      }
      return transaction ? publish(transaction) : deps.db.transaction(publish)
    }
  }
}
