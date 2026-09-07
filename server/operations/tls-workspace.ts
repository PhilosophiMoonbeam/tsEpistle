import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import type { TlsOperation, TlsOperationKind, TlsListenerSnapshot, TlsWorkspace } from '../../shared/tls-workspace.ts'
import type { SystemRequester } from '../helpers/system-authority.ts'
import type { PreparedHttpsContext } from '../core/servers.ts'
import type { LetsEncryptService } from '../core/letsencrypt.ts'
import { acmeTlsConfiguration } from '../core/letsencrypt.ts'
import type { AcmeSavedState } from '../repositories/acme-state.ts'
import type { TlsMaterialConfiguration } from '../repositories/tls-material.ts'
import { prepareTlsMaterial } from '../repositories/tls-preflight.ts'
import { inspectTlsEndpoint, publicTlsTarget, type TlsProbeTarget } from '../repositories/tls-probe.ts'
import { createTlsConfigurationStore } from './tls-configuration.ts'
import errors from './errors.ts'

interface Row extends Omit<TlsOperation, 'createdAt' | 'completedAt'> {
  createdAt: Date | string
  completedAt: Date | string | null
  heartbeatAt: Date | string
  reviewFingerprint: string
  effectFingerprint: string
  materialKey: string | null
  materialCheckId: string | null
  allowRestart: boolean
  ownerId: string
}
interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  listeners(): TlsListenerSnapshot
  nativeTarget(): TlsProbeTarget | null
  publishRedirection(enabled: boolean): void
  acme(): LetsEncryptService | null
  prepareHttps(configuration: TlsMaterialConfiguration): Promise<PreparedHttpsContext>
  prepareMaterial?: typeof prepareTlsMaterial
  probe?: typeof inspectTlsEndpoint
  now?(): Date
}
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const schema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['public-check', 'native-check', 'validate-material', 'apply-certificate', 'renew-certificate']),
    fingerprint: z.string().length(64),
    reason: z.string().trim().max(1000).default(''),
    materialCheckId: z.string().uuid().optional(),
    allowRestart: z.boolean().default(false),
    confirmIssuance: z.boolean().default(false),
    acknowledgedUncertainId: z.string().uuid().optional()
  })
  .strict()
const ReviewSchema = z.object({ fingerprint: z.string().length(64) }).strict()
const mutating = (kind: TlsOperationKind) => kind === 'apply-certificate' || kind === 'renew-certificate'
const stamp = (value: Date | string) => new Date(value).toISOString()
export const createTlsWorkspaceStore = (deps: Dependencies) => {
  const ownerId = randomUUID(),
    active = new Set<string>(),
    now = () => deps.now?.() ?? new Date()
  const stale = (row: Row) =>
    row.state === 'running' && !(row.ownerId === ownerId && active.has(row.id)) && new Date(row.heartbeatAt).getTime() + 120000 < now().getTime()
  const present = (row: Row): TlsOperation => ({
    id: row.id,
    kind: row.kind,
    state: stale(row) ? 'uncertain' : row.state,
    phase: stale(row) ? 'interrupted' : row.phase,
    actorId: row.actorId,
    apiKeyId: row.apiKeyId,
    reason: row.reason,
    createdAt: stamp(row.createdAt),
    completedAt: row.completedAt ? stamp(row.completedAt) : null,
    summary: stale(row) ? 'This operation stopped reporting before its outcome was recorded. It has not been replayed.' : row.summary,
    result: row.result
  })
  const configuration = createTlsConfigurationStore({
    ...deps,
    verifyEndpoint: async (tx, id, url, fingerprint) => {
      const row = await tx<Row>('tlsOperations').where('id', id).first(),
        result = row?.result?.connection,
        target = publicTlsTarget(url)
      if (
        !row ||
        row.kind !== 'public-check' ||
        row.state !== 'succeeded' ||
        row.reviewFingerprint !== fingerprint ||
        !row.completedAt ||
        new Date(row.completedAt).getTime() + 900000 < now().getTime() ||
        !target ||
        result?.endpoint.host !== target.host ||
        result?.endpoint.port !== target.port ||
        result?.endpoint.servername !== target.servername ||
        !result?.connected ||
        !result.trusted ||
        !result.hostnameMatches ||
        !result.certificate ||
        new Date(result.certificate.validUntil).getTime() <= now().getTime()
      )
        return fail('Run a new successful public TLS check for the current configuration before enabling redirection.', 409)
    }
  })
  const materialConfig = (saved: Awaited<ReturnType<typeof configuration.reviewState>>): TlsMaterialConfiguration =>
    saved.deployment.provider === 'letsencrypt'
      ? acmeTlsConfiguration(record(saved.configuration.letsencrypt) as AcmeSavedState)
      : (saved.deployment as TlsMaterialConfiguration)
  const materialKey = (key: string) => createHmac('sha256', deps.reviewKey).update(key).digest('hex')
  const inspect = async (requester: SystemRequester): Promise<TlsWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const saved = await configuration.reviewState(tx, requester),
        rows = await tx<Row>('tlsOperations').orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(50)
      const result = { ...configuration.presentState(saved), operations: rows.map(present) }
      await tx.commit()
      return result
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  const receipt = async (requester: SystemRequester, id: unknown): Promise<TlsOperation> => {
    if (!z.string().uuid().safeParse(id).success) return fail('Provide a valid HTTPS operation identifier.')
    return deps.db.transaction(async tx => {
      await configuration.reviewState(tx, requester)
      const row = await tx<Row>('tlsOperations')
        .where('id', id as string)
        .first()
      return row ? present(row) : fail('This HTTPS operation has not been recorded.', 404)
    })
  }
  let publishing: Promise<unknown> = Promise.resolve()
  const publishPolicy = (requester: SystemRequester, input: unknown, save: boolean) => {
    const task = async () => {
      const parsed = save ? null : ReviewSchema.safeParse(input)
      if (!save && !parsed?.success) return fail('Reload the saved HTTPS policy before applying it.')
      const result = await deps.db.transaction(async tx => {
        const changed = save ? await configuration.save(requester, input, tx) : null
        const saved = await configuration.reviewState(tx, requester, true)
        if (!save && parsed?.success && parsed.data.fingerprint !== saved.fingerprint)
          return fail('HTTPS policy or access changed. Reload before applying it.', 409)
        return { saved, changed }
      })
      const desired = result.saved.server.sslRedir === true
      let applied = false
      try {
        const runtime = deps.fallback(),
          dependenciesCurrent = runtime.host === result.saved.publicUrl && (record(runtime.security).securityTrustProxy === true) === result.saved.trustedProxy
        if (!desired || dependenciesCurrent) {
          deps.publishRedirection(desired)
          applied = (record(deps.fallback().server).sslRedir === true) === desired
        }
      } catch {
        /* Persisted policy is retained even if this process cannot apply it. */
      }
      return { revision: result.changed?.revision ?? String(result.saved.metadata.revision ?? ''), enabled: desired, applied }
    }
    const result = publishing.then(task, task)
    publishing = result.catch(() => {})
    return result
  }
  const execute = async (requester: SystemRequester, id: string) => {
    let externalEffect = false
    const update = (value: Record<string, unknown>) => deps.db('tlsOperations').where({ id, ownerId, state: 'running' }).update(value)
    const heartbeat = setInterval(() => {
      void update({ heartbeatAt: now().toISOString() }).catch(() => {})
    }, 15000)
    heartbeat.unref()
    const guard = async () =>
      deps.db.transaction(async tx => {
        const saved = await configuration.reviewState(tx, requester, true),
          row = await tx<Row>('tlsOperations').where({ id, ownerId, state: 'running' }).forUpdate().first()
        if (!row || saved.effectFingerprint !== row.effectFingerprint)
          return fail('HTTPS policy, listener or access changed before the operation could continue.', 409)
        if (['public-check', 'renew-certificate'].includes(row.kind) && (saved.configuration.offline === true || deps.fallback().offline === true))
          return fail('External HTTPS operations are paused while offline mode is enabled.', 409)
        return { saved, row }
      })
    try {
      const { saved, row } = await guard()
      if (saved.fingerprint !== row.reviewFingerprint) return fail('HTTPS settings changed before the operation started.', 409)
      let result: TlsOperation['result'] = null,
        state: TlsOperation['state'] = 'succeeded',
        summary = '',
        key: string | null = null
      if (row.kind === 'public-check' || row.kind === 'native-check') {
        await update({ phase: 'handshake' })
        const target = row.kind === 'public-check' ? publicTlsTarget(saved.publicUrl) : deps.nativeTarget()
        if (!target) return fail('The requested HTTPS endpoint is not available.', 409)
        const connection = await (deps.probe ?? inspectTlsEndpoint)(target)
        result = { connection }
        summary = connection.summary
        state =
          connection.connected &&
          connection.trusted &&
          connection.hostnameMatches &&
          connection.certificate &&
          !['expired', 'not-yet-valid'].includes(connection.certificate.validity)
            ? 'succeeded'
            : 'failed'
      } else if (row.kind === 'validate-material') {
        await update({ phase: 'validating' })
        const material = await (deps.prepareMaterial ?? prepareTlsMaterial)(materialConfig(saved))
        if (!material.certificate) return fail('Certificate material could not be inspected.')
        result = { material: { certificate: material.certificate, format: material.format, source: material.source } }
        key = materialKey(material.key)
        state = ['expired', 'not-yet-valid'].includes(material.certificate.validity) ? 'failed' : 'succeeded'
        summary =
          state === 'succeeded'
            ? 'The certificate and private key passed local validation. Endpoint hostname and trust are checked separately.'
            : 'The certificate is outside its validity period. Restore valid material before application.'
      } else if (row.kind === 'renew-certificate') {
        await update({ phase: 'requesting-certificate' })
        const acme = deps.acme()
        if (!acme) return fail('The native certificate authority service is not available.', 409)
        externalEffect = true
        const certificate = await acme.requestCertificate(async () => {
          await guard()
        })
        result = { material: { certificate, source: 'inline', format: 'pem' } }
        summary = 'A new certificate was validated and saved. Review its material and apply it separately to the HTTPS listener.'
      } else {
        await update({ phase: 'validating' })
        const checked = await deps.db<Row>('tlsOperations').where('id', row.materialCheckId!).first()
        if (
          !checked ||
          checked.kind !== 'validate-material' ||
          checked.state !== 'succeeded' ||
          checked.reviewFingerprint !== row.reviewFingerprint ||
          !checked.materialKey
        )
          return fail('Validate the current certificate material before applying it.', 409)
        const prepared = await deps.prepareHttps(materialConfig(saved))
        if (materialKey(prepared.materialKey) !== checked.materialKey)
          return fail('Certificate files or saved material changed after validation. Validate and review the replacement again.', 409)
        await update({ phase: 'applying-certificate' })
        await guard()
        externalEffect = true
        result = { applied: await prepared.apply({ allowRestart: row.allowRestart }) }
        summary =
          'The reviewed certificate material was applied to the application HTTPS listener. Run a native handshake check to inspect its current presentation.'
      }
      await update({
        state,
        phase: 'complete',
        summary,
        result: result ? JSON.stringify(result) : null,
        materialKey: key,
        completedAt: now().toISOString(),
        heartbeatAt: now().toISOString()
      })
    } catch {
      try {
        await update({
          state: externalEffect ? 'uncertain' : 'failed',
          phase: externalEffect ? 'needs-review' : 'complete',
          summary: externalEffect
            ? 'The final certificate operation outcome could not be confirmed. Inspect saved material and the native listener before another request; this operation will not be replayed.'
            : 'The HTTPS operation did not complete. Reload the workspace and review its configuration, material and access before trying again.',
          completedAt: now().toISOString(),
          heartbeatAt: now().toISOString()
        })
      } catch {
        /* A missing terminal write becomes an interrupted receipt, never a replay. */
      }
    } finally {
      clearInterval(heartbeat)
      active.delete(id)
    }
  }
  const start = async (requester: SystemRequester, input: unknown): Promise<TlsOperation> => {
    const parsed = schema.safeParse(input)
    if (!parsed.success) return fail('Provide a reviewed HTTPS operation and request identifier.')
    const value = parsed.data
    if (mutating(value.kind) && value.reason.length < 3) return fail('Provide a reason for this certificate operation.')
    const result = await deps.db.transaction(async tx => {
      const saved = await configuration.reviewState(tx, requester, true)
      const existing = await tx<Row>('tlsOperations').where('id', value.id).forUpdate().first()
      if (existing) {
        if (
          existing.actorId !== saved.actorId ||
          existing.apiKeyId !== saved.apiKeyId ||
          existing.kind !== value.kind ||
          existing.reviewFingerprint !== value.fingerprint ||
          existing.materialCheckId !== (value.materialCheckId ?? null) ||
          existing.allowRestart !== value.allowRestart ||
          existing.reason !== value.reason
        )
          return fail('This request identifier belongs to another reviewed operation.', 409)
        return { row: existing, started: false }
      }
      if (value.fingerprint !== saved.fingerprint) return fail('HTTPS settings, listeners or access changed. Reload and review again.', 409)
      const running = await tx<Row>('tlsOperations').where('state', 'running').forUpdate()
      for (const row of running) {
        if (!stale(row)) return fail('An HTTPS operation is already running. Inspect its receipt before starting another.', 409)
        await tx('tlsOperations').where('id', row.id).update({
          state: 'uncertain',
          phase: 'interrupted',
          summary: 'This operation stopped reporting before its outcome was recorded. It has not been replayed.',
          completedAt: now().toISOString()
        })
      }
      if (mutating(value.kind)) {
        const previous = await tx<Row>('tlsOperations')
          .whereIn('kind', ['apply-certificate', 'renew-certificate'])
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .first()
        if (previous?.state === 'uncertain' && previous.id !== value.acknowledgedUncertainId)
          return fail('Review the latest uncertain certificate operation before requesting another change.', 409)
      }
      if (['public-check', 'renew-certificate'].includes(value.kind) && (saved.configuration.offline === true || deps.fallback().offline === true))
        return fail('External HTTPS operations are paused while offline mode is enabled.', 409)
      if (value.kind === 'public-check' && !publicTlsTarget(saved.publicUrl))
        return fail('Configure a public HTTPS origin in General before checking its certificate.')
      if (value.kind === 'native-check' && !deps.nativeTarget()) return fail('The application HTTPS listener is not running.')
      if (
        value.kind === 'renew-certificate' &&
        (!value.confirmIssuance || saved.deployment.enabled !== true || saved.deployment.provider !== 'letsencrypt' || !deps.acme())
      )
        return fail('Review issuance for an enabled native Let’s Encrypt deployment before requesting a certificate.')
      if (value.kind === 'apply-certificate') {
        if (!saved.listeners.httpsPort) return fail('The application HTTPS listener must be running before certificate replacement.')
        if (saved.listeners.replacementMode === 'listener-restart' && !value.allowRestart)
          return fail('Acknowledge the HTTPS connection interruption before applying certificate material.')
        if (!value.materialCheckId) return fail('Validate the current certificate material before applying it.')
        const checked = await tx<Row>('tlsOperations').where('id', value.materialCheckId).first()
        if (
          !checked ||
          checked.kind !== 'validate-material' ||
          checked.state !== 'succeeded' ||
          checked.reviewFingerprint !== saved.fingerprint ||
          !checked.materialKey
        )
          return fail('Validate the current certificate material before applying it.', 409)
      }
      const row: Row = {
        id: value.id,
        kind: value.kind,
        state: 'running',
        phase: 'queued',
        actorId: saved.actorId,
        apiKeyId: saved.apiKeyId,
        reason: value.reason,
        reviewFingerprint: saved.fingerprint,
        effectFingerprint: saved.effectFingerprint,
        materialKey: null,
        materialCheckId: value.materialCheckId ?? null,
        allowRestart: value.allowRestart,
        ownerId,
        createdAt: now().toISOString(),
        heartbeatAt: now().toISOString(),
        completedAt: null,
        summary: 'Operation recorded. Its outcome will appear here.',
        result: null
      }
      await tx('tlsOperations').insert(row)
      return { row, started: true }
    })
    if (result.started) {
      active.add(result.row.id)
      void execute(requester, result.row.id)
    }
    return present(result.row)
  }
  return {
    configuration,
    inspect,
    receipt,
    start,
    save: (requester: SystemRequester, input: unknown) => publishPolicy(requester, input, true),
    applyPolicy: (requester: SystemRequester, input: unknown) => publishPolicy(requester, input, false)
  }
}

let database: Knex | undefined, workspace: ReturnType<typeof createTlsWorkspaceStore> | undefined
export const getTlsWorkspaceStore = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    config: Record<string, unknown> & { sessionSecret: string }
    servers: {
      servers: { http: import('node:http').Server | null; https: import('node:https').Server | null }
      le: LetsEncryptService | null
      inspectHttpsMaterial(): TlsListenerSnapshot['material']
      prepareHttpsContext(configuration: TlsMaterialConfiguration): Promise<PreparedHttpsContext>
    }
  }
  if (!workspace || database !== wiki.models.knex) {
    database = wiki.models.knex
    const address = (server: import('node:http').Server | import('node:https').Server | null) => {
      const value = server?.listening ? server.address() : null
      return value && typeof value !== 'string' ? value : null
    }
    workspace = createTlsWorkspaceStore({
      db: database,
      reviewKey: wiki.config.sessionSecret,
      fallback: () => wiki.config,
      listeners: () => ({
        httpPort: address(wiki.servers.servers.http)?.port ?? null,
        httpsPort: address(wiki.servers.servers.https)?.port ?? null,
        material: wiki.servers.inspectHttpsMaterial(),
        replacementMode: wiki.servers.servers.https?.listening
          ? typeof wiki.servers.servers.https.setSecureContext === 'function'
            ? 'context-reload'
            : 'listener-restart'
          : null
      }),
      nativeTarget: () => {
        const bound = address(wiki.servers.servers.https)
        if (!bound) return null
        const host = bound.address === '::' ? '::1' : bound.address === '0.0.0.0' ? '127.0.0.1' : bound.address
        const ssl = record(wiki.config.ssl)
        let servername = typeof ssl.domain === 'string' && ssl.domain ? ssl.domain : null
        if (!servername) {
          try {
            servername = new URL(String(wiki.config.host)).hostname.replace(/^\[|\]$/g, '')
          } catch {
            servername = host
          }
        }
        return { host, port: bound.port, servername }
      },
      publishRedirection: enabled => {
        wiki.config.server = { ...record(wiki.config.server), sslRedir: enabled }
      },
      acme: () => wiki.servers.le,
      prepareHttps: configuration => wiki.servers.prepareHttpsContext(configuration)
    })
  }
  return workspace
}
