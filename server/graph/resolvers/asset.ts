import graphHelper from '../../helpers/graph.ts'
import assetOperations from '../../operations/assets.ts'

interface Requester extends Express.User {
  id: number
  name: string
  email: string
}
interface ResolverContext {
  req: { user: Express.User }
}
interface ListArgs {
  folderId: number
  kind: string
}
interface FolderArgs {
  parentFolderId: number
}
interface CreateFolderArgs {
  parentFolderId: number
  slug: string
  name?: string | null
}
interface RenameAssetArgs {
  id: number
  filename?: string | null
  folderId?: number | null
}
interface DeleteAssetArgs {
  id: number
}

const normalizeRequester = (user: Express.User): Requester => {
  if (typeof user.id !== 'number' || typeof user.name !== 'string' || typeof user.email !== 'string') {
    throw new TypeError('Authenticated requester is missing an id, name, or email')
  }
  return {
    ...user,
    id: user.id,
    name: user.name,
    email: user.email
  }
}
const invalidRelocationInput = (): Error => {
  const error = new Error('Asset filename or folderId is required.')
  Object.assign(error, { name: 'ASSET_RELOCATION_INPUT', status: 400 })
  return error
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const mapRelocationError = (value: unknown): unknown => {
  const record = isObjectRecord(value) ? value : undefined
  const name = record?.name
  if (typeof name !== 'string') return value
  let status: number | undefined
  let message: string | undefined
  switch (name) {
    case 'AssetInvalid':
      status = 404
      message = 'This asset does not exist or is invalid.'
      break
    case 'AssetRenameInvalid':
      status = 400
      message = 'The new asset filename is invalid.'
      break
    case 'AssetRenameInvalidExt':
      status = 400
      message = 'The file extension cannot be changed on an existing asset.'
      break
    case 'AssetRenameCollision':
      status = 409
      message = 'Asset relocation cannot use the requested location.'
      break
    case 'AssetRenameForbidden':
    case 'AssetRenameTargetForbidden':
      status = 403
      message = 'You are not authorized to relocate this asset.'
      break
    default:
      return value
  }
  const mapped = new Error(message)
  mapped.name = name
  const code = record?.code
  const numericCode = typeof code === 'number' ? code : undefined
  Object.assign(mapped, { status, ...(numericCode === undefined ? {} : { code: numericCode }) })
  return mapped
}

const relocationStatuses: Record<string, true> = {
  pending: true,
  leased: true,
  succeeded: true,
  failed: true,
  superseded: true
}
const boundedReceiptField = (value: unknown, fallback: string, limit: number): string => {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return value.replace(/[\r\n]/g, ' ').slice(0, limit)
}

const relocationReceiptMessage = (receipt: unknown): string => {
  const record = typeof receipt === 'object' && receipt !== null ? receipt : {}
  const rawStatus = boundedReceiptField(Reflect.get(record, 'status'), 'unknown', 32)
  const status = Object.hasOwn(relocationStatuses, rawStatus) ? rawStatus : 'unknown'
  const id = boundedReceiptField(Reflect.get(record, 'id'), 'unavailable', 128)
  const rawStatusUrl = boundedReceiptField(Reflect.get(record, 'statusUrl'), 'unavailable', 256)
  const statusUrl = rawStatusUrl.startsWith('/_api/assets/relocations/') ? rawStatusUrl : 'the authorized relocation status endpoint'
  return `Asset relocation accepted. Current status: ${status}. Receipt: ${id}. Status URL: ${statusUrl}`
}

export default {
  Query: {
    async assets() {
      return {}
    }
  },
  Mutation: {
    async assets() {
      return {}
    }
  },
  AssetQuery: {
    list(_obj: unknown, args: ListArgs, context: ResolverContext) {
      return assetOperations.list({
        requester: normalizeRequester(context.req.user),
        folderId: args.folderId,
        kind: args.kind
      })
    },
    folders(_obj: unknown, args: FolderArgs, context: ResolverContext) {
      return assetOperations.listFolders({
        requester: normalizeRequester(context.req.user),
        parentFolderId: args.parentFolderId
      })
    }
  },
  AssetMutation: {
    async createFolder(_obj: unknown, args: CreateFolderArgs, context: ResolverContext) {
      try {
        await assetOperations.createFolder({
          requester: normalizeRequester(context.req.user),
          slug: args.slug,
          parentFolderId: args.parentFolderId
        })
        return { responseResult: graphHelper.generateSuccess('Asset Folder has been created successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    },
    async renameAsset(_obj: unknown, args: RenameAssetArgs, context: ResolverContext) {
      if (args.filename === undefined && args.folderId === undefined) return graphHelper.generateError(invalidRelocationInput())
      try {
        const receipt = await assetOperations.relocate({
          requester: normalizeRequester(context.req.user),
          id: args.id,
          ...(args.filename === undefined ? {} : { filename: args.filename }),
          ...(args.folderId === undefined ? {} : { folderId: args.folderId })
        })
        return { responseResult: graphHelper.generateSuccess(relocationReceiptMessage(receipt)) }
      } catch (err: unknown) {
        return graphHelper.generateError(mapRelocationError(err))
      }
    },
    async deleteAsset(_obj: unknown, args: DeleteAssetArgs, context: ResolverContext) {
      try {
        await assetOperations.remove({ requester: normalizeRequester(context.req.user), id: args.id })
        return { responseResult: graphHelper.generateSuccess('Asset has been deleted successfully.') }
      } catch (err: unknown) {
        return graphHelper.generateError(err)
      }
    }
  }
}
