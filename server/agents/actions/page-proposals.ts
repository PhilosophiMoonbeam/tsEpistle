import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createTwoFilesPatch } from 'diff'
import type { Knex } from 'knex'
import { z } from 'zod'

import { canonicalJson } from '../../helpers/canonical-json.ts'
import { ACTION_CATALOG } from './catalog.ts'
import { type ActionAuthority, type ActionHandlerContext, ActionKernel, ActionKernelError } from './kernel.ts'
import { appendAgentEvent } from '../repository.ts'
import { applyWikiLinePatch, inspectWikiLineSnapshotToken } from '../patch/wiki-line-patch.ts'
import { getMcpProposal, getOwnedProposal, persistProposal, type PersistedProposal, type ProposalStatus } from '../proposals/repository.ts'
import { applyApprovedProposal } from '../proposals/execution.ts'

const PageSchema = z.looseObject({
  id: z.coerce.number().int().positive(),
  path: z.string(),
  locale: z.string().optional(),
  localeCode: z.string().optional(),
  title: z.string(),
  description: z.string().nullish(),
  content: z.string(),
  contentType: z.string(),
  editor: z.string().optional(),
  editorKey: z.string().optional(),
  sourceRevision: z.union([z.string(), z.number()]),
  isPublished: z.union([z.boolean(), z.number()]).optional(),
  tags: z.array(z.union([z.string(), z.looseObject({ tag: z.string() })])).optional()
})
const VersionSchema = z.looseObject({
  content: z.string(),
  title: z.string().optional(),
  description: z.string().nullish(),
  editor: z.string().optional(),
  editorKey: z.string().optional()
})
const MetadataSchema = z.strictObject({
  kind: z.enum(['create', 'patch', 'move', 'restore', 'delete']),
  operationInput: z.record(z.string(), z.unknown()),
  pageId: z.number().int().positive().nullable(),
  path: z.string(),
  locale: z.string(),
  resultIdentity: z.record(z.string(), z.unknown())
})
const RunRowSchema = z.object({ attempts: z.coerce.number().int().positive(), leaseToken: z.string().min(1), status: z.string() })
const ApprovalRowSchema = z.object({ id: z.uuid(), status: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']), expiresAt: z.union([z.string(), z.date()]) })

interface PageOperations {
  get(input: Record<string, unknown>): Promise<unknown>
  getByPath(input: Record<string, unknown>): Promise<unknown>
  getVersion(input: Record<string, unknown>): Promise<unknown>
  create(input: Record<string, unknown>): unknown
  update(input: Record<string, unknown>): unknown
  move(input: Record<string, unknown>): unknown
  restore(input: Record<string, unknown>): unknown
  remove(input: Record<string, unknown>): unknown
  authorizeMutation(input: Record<string, unknown>): Promise<void>
}

export interface PageProposalActionDependencies {
  readonly knex: Knex
  readonly operations: PageOperations
  readonly resolveRequester: (authority: ActionAuthority) => Promise<Express.User>
  readonly resolveApprover?: (userId: number) => Promise<Express.User>
  readonly snapshotSigningSecret: Uint8Array
  readonly approvalTtlMilliseconds?: number
  readonly now?: () => Date
}

interface PreparedProposal {
  readonly pageId: number | null
  readonly path: string
  readonly locale: string
  readonly baseSourceRevision: string | null
  readonly sourceCanonicalSha256: string | null
  readonly resultIdentity: Readonly<Record<string, unknown>>
  readonly diff: string | null
  readonly patchSha256: string | null
  readonly patchFormat: 'wiki-line-patch-v1' | null
  readonly patchEngineVersion: number | null
  readonly patchMetadata: Readonly<Record<string, unknown>>
  readonly summary: string
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString()
const nextRevision = (revision: string): string => /^[0-9]+$/.test(revision) ? (BigInt(revision) + 1n).toString() : revision
const pageNotFound = (error: unknown): boolean => error instanceof Error && (error.name === 'PAGE_NOT_FOUND' || ('code' in error && error.code === 'PAGE_NOT_FOUND') || error.name.includes('PageNotFound'))

const parsePage = (value: unknown) => {
  const page = PageSchema.parse(value)
  const locale = page.locale ?? page.localeCode
  if (!locale) throw new ActionKernelError('INVALID_PAGE_RESULT', 'Page operation omitted locale identity', 500)
  return {
    ...page,
    locale,
    sourceRevision: String(page.sourceRevision),
    editor: page.editor ?? page.editorKey ?? 'markdown',
    description: page.description ?? '',
    isPublished: page.isPublished ?? true,
    tags: (page.tags ?? []).map(tag => typeof tag === 'string' ? tag : tag.tag)
  }
}

const canonicalSourceHash = (source: string): string => sha256(canonicalJson({ source: source.replace(/\r\n?/g, '\n') }))
const pageDiff = (path: string, before: string, after: string): string | null => before === after ? null : createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, undefined, undefined, { context: 3 })

const requester = async (dependencies: PageProposalActionDependencies, authority: ActionAuthority): Promise<Express.User> => {
  const value = await dependencies.resolveRequester(authority)
  if (!value) throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'The action principal no longer exists', 401)
  return value
}

const readPage = async (dependencies: PageProposalActionDependencies, authority: ActionAuthority, pageId: number) => parsePage(await dependencies.operations.get({ id: pageId, requester: await requester(dependencies, authority) }))

const proposalResult = (persisted: PersistedProposal, status: ProposalStatus) => ({
  proposalId: persisted.proposal.id,
  approvalId: persisted.approval.id,
  actionName: persisted.proposal.actionName,
  status,
  inputHash: persisted.proposal.inputHash,
  diffHash: persisted.proposal.diffSha256 ?? null,
  summary: persisted.summary,
  expiresAt: iso(persisted.proposal.expiresAt)
})

const appendRunEvent = async (dependencies: PageProposalActionDependencies, authority: ActionAuthority, eventId: string, type: 'proposal.created' | 'approval.requested' | 'approval.resolved', data: Record<string, string>): Promise<void> => {
  const run = RunRowSchema.parse(await dependencies.knex('agentRuns').where({ id: authority.requestId }).first('attempts', 'leaseToken', 'status'))
  await appendAgentEvent(dependencies.knex, {
    id: eventId,
    runId: authority.requestId,
    ownerId: authority.requester.kind === 'user' ? authority.requester.userId : 0,
    attempt: run.attempts,
    leaseToken: run.leaseToken,
    type,
    data
  })
}

const waitForApproval = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, persisted: PersistedProposal): Promise<ProposalStatus> => {
  const { proposal, approval: initialApproval } = persisted
  const run = RunRowSchema.parse(await dependencies.knex('agentRuns').where({ id: context.authority.requestId }).first('attempts', 'leaseToken', 'status'))
  let awaiting = run.status === 'awaiting_approval'
  const resume = async (status: ProposalStatus): Promise<ProposalStatus> => {
    if (!awaiting) return status
    const resumed = await dependencies.knex('agentRuns')
      .where({ id: context.authority.requestId, leaseToken: run.leaseToken, status: 'awaiting_approval' })
      .whereNull('cancelRequestedAt')
      .update({ status: 'running', updatedAt: dependencies.knex.fn.now() })
    if (resumed !== 1) throw new ActionKernelError('RUN_LEASE_LOST', 'Run lease was lost while resolving approval', 409)
    await appendRunEvent(dependencies, context.authority, randomUUID(), 'approval.resolved', {
      actionCallId: context.actionCallId,
      proposalId: proposal.id,
      approvalId: initialApproval.id,
      status
    })
    return status
  }

  if (proposal.status !== 'pending') return resume(proposal.status)
  if (run.status === 'running') {
    const changed = await dependencies.knex('agentRuns')
      .where({ id: context.authority.requestId, leaseToken: run.leaseToken, status: 'running' })
      .whereNull('cancelRequestedAt')
      .update({ status: 'awaiting_approval', updatedAt: dependencies.knex.fn.now() })
    if (changed !== 1) throw new ActionKernelError('RUN_LEASE_LOST', 'Run lease was lost before approval', 409)
    awaiting = true
    await appendRunEvent(dependencies, context.authority, proposal.id, 'proposal.created', { actionCallId: context.actionCallId, proposalId: proposal.id })
    await appendRunEvent(dependencies, context.authority, initialApproval.id, 'approval.requested', { actionCallId: context.actionCallId, proposalId: proposal.id, approvalId: initialApproval.id })
  } else if (run.status !== 'awaiting_approval') {
    throw new ActionKernelError('RUN_LEASE_LOST', 'Run is not awaiting proposal approval', 409)
  }

  for (;;) {
    if (context.signal.aborted) throw new ActionKernelError('ACTION_CANCELLED', 'Action was cancelled while awaiting approval', 409)
    const approval = ApprovalRowSchema.parse(await dependencies.knex('agentApprovals').where({ id: initialApproval.id, proposalId: proposal.id }).first('id', 'status', 'expiresAt'))
    let status = approval.status
    if (status === 'pending' && new Date(approval.expiresAt).valueOf() <= (dependencies.now?.() ?? new Date()).valueOf()) {
      await dependencies.knex.transaction(async transaction => {
        await transaction('agentProposals').where({ id: proposal.id, status: 'pending' }).update({ status: 'expired' })
        await transaction('agentApprovals').where({ id: approval.id, status: 'pending' }).update({ status: 'expired', decidedAt: transaction.fn.now() })
      })
      status = 'expired'
    }
    if (status !== 'pending') return resume(status)
    await delay(250, undefined, { signal: context.signal })
  }
}

const prepareAndWait = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, input: unknown, prepared: PreparedProposal) => {
  const scope = context.authority.transport === 'agent'
    ? z.object({ sessionId: z.uuid() }).parse(await dependencies.knex('agentRuns').where({ id: context.authority.requestId }).first('sessionId'))
    : null
  const proposal = await persistProposal(dependencies.knex, {
    authority: context.authority,
    actionCallId: context.actionCallId,
    risk: ACTION_CATALOG[context.authority.actionName].descriptor.risk === 'destructive-write' ? 'destructive-write' : 'proposal',
    input,
    operation: prepared.patchMetadata,
    summary: prepared.summary,
    ...(context.authority.transport === 'agent' ? { runId: context.authority.requestId, sessionId: scope!.sessionId } : {}),
    ...(prepared.pageId === null ? {} : { pageId: prepared.pageId }),
    ...(prepared.baseSourceRevision === null ? {} : { baseSourceRevision: prepared.baseSourceRevision }),
    ...(prepared.sourceCanonicalSha256 === null ? {} : { baseCanonicalSha256: prepared.sourceCanonicalSha256 }),
    ...(prepared.patchSha256 === null ? {} : { patchSha256: prepared.patchSha256 }),
    ...(prepared.patchFormat === null ? {} : { patchFormat: prepared.patchFormat }),
    ...(prepared.patchEngineVersion === null ? {} : { patchEngineVersion: prepared.patchEngineVersion }),
    resultCanonicalSha256: sha256(canonicalJson(prepared.resultIdentity)),
    ...(prepared.diff === null ? {} : { diff: prepared.diff, diffSha256: sha256(prepared.diff), diffRendererVersion: 1 }),
    ttlMs: dependencies.approvalTtlMilliseconds ?? 15 * 60_000
  })
  const status = context.authority.transport === 'agent' ? await waitForApproval(dependencies, context, proposal) : proposal.proposal.status
  return proposalResult(proposal, status)
}

const preparePatch = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, input: { patch: { snapshotToken: string } }): Promise<PreparedProposal> => {
  const requesterScope = context.authority.requester.kind === 'user' ? `request:${context.authority.requestId}:user:${context.authority.requester.userId}` : `request:${context.authority.requestId}:api-key:${context.authority.requester.apiKeyId}:group:${context.authority.requester.groupId}`
  const snapshot = inspectWikiLineSnapshotToken(input.patch.snapshotToken, dependencies.snapshotSigningSecret, requesterScope)
  const page = await readPage(dependencies, context.authority, snapshot.pageId)
  if (page.sourceRevision !== snapshot.sourceRevision) throw new ActionKernelError('PAGE_REVISION_CONFLICT', 'Page source revision changed before proposal preparation', 409)
  const result = applyWikiLinePatch({
    pageId: page.id,
    sourceRevision: page.sourceRevision,
    source: page.content,
    requesterScope,
    signingSecret: dependencies.snapshotSigningSecret,
    patch: input.patch
  })
  const resultIdentity = { actionName: context.authority.actionName, pageId: page.id, sourceRevision: nextRevision(page.sourceRevision), contentSha256: canonicalSourceHash(result.source.text) }
  return {
    pageId: page.id,
    path: page.path,
    locale: page.locale,
    baseSourceRevision: page.sourceRevision,
    sourceCanonicalSha256: canonicalSourceHash(page.content),
    resultIdentity,
    diff: result.diff,
    patchSha256: result.patchSha256,
    patchFormat: 'wiki-line-patch-v1',
    patchEngineVersion: result.engineVersion,
    patchMetadata: { kind: 'patch', operationInput: { id: page.id, content: result.source.text, expectedSourceRevision: page.sourceRevision }, pageId: page.id, path: page.path, locale: page.locale, resultIdentity },
    summary: `Update ${page.locale}/${page.path}`
  }
}

const prepareCreate = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, input: Record<string, unknown>): Promise<PreparedProposal> => {
  const parsed = ACTION_CATALOG['pages.prepareCreate'].input.parse(input)
  const user = await requester(dependencies, context.authority)
  for (const visibility of ['private', 'public'] as const) {
    try {
      await dependencies.operations.getByPath({ path: parsed.path, locale: parsed.locale, visibility, requester: user })
      throw new ActionKernelError('PAGE_ALREADY_EXISTS', 'A page already exists at the requested path', 409)
    } catch (error: unknown) {
      if (error instanceof ActionKernelError) throw error
      if (!pageNotFound(error)) throw error
    }
  }
  const resultIdentity = { actionName: context.authority.actionName, path: parsed.path, locale: parsed.locale, contentSha256: canonicalSourceHash(parsed.content) }
  const operationInput = { path: parsed.path, locale: parsed.locale, title: parsed.title, description: parsed.description, content: parsed.content, editor: 'markdown', contentType: parsed.contentType, visibility: 'public', isPublished: parsed.isPublished, tags: parsed.tags }
  return { pageId: null, path: parsed.path, locale: parsed.locale, baseSourceRevision: null, sourceCanonicalSha256: null, resultIdentity, diff: pageDiff(`${parsed.locale}/${parsed.path}`, '', parsed.content), patchSha256: null, patchFormat: null, patchEngineVersion: null, patchMetadata: { kind: 'create', operationInput, pageId: null, path: parsed.path, locale: parsed.locale, resultIdentity }, summary: `Create ${parsed.locale}/${parsed.path}` }
}

const prepareMove = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, input: Record<string, unknown>): Promise<PreparedProposal> => {
  const parsed = ACTION_CATALOG['pages.prepareMove'].input.parse(input)
  const page = await readPage(dependencies, context.authority, parsed.pageId)
  if (page.sourceRevision !== parsed.sourceRevision) throw new ActionKernelError('PAGE_REVISION_CONFLICT', 'Page source revision changed before proposal preparation', 409)
  const resultIdentity = { actionName: context.authority.actionName, pageId: page.id, sourceRevision: nextRevision(page.sourceRevision), destinationLocale: parsed.destinationLocale, destinationPath: parsed.destinationPath }
  return { pageId: page.id, path: page.path, locale: page.locale, baseSourceRevision: page.sourceRevision, sourceCanonicalSha256: canonicalSourceHash(page.content), resultIdentity, diff: null, patchSha256: null, patchFormat: null, patchEngineVersion: null, patchMetadata: { kind: 'move', operationInput: { id: page.id, destinationLocale: parsed.destinationLocale, destinationPath: parsed.destinationPath, expectedSourceRevision: page.sourceRevision }, pageId: page.id, path: parsed.destinationPath, locale: parsed.destinationLocale, resultIdentity }, summary: `Move ${page.locale}/${page.path} to ${parsed.destinationLocale}/${parsed.destinationPath}` }
}

const prepareRestore = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, input: Record<string, unknown>): Promise<PreparedProposal> => {
  const parsed = ACTION_CATALOG['pages.prepareRestore'].input.parse(input)
  const user = await requester(dependencies, context.authority)
  const page = await readPage(dependencies, context.authority, parsed.pageId)
  if (page.sourceRevision !== parsed.sourceRevision) throw new ActionKernelError('PAGE_REVISION_CONFLICT', 'Page source revision changed before proposal preparation', 409)
  const version = VersionSchema.parse(await dependencies.operations.getVersion({ pageId: page.id, versionId: parsed.versionId, requester: user }))
  const resultIdentity = { actionName: context.authority.actionName, pageId: page.id, sourceRevision: nextRevision(page.sourceRevision), versionId: parsed.versionId, contentSha256: canonicalSourceHash(version.content) }
  return { pageId: page.id, path: page.path, locale: page.locale, baseSourceRevision: page.sourceRevision, sourceCanonicalSha256: canonicalSourceHash(page.content), resultIdentity, diff: pageDiff(`${page.locale}/${page.path}`, page.content, version.content), patchSha256: null, patchFormat: null, patchEngineVersion: null, patchMetadata: { kind: 'restore', operationInput: { pageId: page.id, versionId: parsed.versionId, expectedSourceRevision: page.sourceRevision }, pageId: page.id, path: page.path, locale: page.locale, resultIdentity }, summary: `Restore ${page.locale}/${page.path} from version ${parsed.versionId}` }
}

const prepareDelete = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, input: Record<string, unknown>): Promise<PreparedProposal> => {
  const parsed = ACTION_CATALOG['pages.prepareDelete'].input.parse(input)
  const page = await readPage(dependencies, context.authority, parsed.pageId)
  if (parsed.confirmationPath !== page.path) throw new ActionKernelError('DESTRUCTIVE_CONFIRMATION_REQUIRED', 'Deletion confirmation path does not match the page', 409)
  if (page.sourceRevision !== parsed.sourceRevision) throw new ActionKernelError('PAGE_REVISION_CONFLICT', 'Page source revision changed before proposal preparation', 409)
  const resultIdentity = { actionName: context.authority.actionName, pageId: page.id, sourceRevision: nextRevision(page.sourceRevision), deleted: true }
  return { pageId: page.id, path: page.path, locale: page.locale, baseSourceRevision: page.sourceRevision, sourceCanonicalSha256: canonicalSourceHash(page.content), resultIdentity, diff: pageDiff(`${page.locale}/${page.path}`, page.content, ''), patchSha256: null, patchFormat: null, patchEngineVersion: null, patchMetadata: { kind: 'delete', operationInput: { id: page.id, expectedSourceRevision: page.sourceRevision }, pageId: page.id, path: page.path, locale: page.locale, resultIdentity }, summary: `Delete ${page.locale}/${page.path}` }
}
const reconcileAppliedProposal = async (
  dependencies: PageProposalActionDependencies,
  metadata: z.infer<typeof MetadataSchema>,
  requester: Express.User
): Promise<unknown | null> => {
  if (metadata.kind === 'delete') {
    if (metadata.pageId === null) return null
    try {
      await dependencies.operations.get({ id: metadata.pageId, requester })
      return null
    } catch (error: unknown) {
      if (!pageNotFound(error)) throw error
    }
    const revision = Reflect.get(metadata.resultIdentity, 'sourceRevision')
    if (typeof revision !== 'string') return null
    const rows = await dependencies.knex('pageMutationOutbox')
      .where({ pageId: metadata.pageId, sourceRevision: revision, desiredState: 'absent' })
      .select('payload') as Array<{ payload: string }>
    if (rows.length === 0 || rows.some(row => {
      try {
        const payload: unknown = JSON.parse(row.payload)
        return typeof payload !== 'object' || payload === null || Reflect.get(payload, 'action') !== 'delete'
      } catch {
        return true
      }
    })) return null
    return metadata.resultIdentity
  }

  let page: ReturnType<typeof parsePage>
  try {
    page = metadata.pageId === null
      ? parsePage(await dependencies.operations.getByPath({ path: metadata.path, locale: metadata.locale, visibility: 'public', requester }))
      : parsePage(await dependencies.operations.get({ id: metadata.pageId, requester }))
  } catch (error: unknown) {
    if (pageNotFound(error)) return null
    throw error
  }
  const actionName = Reflect.get(metadata.resultIdentity, 'actionName')
  let actual: Record<string, unknown>
  if (metadata.kind === 'create') {
    actual = { actionName, path: page.path, locale: page.locale, contentSha256: canonicalSourceHash(page.content) }
  } else if (metadata.kind === 'patch') {
    actual = { actionName, pageId: page.id, sourceRevision: page.sourceRevision, contentSha256: canonicalSourceHash(page.content) }
  } else if (metadata.kind === 'move') {
    actual = { actionName, pageId: page.id, sourceRevision: page.sourceRevision, destinationLocale: page.locale, destinationPath: page.path }
  } else {
    actual = {
      actionName,
      pageId: page.id,
      sourceRevision: page.sourceRevision,
      versionId: Reflect.get(metadata.resultIdentity, 'versionId'),
      contentSha256: canonicalSourceHash(page.content)
    }
  }
  return canonicalJson(actual) === canonicalJson(metadata.resultIdentity) ? metadata.resultIdentity : null
}

const apply = async (dependencies: PageProposalActionDependencies, context: ActionHandlerContext, input: { proposalId: string, approvalId: string }) => {
  const requestingUser = await requester(dependencies, context.authority)
  const persisted = context.authority.requester.kind === 'user'
    ? await getOwnedProposal(dependencies.knex, context.authority.requester.userId, input.proposalId)
    : await getMcpProposal(dependencies.knex, context.authority.requester.apiKeyId, input.proposalId)
  const { proposal, approval } = persisted
  if (approval.id !== input.approvalId) throw new ActionKernelError('APPROVAL_MISMATCH', 'Approval does not belong to the proposal', 409)
  const expectedApproverId = context.authority.requester.kind === 'user'
    ? context.authority.requester.userId
    : approval.approvedByUserId
  if (expectedApproverId === null) throw new ActionKernelError('HUMAN_APPROVAL_REQUIRED', 'MCP proposal requires a current human approval', 403)
  const approverUser = context.authority.requester.kind === 'user'
    ? requestingUser
    : await dependencies.resolveApprover?.(expectedApproverId)
  if (!approverUser) throw new ActionKernelError('APPROVER_UNAVAILABLE', 'Proposal approver is no longer available', 403)
  const metadata = MetadataSchema.parse(JSON.parse(proposal.operation))
  const output = await applyApprovedProposal(dependencies.knex, {
    proposalId: proposal.id,
    approvalId: input.approvalId,
    authority: context.authority,
    signal: context.signal,
    reauthorize: async ({ approverUserId }) => {
      if (approverUserId !== expectedApproverId) throw new ActionKernelError('APPROVER_AUTHORITY_CHANGED', 'Proposal approver identity changed', 403)
      if (metadata.pageId !== null) {
        const requesterView = parsePage(await dependencies.operations.get({ id: metadata.pageId, requester: requestingUser }))
        const approverView = context.authority.requester.kind === 'user'
          ? requesterView
          : parsePage(await dependencies.operations.get({ id: metadata.pageId, requester: approverUser }))
        for (const current of [requesterView, approverView]) {
          if (current.sourceRevision !== String(proposal.baseSourceRevision) || canonicalSourceHash(current.content) !== proposal.baseCanonicalSha256) {
            throw new ActionKernelError('PAGE_REVISION_CONFLICT', 'Page changed after proposal approval', 409)
          }
        }
      }
      await dependencies.operations.authorizeMutation({ kind: metadata.kind, input: metadata.operationInput, requester: requestingUser })
      if (context.authority.requester.kind === 'apiKey') {
        await dependencies.operations.authorizeMutation({ kind: metadata.kind, input: metadata.operationInput, requester: approverUser })
      }
    },
    mutate: async () => {
      await context.fenceSideEffect()
      await dependencies.operations.authorizeMutation({ kind: metadata.kind, input: metadata.operationInput, requester: requestingUser })
      if (context.authority.requester.kind === 'apiKey') {
        await dependencies.operations.authorizeMutation({ kind: metadata.kind, input: metadata.operationInput, requester: approverUser })
      }
      const operationInput = { ...metadata.operationInput, requester: approverUser }
      if (metadata.kind === 'create') await dependencies.operations.create({ input: metadata.operationInput, requester: approverUser })
      else if (metadata.kind === 'patch') await dependencies.operations.update({ input: metadata.operationInput, requester: approverUser })
      else if (metadata.kind === 'move') await dependencies.operations.move({ input: metadata.operationInput, requester: approverUser })
      else if (metadata.kind === 'restore') await dependencies.operations.restore(operationInput)
      else await dependencies.operations.remove(operationInput)
      return metadata.resultIdentity
    },
    reconcile: async () => reconcileAppliedProposal(dependencies, metadata, approverUser)
  })
  let page = null
  if (metadata.kind !== 'delete') {
    const updated = metadata.pageId === null
      ? parsePage(await dependencies.operations.getByPath({ path: metadata.path, locale: metadata.locale, visibility: 'public', requester: approverUser }))
      : parsePage(await dependencies.operations.get({ id: metadata.pageId, requester: approverUser }))
    page = { id: updated.id, path: updated.path, locale: updated.locale, title: updated.title, description: updated.description, contentType: updated.contentType, sourceRevision: updated.sourceRevision }
  }
  return { proposalId: proposal.id, status: 'applied' as const, resultHash: output.resultHash, page }
}

export const registerPageProposalActions = (kernel: ActionKernel, dependencies: PageProposalActionDependencies): void => {
  kernel.register('pages.prepareCreate', async (input, context) => prepareAndWait(dependencies, context, input, await prepareCreate(dependencies, context, input as Record<string, unknown>)))
  kernel.register('pages.preparePatch', async (input, context) => prepareAndWait(dependencies, context, input, await preparePatch(dependencies, context, input as { patch: { snapshotToken: string } })))
  kernel.register('pages.prepareMove', async (input, context) => prepareAndWait(dependencies, context, input, await prepareMove(dependencies, context, input as Record<string, unknown>)))
  kernel.register('pages.prepareRestore', async (input, context) => prepareAndWait(dependencies, context, input, await prepareRestore(dependencies, context, input as Record<string, unknown>)))
  kernel.register('pages.prepareDelete', async (input, context) => prepareAndWait(dependencies, context, input, await prepareDelete(dependencies, context, input as Record<string, unknown>)))
  kernel.register('pages.applyProposal', async (input, context) => apply(dependencies, context, input as { proposalId: string, approvalId: string }))
}
