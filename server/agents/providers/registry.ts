import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Knex } from 'knex'
import { z } from 'zod'
import type { AgentExecutionMode, AgentProviderProfileView as AgentProviderSelectionView } from '../../../shared/agents/contracts.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import type { AgentAdmissionResolver, AgentResolvedAdmission } from '../runtime.ts'
import { AgentRepositoryError } from '../repository.ts'
import type { AgentSecretRegistry } from './secrets.ts'

const TransportKindSchema = z.enum(['openai-responses', 'openresponses', 'openai-chat', 'legacy-completions', 'anthropic-messages'])
const AuthModeSchema = z.enum(['bearer', 'api-key-header', 'anthropic-api-key'])
export const AgentProviderCapabilitiesSchema = z.strictObject({
  streaming: z.boolean(),
  functions: z.boolean(),
  parallelFunctions: z.boolean(),
  structuredOutput: z.enum(['native-json-schema', 'tool-result', 'prompt-only']),
  usage: z.enum(['stream', 'terminal', 'estimated']),
  cancellation: z.boolean(),
  maxContextTokens: z.number().int().min(1_024).max(10_000_000),
  maxOutputTokens: z.number().int().min(1).max(1_000_000)
})
const HeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).max(128)
const FORBIDDEN_HEADERS = new Set(['authorization', 'cookie', 'host', 'proxy-authorization', 'forwarded', 'via', 'traceparent', 'tracestate', 'connection', 'transfer-encoding', 'upgrade', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'])
export const AgentProviderAdapterConfigSchema = z.strictObject({
  timeoutMs: z.number().int().min(1_000).max(300_000),
  maxRetries: z.literal(0),
  additionalHeaders: z.record(HeaderNameSchema, z.string().max(2_000)).refine(value => Object.keys(value).length <= 16, 'At most 16 additional headers are allowed').default({}),
  temperature: z.number().min(0).max(2).optional(),
  reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional()
})
export const AgentProviderPoliciesSchema = z.strictObject({
  allowedModes: z.array(z.enum(['agent', 'generation-only'])).min(1).max(2),
  dailyTokens: z.number().int().positive().max(1_000_000_000),
  dailyCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reservationTokens: z.number().int().positive().max(10_000_000),
  reservationCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reservationMilliseconds: z.number().int().min(10_000).max(3_600_000),
  promptVersion: z.number().int().positive(),
  maxAttempts: z.number().int().min(1).max(10).default(3)
})

export const AgentProviderSettingsInputSchema = z.strictObject({
  transportKind: TransportKindSchema,
  model: z.string(),
  baseUrl: z.string(),
  authMode: AuthModeSchema,
  secretReference: z.string().nullable(),
  secretValue: z.string().optional(),
  adapterConfig: AgentProviderAdapterConfigSchema,
  capabilities: AgentProviderCapabilitiesSchema,
  capabilityRevision: z.string(),
  policies: AgentProviderPoliciesSchema,
  pricingRevision: z.string()
})

export const CreateAgentProviderProfileSchema = AgentProviderSettingsInputSchema.extend({
  displayName: z.string(),
  exposureMode: z.enum(['all_agent_users', 'groups']),
  groupIds: z.array(z.number().int().positive()).max(1_000).optional()
}).strict()

export const UpdateAgentProviderProfileSchema = AgentProviderSettingsInputSchema.extend({
  displayName: z.string().optional()
}).strict()

export type AgentProviderCapabilities = z.infer<typeof AgentProviderCapabilitiesSchema>
export type AgentProviderPolicies = z.infer<typeof AgentProviderPoliciesSchema>
export type AgentProviderTransportKind = z.infer<typeof TransportKindSchema>

export interface AgentProviderSettingsInput {
  readonly transportKind: AgentProviderTransportKind
  readonly model: string
  readonly baseUrl: string
  readonly authMode: z.infer<typeof AuthModeSchema>
  readonly secretReference: string | null
  readonly secretValue?: string | undefined
  readonly adapterConfig: z.input<typeof AgentProviderAdapterConfigSchema>
  readonly capabilities: AgentProviderCapabilities
  readonly capabilityRevision: string
  readonly policies: z.input<typeof AgentProviderPoliciesSchema>
  readonly pricingRevision: string
}

export interface CreateAgentProviderProfileInput extends AgentProviderSettingsInput {
  readonly displayName: string
  readonly exposureMode: 'all_agent_users' | 'groups'
  readonly groupIds?: readonly number[]
  readonly actorId: number
}

export interface UpdateAgentProviderProfileInput extends AgentProviderSettingsInput {
  readonly displayName?: string | undefined
  readonly actorId: number
}

export interface AgentProviderProfileView {
  readonly id: string
  readonly displayName: string
  readonly status: 'enabled' | 'disabled'
  readonly isGlobalDefault: boolean
  readonly exposureMode: 'all_agent_users' | 'groups'
  readonly policyVersion: number
  readonly conformed: boolean
  readonly transportKind: AgentProviderTransportKind
  readonly model: string
  readonly destinationHost: string
  readonly authMode: z.infer<typeof AuthModeSchema>
  readonly secretConfigured: boolean
  readonly capabilities: AgentProviderCapabilities
  readonly capabilityRevision: string
  readonly pricingRevision: string
  readonly createdAt: string
}

export interface AgentProviderProfileAdminView extends AgentProviderProfileView {
  readonly baseUrl: string
  readonly adapterConfig: z.infer<typeof AgentProviderAdapterConfigSchema>
  readonly policies: z.infer<typeof AgentProviderPoliciesSchema>
}


interface TokenPayload {
  readonly v: 1
  readonly kid: string
  readonly ownerId: number
  readonly sessionId: string
  readonly sessionVersion: number
  readonly profileId: string
  readonly profileVersionId: string
  readonly profileVersion: number
  readonly profilePolicyVersion: number
  readonly defaultGeneration: number
  readonly executionMode: AgentExecutionMode
  readonly exp: number
}

export interface AgentProfileTokenKeys {
  readonly currentKeyId: string
  readonly keys: Readonly<Record<string, string>>
}

interface ProfileRow {
  id: string
  displayName: string
  status: string
  isGlobalDefault: boolean
  exposureMode: string
  currentVersionId: string | null
  policyVersion: number | string
  conformed: boolean
  createdAt: Date | string
  deletedAt: Date | string | null
}
interface VersionRow {
  id: string
  profileId: string
  version: number
  transportKind: string
  model: string
  baseUrl: string
  authMode: string
  secretReference: string | null
  adapterConfig: string
  capabilities: string
  capabilityRevision: string
  policies: string
  pricingRevision: string
  conformed: boolean
  createdAt: Date | string
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}
const normalizedString = (value: string, label: string, maximum: number): string => {
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > maximum || containsControlCharacter(normalized)) throw new AgentRepositoryError('INVALID_PROVIDER_PROFILE', `${label} is invalid`, 400)
  return normalized
}
const privateIp = (hostname: string): boolean => {
  if (isIP(hostname) === 4) {
    const parts = hostname.split('.').map(Number)
    const a = parts[0] ?? -1
    const b = parts[1] ?? -1
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (isIP(hostname) === 6) {
    const value = hostname.toLowerCase()
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
  }
  return false
}
const normalizeBaseUrl = (value: string): string => {
  let url: URL
  try { url = new URL(value) } catch { throw new AgentRepositoryError('INVALID_PROVIDER_URL', 'Provider base URL is invalid', 400) }
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || privateIp(hostname)) throw new AgentRepositoryError('INVALID_PROVIDER_URL', 'Provider base URL must be a public HTTPS origin and base path', 400)
  url.hostname = hostname
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}
const validateHeaders = (headers: Readonly<Record<string, string>>): void => {
  for (const name of Object.keys(headers)) if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith('x-forwarded-')) throw new AgentRepositoryError('INVALID_PROVIDER_HEADERS', `Provider header ${name} is not allowed`, 400)
}
const EnvironmentSecretReference = /^env:[A-Z][A-Z0-9_]{0,127}$/
const ManagedSecretReference = /^managed:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const validateSettings = (input: AgentProviderSettingsInput, allowManagedReference = false) => {
  const transportKind = TransportKindSchema.parse(input.transportKind)
  const model = normalizedString(input.model, 'Provider model', 255)
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const authMode = AuthModeSchema.parse(input.authMode)
  const secretReference = input.secretReference === null ? null : normalizedString(input.secretReference, 'Secret reference', 255)
  const secretValue = input.secretValue
  if (secretValue !== undefined && secretReference !== null) throw new AgentRepositoryError('INVALID_PROVIDER_SECRET', 'Provide either a credential or a secret reference, not both', 400)
  if (secretValue === undefined && (secretReference === null || (!EnvironmentSecretReference.test(secretReference) && !(allowManagedReference && ManagedSecretReference.test(secretReference))))) throw new AgentRepositoryError('INVALID_PROVIDER_SECRET', 'Secret reference must use env:NAME and must not contain the API key', 400)
  if ((transportKind === 'openai-responses' || transportKind === 'openresponses' || transportKind === 'openai-chat') && authMode !== 'bearer') throw new AgentRepositoryError('INVALID_PROVIDER_AUTH', 'Selected provider transport requires bearer authentication', 400)
  if (transportKind === 'anthropic-messages' && authMode !== 'anthropic-api-key') throw new AgentRepositoryError('INVALID_PROVIDER_AUTH', 'Anthropic Messages requires Anthropic API key authentication', 400)
  if (transportKind === 'legacy-completions' && authMode === 'anthropic-api-key') throw new AgentRepositoryError('INVALID_PROVIDER_AUTH', 'Legacy completions do not support Anthropic authentication', 400)
  const adapterConfig = AgentProviderAdapterConfigSchema.parse(input.adapterConfig)
  validateHeaders(adapterConfig.additionalHeaders)
  const capabilities = AgentProviderCapabilitiesSchema.parse(input.capabilities)
  const policies = AgentProviderPoliciesSchema.parse(input.policies)
  if (transportKind === 'legacy-completions' && (capabilities.functions || capabilities.streaming || policies.allowedModes.includes('agent'))) throw new AgentRepositoryError('INVALID_PROVIDER_CAPABILITIES', 'Legacy completions must be buffered generation-only', 400)
  if (policies.allowedModes.includes('agent') && (!capabilities.streaming || !capabilities.functions || !capabilities.cancellation)) throw new AgentRepositoryError('INVALID_PROVIDER_CAPABILITIES', 'Agent mode requires streaming, function tools, and cancellation', 400)
  return {
    transportKind,
    model,
    baseUrl,
    authMode,
    secretReference,
    adapterConfig,
    capabilities,
    capabilityRevision: normalizedString(input.capabilityRevision, 'Capability revision', 128),
    policies,
    secretValue,
    pricingRevision: normalizedString(input.pricingRevision, 'Pricing revision', 128)
  }
}

const parseJson = <T>(schema: z.ZodType<T>, value: string, code: string): T => {
  try { return schema.parse(JSON.parse(value)) } catch { throw new AgentRepositoryError(code, 'Stored provider profile data is invalid', 500) }
}
const encodePayload = (payload: TokenPayload): string => Buffer.from(canonicalJson(payload)).toString('base64url')
const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export class AgentProviderRegistry implements AgentAdmissionResolver {
  readonly #knex: Knex
  readonly #secrets: AgentSecretRegistry
  readonly #keys: AgentProfileTokenKeys

  constructor (knex: Knex, secrets: AgentSecretRegistry, keys: AgentProfileTokenKeys) {
    const secret = keys.keys[keys.currentKeyId]
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Current profile-resolution key must contain at least 32 bytes')
    this.#knex = knex
    this.#secrets = secrets
    this.#keys = keys
  }

  #sign(payload: string, keyId: string): string {
    const secret = this.#keys.keys[keyId]
    if (!secret) throw new AgentRepositoryError('PROFILE_RESOLUTION_CHANGED', 'Profile resolution key is unavailable', 409)
    return createHmac('sha256', secret).update(payload).digest('base64url')
  }

  async #configuration(transaction: Knex | Knex.Transaction): Promise<{ defaultGeneration: number }> {
    let row = await transaction('agentProviderConfiguration').where({ id: 1 }).first('defaultGeneration') as { defaultGeneration: number | string } | undefined
    if (!row) {
      await transaction('agentProviderConfiguration').insert({ id: 1, defaultGeneration: 1, updatedAt: new Date(), updatedBy: null }).onConflict('id').ignore()
      row = await transaction('agentProviderConfiguration').where({ id: 1 }).first('defaultGeneration') as { defaultGeneration: number | string }
    }
    return { defaultGeneration: Number(row.defaultGeneration) }
  }

  async create(input: CreateAgentProviderProfileInput): Promise<AgentProviderProfileView> {
    const value = validateSettings(input)
    const displayName = normalizedString(input.displayName, 'Profile display name', 255)
    const exposureMode = z.enum(['all_agent_users', 'groups']).parse(input.exposureMode)
    const groupIds = [...new Set(input.groupIds ?? [])]
    if (exposureMode === 'groups' && groupIds.length === 0) throw new AgentRepositoryError('INVALID_PROVIDER_GRANTS', 'Group-restricted profile requires at least one group', 400)
    const profileId = randomUUID()
    const versionId = randomUUID()
    await this.#knex.transaction(async transaction => {
      await this.#configuration(transaction)
      const now = new Date()
      const secretReference = value.secretValue === undefined ? value.secretReference : await this.#secrets.store(value.secretValue, input.actorId, transaction)
      await transaction('agentProviderProfiles').insert({ id: profileId, displayName, status: 'disabled', isGlobalDefault: false, exposureMode, currentVersionId: null, policyVersion: 1, conformed: false, createdBy: input.actorId, updatedBy: input.actorId, createdAt: now, updatedAt: now })
      await transaction('agentProviderProfileVersions').insert({ id: versionId, profileId, version: 1, transportKind: value.transportKind, model: value.model, baseUrl: value.baseUrl, authMode: value.authMode, secretReference, adapterConfig: canonicalJson(value.adapterConfig), capabilities: canonicalJson(value.capabilities), capabilityRevision: value.capabilityRevision, policies: canonicalJson(value.policies), pricingRevision: value.pricingRevision, conformed: false, createdBy: input.actorId, createdAt: now })
      await transaction('agentProviderProfiles').where({ id: profileId }).update({ currentVersionId: versionId })
      if (groupIds.length > 0) await transaction('agentProviderGrants').insert(groupIds.map(groupId => ({ profileId, groupId })))
    })
    return this.get(profileId)
  }

  async update(profileId: string, input: UpdateAgentProviderProfileInput): Promise<AgentProviderProfileAdminView> {
    const displayName = input.displayName === undefined ? undefined : normalizedString(input.displayName, 'Profile display name', 255)
    await this.#knex.transaction(async transaction => {
      const profile = await transaction<ProfileRow>('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').forUpdate().first()
      const currentVersionId = profile?.currentVersionId
      if (!profile || !currentVersionId) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
      const currentSettings = await transaction<VersionRow>('agentProviderProfileVersions').where({ id: currentVersionId, profileId }).first()
      if (!currentSettings) throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Current provider settings are missing', 500)
      const reusingSecret = input.secretReference === null && input.secretValue === undefined
      const value = validateSettings(reusingSecret ? { ...input, secretReference: currentSettings.secretReference } : input, reusingSecret)
      const secretReference = value.secretValue === undefined ? value.secretReference : await this.#secrets.store(value.secretValue, input.actorId, transaction)
      await transaction('agentProviderProfileVersions').where({ id: currentVersionId, profileId }).update({ transportKind: value.transportKind, model: value.model, baseUrl: value.baseUrl, authMode: value.authMode, secretReference, adapterConfig: canonicalJson(value.adapterConfig), capabilities: canonicalJson(value.capabilities), capabilityRevision: value.capabilityRevision, policies: canonicalJson(value.policies), pricingRevision: value.pricingRevision, conformed: false })
      await transaction('agentProviderProfiles').where({ id: profileId }).update({ ...(displayName === undefined ? {} : { displayName }), status: 'disabled', isGlobalDefault: false, conformed: false, policyVersion: Number(profile.policyVersion) + 1, updatedBy: input.actorId, updatedAt: new Date() })
      if (currentSettings.secretReference && currentSettings.secretReference !== secretReference) await this.#secrets.delete(currentSettings.secretReference, transaction)
    })
    return this.getAdmin(profileId)
  }

  async setConformed(profileId: string, versionId: string, conformed: boolean, actorId: number): Promise<void> {
    await this.#knex.transaction(async transaction => {
      const profile = await transaction<ProfileRow>('agentProviderProfiles').where({ id: profileId, currentVersionId: versionId }).whereNull('deletedAt').forUpdate().first()
      if (!profile) throw new AgentRepositoryError('PROFILE_VERSION_CHANGED', 'Provider profile version changed', 409)
      await transaction('agentProviderProfileVersions').where({ id: versionId, profileId }).update({ conformed })
      await transaction('agentProviderProfiles').where({ id: profileId }).update({ conformed, ...(conformed ? {} : { status: 'disabled', isGlobalDefault: false }), policyVersion: Number(profile.policyVersion) + 1, updatedBy: actorId, updatedAt: new Date() })
    })
  }

  async setEnabled(profileId: string, enabled: boolean, actorId: number): Promise<void> {
    await this.#knex.transaction(async transaction => {
      await this.#configuration(transaction)
      await transaction('agentProviderConfiguration').where({ id: 1 }).forUpdate().first('id')
      const profile = await transaction<ProfileRow>('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').forUpdate().first()
      if (!profile || !profile.currentVersionId) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
      const version = await transaction<VersionRow>('agentProviderProfileVersions').where({ id: profile.currentVersionId }).first()
      if (!version) throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Current provider version is missing', 500)
      if (enabled && (!profile.conformed || !version.conformed || !version.secretReference || !await this.#secrets.has(version.secretReference, transaction))) throw new AgentRepositoryError('PROFILE_NOT_READY', 'Provider profile is not conformed or its secret is unavailable', 409)
      const hasDefault = enabled && profile.exposureMode === 'all_agent_users'
        ? Boolean(await transaction('agentProviderProfiles').where({ isGlobalDefault: true, status: 'enabled', conformed: true, exposureMode: 'all_agent_users' }).whereNull('deletedAt').first('id'))
        : true
      const becomesDefault = enabled && profile.exposureMode === 'all_agent_users' && !hasDefault
      await transaction('agentProviderProfiles').where({ id: profileId }).update({ status: enabled ? 'enabled' : 'disabled', ...(enabled ? becomesDefault ? { isGlobalDefault: true } : {} : { isGlobalDefault: false }), policyVersion: Number(profile.policyVersion) + 1, updatedBy: actorId, updatedAt: new Date() })
      if ((!enabled && profile.isGlobalDefault) || becomesDefault) await transaction('agentProviderConfiguration').where({ id: 1 }).update({ defaultGeneration: transaction.raw('?? + 1', ['defaultGeneration']), updatedBy: actorId, updatedAt: new Date() })
    })
  }

  async setDefault(profileId: string, actorId: number): Promise<void> {
    await this.#knex.transaction(async transaction => {
      await this.#configuration(transaction)
      const profile = await transaction<ProfileRow>('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').forUpdate().first()
      if (!profile || profile.status !== 'enabled' || !profile.conformed || profile.exposureMode !== 'all_agent_users') throw new AgentRepositoryError('PROFILE_NOT_DEFAULTABLE', 'Global default profile must be enabled, conformed, and visible to all agent users', 409)
      await transaction('agentProviderProfiles').whereNot({ id: profileId }).andWhere({ isGlobalDefault: true }).update({ isGlobalDefault: false, updatedBy: actorId, updatedAt: new Date() })
      await transaction('agentProviderProfiles').where({ id: profileId }).update({ isGlobalDefault: true, policyVersion: Number(profile.policyVersion) + 1, updatedBy: actorId, updatedAt: new Date() })
      await transaction('agentProviderConfiguration').where({ id: 1 }).update({ defaultGeneration: transaction.raw('?? + 1', ['defaultGeneration']), updatedBy: actorId, updatedAt: new Date() })
    })
  }

  async remove(profileId: string, actorId: number): Promise<void> {
    await this.#knex.transaction(async transaction => {
      await this.#configuration(transaction)
      const profile = await transaction<ProfileRow>('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').forUpdate().first()
      if (!profile) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
      const references = await transaction<VersionRow>('agentProviderProfileVersions').where({ profileId }).whereNotNull('secretReference').pluck<string>('secretReference')
      const now = new Date()
      await transaction('agentProviderProfiles').where({ id: profileId }).update({ status: 'disabled', isGlobalDefault: false, conformed: false, deletedAt: now, policyVersion: Number(profile.policyVersion) + 1, updatedBy: actorId, updatedAt: now })
      await transaction('agentProviderGrants').where({ profileId }).delete()
      for (const reference of new Set(references)) await this.#secrets.delete(reference, transaction)
      if (profile.isGlobalDefault) await transaction('agentProviderConfiguration').where({ id: 1 }).update({ defaultGeneration: transaction.raw('?? + 1', ['defaultGeneration']), updatedBy: actorId, updatedAt: now })
    })
  }

  async #getProfile(profileId: string): Promise<AgentProviderProfileAdminView> {
    const row = await this.#knex<ProfileRow>('agentProviderProfiles').where('agentProviderProfiles.id', profileId).whereNull('agentProviderProfiles.deletedAt').join('agentProviderProfileVersions', 'agentProviderProfileVersions.id', 'agentProviderProfiles.currentVersionId').select('agentProviderProfiles.*', 'agentProviderProfileVersions.version', 'agentProviderProfileVersions.transportKind', 'agentProviderProfileVersions.model', 'agentProviderProfileVersions.baseUrl', 'agentProviderProfileVersions.authMode', 'agentProviderProfileVersions.secretReference', 'agentProviderProfileVersions.adapterConfig', 'agentProviderProfileVersions.capabilities', 'agentProviderProfileVersions.capabilityRevision', 'agentProviderProfileVersions.policies', 'agentProviderProfileVersions.pricingRevision').first() as (ProfileRow & VersionRow) | undefined
    if (!row || !row.currentVersionId) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
    return {
      id: row.id,
      displayName: row.displayName,
      status: z.enum(['enabled', 'disabled']).parse(row.status),
      isGlobalDefault: Boolean(row.isGlobalDefault),
      exposureMode: z.enum(['all_agent_users', 'groups']).parse(row.exposureMode),
      policyVersion: Number(row.policyVersion),
      conformed: Boolean(row.conformed),
      transportKind: TransportKindSchema.parse(row.transportKind),
      model: row.model,
      destinationHost: new URL(row.baseUrl).host,
      authMode: AuthModeSchema.parse(row.authMode),
      secretConfigured: row.secretReference !== null && await this.#secrets.has(row.secretReference),
      capabilities: parseJson(AgentProviderCapabilitiesSchema, row.capabilities, 'PROVIDER_PROFILE_CORRUPT'),
      capabilityRevision: row.capabilityRevision,
      pricingRevision: row.pricingRevision,
      createdAt: new Date(row.createdAt).toISOString(),
      baseUrl: row.baseUrl,
      adapterConfig: parseJson(AgentProviderAdapterConfigSchema, row.adapterConfig, 'PROVIDER_PROFILE_CORRUPT'),
      policies: parseJson(AgentProviderPoliciesSchema, row.policies, 'PROVIDER_PROFILE_CORRUPT')
    }
  }

  async get(profileId: string): Promise<AgentProviderProfileView> {
    const profile = await this.#getProfile(profileId)
    return {
      id: profile.id,
      displayName: profile.displayName,
      status: profile.status,
      isGlobalDefault: profile.isGlobalDefault,
      exposureMode: profile.exposureMode,
      policyVersion: profile.policyVersion,
      conformed: profile.conformed,
      transportKind: profile.transportKind,
      model: profile.model,
      destinationHost: profile.destinationHost,
      authMode: profile.authMode,
      secretConfigured: profile.secretConfigured,
      capabilities: profile.capabilities,
      capabilityRevision: profile.capabilityRevision,
      pricingRevision: profile.pricingRevision,
      createdAt: profile.createdAt
    }
  }

  async getAdmin(profileId: string): Promise<AgentProviderProfileAdminView> {
    return this.#getProfile(profileId)
  }

  async listAll(limit = 100): Promise<AgentProviderProfileAdminView[]> {
    const ids = await this.#knex('agentProviderProfiles').whereNull('deletedAt').orderBy('displayName').limit(Math.max(1, Math.min(100, limit))).pluck<string>('id')
    return Promise.all(ids.map(id => this.getAdmin(id)))
  }

  async setGrants(profileId: string, exposureMode: 'all_agent_users' | 'groups', groupIds: readonly number[], actorId: number): Promise<void> {
    const mode = z.enum(['all_agent_users', 'groups']).parse(exposureMode)
    const ids = [...new Set(groupIds)]
    if (mode === 'groups' && ids.length === 0) throw new AgentRepositoryError('INVALID_PROVIDER_GRANTS', 'Group-restricted profile requires at least one group', 400)
    await this.#knex.transaction(async transaction => {
      const profile = await transaction<ProfileRow>('agentProviderProfiles').where({ id: profileId }).whereNull('deletedAt').forUpdate().first()
      if (!profile) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Provider profile was not found', 404)
      await transaction('agentProviderGrants').where({ profileId }).delete()
      if (ids.length > 0) await transaction('agentProviderGrants').insert(ids.map(groupId => ({ profileId, groupId })))
      await transaction('agentProviderProfiles').where({ id: profileId }).update({ exposureMode: mode, isGlobalDefault: false, policyVersion: Number(profile.policyVersion) + 1, updatedBy: actorId, updatedAt: new Date() })
      if (profile.isGlobalDefault) await transaction('agentProviderConfiguration').where({ id: 1 }).update({ defaultGeneration: transaction.raw('?? + 1', ['defaultGeneration']), updatedBy: actorId, updatedAt: new Date() })
    })
  }

  async setSessionProfile(input: { readonly ownerId: number; readonly sessionId: string; readonly expectedSessionVersion: number; readonly profileId: string | null; readonly executionMode: AgentExecutionMode }): Promise<void> {
    await this.#knex.transaction(async transaction => {
      const session = await transaction('agentSessions').where({ id: input.sessionId, ownerId: input.ownerId, version: input.expectedSessionVersion }).whereNull('deletedAt').forUpdate().first('id') as { id: string } | undefined
      if (!session) throw new AgentRepositoryError('SESSION_VERSION_CHANGED', 'Agent session changed concurrently', 409)
      const active = await transaction('agentRuns').where({ sessionId: input.sessionId }).whereIn('status', ['queued', 'running', 'awaiting_approval']).first('id')
      if (active) throw new AgentRepositoryError('SESSION_RUN_ACTIVE', 'Agent session already has an active run', 409)
      const profile = input.profileId === null
        ? await transaction<ProfileRow>('agentProviderProfiles').where({ isGlobalDefault: true, status: 'enabled', conformed: true }).whereNull('deletedAt').first()
        : await transaction<ProfileRow>('agentProviderProfiles').where({ id: input.profileId, status: 'enabled', conformed: true }).whereNull('deletedAt').first()
      if (!profile?.currentVersionId) throw new AgentRepositoryError('PROFILE_UNAVAILABLE', 'Selected provider profile is unavailable', 409)
      const version = await transaction<VersionRow>('agentProviderProfileVersions').where({ id: profile.currentVersionId, conformed: true }).first()
      const allowed = profile.exposureMode === 'all_agent_users' || Boolean(await transaction('agentProviderGrants').join('userGroups', 'userGroups.groupId', 'agentProviderGrants.groupId').where('agentProviderGrants.profileId', profile.id).andWhere('userGroups.userId', input.ownerId).first('agentProviderGrants.profileId'))
      if (!version?.secretReference || !allowed || !await this.#secrets.has(version.secretReference, transaction)) throw new AgentRepositoryError('PROFILE_UNAVAILABLE', 'Selected provider profile is unavailable', 409)
      const capabilities = parseJson(AgentProviderCapabilitiesSchema, version.capabilities, 'PROVIDER_PROFILE_CORRUPT')
      const policies = parseJson(AgentProviderPoliciesSchema, version.policies, 'PROVIDER_PROFILE_CORRUPT')
      if (!policies.allowedModes.includes(input.executionMode) || (input.executionMode === 'agent' && (!capabilities.streaming || !capabilities.functions || !capabilities.cancellation))) throw new AgentRepositoryError('PROFILE_MODE_INCOMPATIBLE', 'Provider profile does not support the selected mode', 409)
      await transaction('agentSessions').where({ id: input.sessionId, ownerId: input.ownerId, version: input.expectedSessionVersion }).update({ providerProfileId: input.profileId, executionMode: input.executionMode, version: input.expectedSessionVersion + 1, updatedAt: new Date() })
    })
  }

  async listVisible(ownerId: number, limit = 100): Promise<AgentProviderSelectionView[]> {
    const profileIds = await this.#knex('agentProviderProfiles').where({ status: 'enabled', conformed: true }).whereNull('deletedAt').andWhere(query => query.where({ exposureMode: 'all_agent_users' }).orWhereExists(this.#knex('agentProviderGrants').join('userGroups', 'userGroups.groupId', 'agentProviderGrants.groupId').whereRaw('"agentProviderGrants"."profileId" = "agentProviderProfiles"."id"').andWhere('userGroups.userId', ownerId).select(this.#knex.raw('1')))).orderBy('displayName').limit(Math.max(1, Math.min(100, limit))).pluck<string>('id')
    const profiles = await Promise.all(profileIds.map(id => this.getAdmin(id)))
    return profiles.map(profile => ({
      id: profile.id,
      name: profile.displayName,
      transport: profile.transportKind,
      model: profile.model,
      destinationHost: profile.destinationHost,
      executionModes: profile.policies.allowedModes,
      capabilities: profile.capabilities,
      capabilityRevision: profile.capabilityRevision,
      policyVersion: profile.policyVersion,
      isGlobalDefault: profile.isGlobalDefault
    }))
  }

  async issueResolutionToken(ownerId: number, sessionId: string, ttlSeconds = 300): Promise<string> {
    const payload = await this.#knex.transaction(async transaction => {
      const session = await transaction('agentSessions').where({ id: sessionId, ownerId }).whereNull('deletedAt').first('id', 'version', 'providerProfileId', 'executionMode') as { id: string, version: number, providerProfileId: string | null, executionMode: AgentExecutionMode } | undefined
      if (!session) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent session was not found', 404)
      const configuration = await this.#configuration(transaction)
      const profile = session.providerProfileId
        ? await transaction<ProfileRow>('agentProviderProfiles').where({ id: session.providerProfileId }).whereNull('deletedAt').first()
        : await transaction<ProfileRow>('agentProviderProfiles').where({ isGlobalDefault: true, status: 'enabled', conformed: true }).whereNull('deletedAt').first()
      if (!profile?.currentVersionId) throw new AgentRepositoryError('PROFILE_UNAVAILABLE', session.providerProfileId ? 'Selected provider profile is unavailable' : 'No default provider profile is configured. Set an enabled, connection-verified provider as the global default in Agent administration.', 409)
      const version = await transaction<VersionRow>('agentProviderProfileVersions').where({ id: profile.currentVersionId, profileId: profile.id }).first()
      if (!version) throw new AgentRepositoryError('PROVIDER_PROFILE_CORRUPT', 'Current provider version is missing', 500)
      return { v: 1, kid: this.#keys.currentKeyId, ownerId, sessionId, sessionVersion: Number(session.version), profileId: profile.id, profileVersionId: version.id, profileVersion: Number(version.version), profilePolicyVersion: Number(profile.policyVersion), defaultGeneration: configuration.defaultGeneration, executionMode: session.executionMode, exp: Math.floor(Date.now() / 1000) + Math.max(30, Math.min(900, ttlSeconds)) } satisfies TokenPayload
    })
    const encoded = encodePayload(payload)
    return `${payload.kid}.${encoded}.${this.#sign(encoded, payload.kid)}`
  }

  async resolve(input: { readonly ownerId: number; readonly sessionId: string; readonly profileResolutionToken: string }): Promise<AgentResolvedAdmission> {
    const [keyId, encoded, signature, ...rest] = input.profileResolutionToken.split('.')
    if (!keyId || !encoded || !signature || rest.length > 0 || !safeEqual(signature, this.#sign(encoded, keyId))) throw new AgentRepositoryError('PROFILE_RESOLUTION_CHANGED', 'Profile resolution token is invalid', 409)
    let payload: TokenPayload
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload } catch { throw new AgentRepositoryError('PROFILE_RESOLUTION_CHANGED', 'Profile resolution token is invalid', 409) }
    if (payload.v !== 1 || payload.kid !== keyId || payload.ownerId !== input.ownerId || payload.sessionId !== input.sessionId || payload.exp <= Math.floor(Date.now() / 1000)) throw new AgentRepositoryError('PROFILE_RESOLUTION_CHANGED', 'Profile resolution token is stale', 409)
    return this.#knex.transaction(async transaction => {
      const session = await transaction('agentSessions').where({ id: input.sessionId, ownerId: input.ownerId, version: payload.sessionVersion, executionMode: payload.executionMode }).whereNull('deletedAt').first('providerProfileId') as { providerProfileId: string | null } | undefined
      const configuration = await this.#configuration(transaction)
      const profile = await transaction<ProfileRow>('agentProviderProfiles').where({ id: payload.profileId, currentVersionId: payload.profileVersionId, policyVersion: payload.profilePolicyVersion, status: 'enabled', conformed: true }).whereNull('deletedAt').first()
      const version = await transaction<VersionRow>('agentProviderProfileVersions').where({ id: payload.profileVersionId, profileId: payload.profileId, version: payload.profileVersion, conformed: true }).first()
      const expectedProfileId = session?.providerProfileId ?? (await transaction('agentProviderProfiles').where({ isGlobalDefault: true, status: 'enabled', conformed: true }).whereNull('deletedAt').first('id') as { id: string } | undefined)?.id
      if (!session || !profile || !version || expectedProfileId !== payload.profileId || configuration.defaultGeneration !== payload.defaultGeneration) throw new AgentRepositoryError('PROFILE_RESOLUTION_CHANGED', 'Profile resolution changed before admission', 409)
      const allowed = profile.exposureMode === 'all_agent_users' || Boolean(await transaction('agentProviderGrants').join('userGroups', 'userGroups.groupId', 'agentProviderGrants.groupId').where('agentProviderGrants.profileId', profile.id).andWhere('userGroups.userId', input.ownerId).first('agentProviderGrants.profileId'))
      if (!allowed || !version.secretReference || !await this.#secrets.has(version.secretReference, transaction)) throw new AgentRepositoryError('PROFILE_UNAVAILABLE', 'Provider profile is not available to this user', 409)
      parseJson(AgentProviderCapabilitiesSchema, version.capabilities, 'PROVIDER_PROFILE_CORRUPT')
      const policies = parseJson(AgentProviderPoliciesSchema, version.policies, 'PROVIDER_PROFILE_CORRUPT')
      const skillVersionIds = await transaction('agentSessionSkills').where({ sessionId: input.sessionId }).orderBy('ordinal').pluck<string>('skillVersionId')
      return {
        profileResolutionSha256: digest(canonicalJson(payload)),
        providerProfileVersionId: version.id,
        transportKind: version.transportKind,
        model: version.model,
        executionMode: payload.executionMode,
        profilePolicyVersion: Number(profile.policyVersion),
        defaultGeneration: configuration.defaultGeneration,
        capabilityRevision: version.capabilityRevision,
        pricingRevision: version.pricingRevision,
        promptVersion: policies.promptVersion,
        skillVersionIds,
        quota: { tokens: policies.reservationTokens, costMicros: policies.reservationCostMicros },
        quotaLimits: { dailyTokens: policies.dailyTokens, dailyCostMicros: policies.dailyCostMicros },
        reservationMilliseconds: policies.reservationMilliseconds
      }
    })
  }
}
