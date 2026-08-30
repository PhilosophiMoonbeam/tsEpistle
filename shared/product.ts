import { z } from 'zod'

export const ProductMetadataSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    sourceRepository: z.string().min(1),
    upstreamName: z.string().min(1),
    containerRepository: z.string().min(1),
    upstreamVersion: z.string().min(1),
    independentFork: z.literal(true),
    modifiedAt: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    date: z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
    upstreamBase: z.string().min(1),
    sourceUrl: z.string().min(1)
  })
  .refine(metadata => metadata.upstreamBase === `${metadata.upstreamName} ${metadata.upstreamVersion}`, {
    path: ['upstreamBase']
  })
  .refine(metadata => metadata.sourceUrl === `${metadata.sourceRepository}/tree/${metadata.revision}`, {
    path: ['sourceUrl']
  })

export type ProductMetadata = z.infer<typeof ProductMetadataSchema>

export type ProductDefinition = Pick<
  ProductMetadata,
  'name' | 'version' | 'description' | 'sourceRepository' | 'upstreamName' | 'containerRepository' | 'upstreamVersion' | 'independentFork' | 'modifiedAt'
>

export type BuildIdentity = Pick<ProductMetadata, 'revision' | 'date'>
