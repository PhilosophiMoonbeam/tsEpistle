import packageJson from '../package.json' with { type: 'json' }

export type ProductDefinition = {
  name: string
  version: string
  description: string
  sourceRepository: string
  upstreamName: string
  containerRepository: string
  upstreamVersion: string
  independentFork: true
  modifiedAt: string
}

export type BuildIdentity = {
  revision: string
  date: string
}

export type ProductMetadata = ProductDefinition & BuildIdentity & {
  upstreamBase: string
  sourceUrl: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const requireString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`package.json product.${key} must be a non-empty string`)
  }
  return value
}

const readProductDefinition = (): ProductDefinition => {
  const rawPackage = packageJson as unknown as Record<string, unknown>
  const rawProduct = rawPackage.product
  if (!isRecord(rawProduct)) throw new Error('package.json product metadata is missing')
  if (rawProduct.independentFork !== true) throw new Error('package.json product.independentFork must be true')

  const definition: ProductDefinition = {
    name: requireString(rawProduct, 'name'),
    version: requireString(rawPackage, 'version'),
    description: requireString(rawPackage, 'description'),
    sourceRepository: requireString(rawProduct, 'sourceRepository'),
    containerRepository: requireString(rawProduct, 'containerRepository'),
    upstreamName: requireString(rawProduct, 'upstreamName'),
    upstreamVersion: requireString(rawProduct, 'upstreamVersion'),
    independentFork: true,
    modifiedAt: requireString(rawProduct, 'modifiedAt')
  }

  if (requireString(rawProduct, 'version') !== definition.version) {
    throw new Error('package.json version and product.version must match')
  }
  return Object.freeze(definition)
}

export const productDefinition = readProductDefinition()

export const createProductMetadata = (build: BuildIdentity): ProductMetadata => {
  if (!/^[0-9a-f]{40}$/.test(build.revision)) {
    throw new Error('Build revision must be a full lowercase Git commit SHA')
  }
  if (!Number.isFinite(Date.parse(build.date))) {
    throw new Error('Build date must be an ISO-8601 timestamp')
  }

  return Object.freeze({
    ...productDefinition,
    revision: build.revision,
    date: new Date(build.date).toISOString(),
    upstreamBase: `${productDefinition.upstreamName} ${productDefinition.upstreamVersion}`,
    sourceUrl: `${productDefinition.sourceRepository}/tree/${build.revision}`
  })
}
