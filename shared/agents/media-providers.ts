import { z } from 'zod'

export const AgentMediaKindSchema = z.enum(['image', 'video', 'music', 'transcription'])
export type AgentMediaKind = z.infer<typeof AgentMediaKindSchema>
export const AgentMediaApiSchema = z.enum(['gemini-generate-content', 'gemini-interactions', 'openai-images', 'stability-images'])
export type AgentMediaApi = z.infer<typeof AgentMediaApiSchema>

export const AgentMediaInputsSchema = z.strictObject({
  images: z.boolean().default(false),
  documents: z.boolean().default(false),
  audio: z.boolean().default(false),
  video: z.boolean().default(false)
})
export type AgentMediaInputs = z.infer<typeof AgentMediaInputsSchema>

/** Implemented request formats; exact model acceptance requires explicit administrator opt-in. */
export const AGENT_PROVIDER_MEDIA_INPUT_SUPPORT = {
  'gemini-api': { images: true, documents: true, audio: true, video: true },
  'openai-chat': { images: true, documents: false, audio: true, video: false },
  'openai-responses': { images: true, documents: true, audio: false, video: false },
  openresponses: { images: true, documents: true, audio: false, video: false },
  'anthropic-messages': { images: true, documents: false, audio: false, video: false },
  'legacy-completions': { images: false, documents: false, audio: false, video: false }
} as const satisfies Readonly<Record<string, Readonly<AgentMediaInputs>>>

const NO_MEDIA_INPUTS = { images: false, documents: false, audio: false, video: false } as const
const IMAGE_MEDIA_INPUTS = { images: true, documents: false, audio: false, video: false } as const
const AUDIO_MEDIA_INPUTS = { images: false, documents: false, audio: true, video: false } as const
const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const PDF_MIME_TYPES = ['application/pdf'] as const
const GEMINI_AUDIO_MIME_TYPES = ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/flac'] as const
const CHAT_AUDIO_MIME_TYPES = ['audio/wav', 'audio/mpeg'] as const
const GEMINI_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const

/** Canonical stored MIME names, shared by upload admission and provider input policy. */
export const normalizeAgentMediaMimeType = (declaredType: string): string => {
  const parametersAt = declaredType.indexOf(';')
  const mimeType = (parametersAt === -1 ? declaredType : declaredType.slice(0, parametersAt)).toLowerCase().trim()
  return mimeType === 'audio/mp3' ? 'audio/mpeg' : mimeType === 'audio/x-wav' ? 'audio/wav' : mimeType === 'audio/m4a' ? 'audio/mp4' : mimeType
}

/** Tool references are not authority to send binaries to an LLM. */
export const agentMediaToolInputs = (config: Pick<AgentMediaProviderConfig, 'api' | 'kind'>): Readonly<AgentMediaInputs> => {
  if (
    (config.kind === 'image' && (config.api === 'gemini-generate-content' || config.api === 'openai-images')) ||
    (config.kind === 'video' && config.api === 'gemini-interactions')
  )
    return IMAGE_MEDIA_INPUTS
  if (config.kind === 'transcription' && config.api === 'gemini-generate-content') return AUDIO_MEDIA_INPUTS
  return NO_MEDIA_INPUTS
}

/** Exact implemented wire formats; provider feature hints cannot grant additional codecs. */
export const agentProviderMediaInputMimeTypes = (
  transportKind: keyof typeof AGENT_PROVIDER_MEDIA_INPUT_SUPPORT,
  inputs: Readonly<AgentMediaInputs>
): readonly string[] => {
  const support = AGENT_PROVIDER_MEDIA_INPUT_SUPPORT[transportKind]
  const mimeTypes: string[] = []
  if (inputs.images && support.images) mimeTypes.push(...IMAGE_MIME_TYPES)
  if (inputs.documents && support.documents) mimeTypes.push(...PDF_MIME_TYPES)
  if (inputs.audio && support.audio) mimeTypes.push(...(transportKind === 'gemini-api' ? GEMINI_AUDIO_MIME_TYPES : CHAT_AUDIO_MIME_TYPES))
  if (inputs.video && support.video) mimeTypes.push(...GEMINI_VIDEO_MIME_TYPES)
  return mimeTypes
}

const SafeText = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(value => {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code <= 0x1f || code === 0x7f) return false
    }
    return true
  }, 'Control characters are not allowed')
const Model = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9.-]*$/u)
const PositiveMicros = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const TokenPricingRevision = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}\|[0-9]{1,15}\|[0-9]{1,15}$/u)
  .refine(
    value =>
      value
        .split('|')
        .slice(1)
        .every(rate => Number.isSafeInteger(Number(rate)) && Number(rate) > 0),
    'Token rates must be positive safe integers'
  )
const Pricing = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tokens'), pricingRevision: TokenPricingRevision, textOutputMicrosPerMillionTokens: PositiveMicros.optional() }),
  z.strictObject({ kind: z.literal('fixed'), pricingRevision: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u), costMicros: PositiveMicros })
])

export const AgentMediaProviderConfigSchema = z
  .strictObject({
    kind: AgentMediaKindSchema,
    api: AgentMediaApiSchema,
    model: Model,
    baseUrl: z.string().min(1).max(255),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    maxInputTokens: z.number().int().positive().max(10_000_000),
    maxOutputTokens: z.number().int().positive().max(1_000_000),
    pricing: Pricing
  })
  .superRefine((config, context) => {
    const issue = (path: string, message: string): void => {
      context.addIssue({ code: 'custom', path: [path], message })
    }
    const google = config.api === 'gemini-generate-content' || config.api === 'gemini-interactions'
    const baseUrl = google
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : config.api === 'openai-images'
        ? 'https://api.openai.com/v1'
        : 'https://api.stability.ai/v2beta'
    if (config.baseUrl !== baseUrl) issue('baseUrl', 'Media requires the exact official API base URL')
    let supported = false
    if (config.api === 'gemini-generate-content') {
      supported =
        config.kind === 'image'
          ? /^gemini-[a-z0-9][a-z0-9.-]*$/u.test(config.model)
          : config.kind === 'transcription' &&
            /^gemini-\d+(?:\.\d+)*-(?:flash|pro|transcribe)(?:-[a-z0-9]+)*$/u.test(config.model) &&
            !/(?:^|-)image(?:-|$)/u.test(config.model)
    } else if (config.api === 'gemini-interactions') {
      supported =
        config.kind === 'video'
          ? ['gemini-omni-1.1-flash', 'gemini-omni-flash-preview'].includes(config.model)
          : config.kind === 'music' && ['lyria-3-clip-preview', 'lyria-3-pro-preview', 'lyria-3.5'].includes(config.model)
    } else if (config.api === 'openai-images') {
      supported = config.kind === 'image' && (/^gpt-image-\d+(?:\.\d+)*(?:-[a-z0-9]+)*$/u.test(config.model) || config.model === 'chatgpt-image-latest')
    } else supported = config.kind === 'image' && config.model === 'stable-image-core'
    if (!supported) issue('model', 'Model and operation are not supported by the selected media API')
    if ((config.kind === 'music' || config.api === 'stability-images') && config.pricing.kind !== 'fixed')
      issue('pricing', 'This media operation requires fixed pricing')
    if (config.kind === 'video' && (config.pricing.kind !== 'tokens' || config.pricing.textOutputMicrosPerMillionTokens === undefined))
      issue('pricing', 'Video requires token pricing with a text output rate')
    if (config.kind !== 'video' && config.pricing.kind === 'tokens' && config.pricing.textOutputMicrosPerMillionTokens !== undefined)
      issue('pricing', 'Separate text output pricing is supported only for video')
  })
export type AgentMediaProviderConfig = z.infer<typeof AgentMediaProviderConfigSchema>

export const AgentMediaProviderWriteSchema = z
  .strictObject({
    displayName: SafeText,
    config: AgentMediaProviderConfigSchema,
    exposureMode: z.enum(['all_agent_users', 'groups']),
    groupIds: z.array(z.number().int().positive()).max(1_000).optional(),
    secretReference: z
      .string()
      .regex(/^env:[A-Z][A-Z0-9_]{0,127}$/u)
      .nullable()
      .optional(),
    secretValue: z
      .string()
      .min(1)
      .max(65_536)
      .refine(value => value.trim() === value && !value.includes('\0'), 'Credential must not contain surrounding whitespace or NUL')
      .nullable()
      .optional()
  })
  .superRefine((value, context) => {
    if (value.secretReference != null && value.secretValue !== undefined)
      context.addIssue({ code: 'custom', path: ['secretValue'], message: 'Provide either a credential or a secret reference, not both' })
    if (value.exposureMode === 'groups' && !value.groupIds?.length)
      context.addIssue({ code: 'custom', path: ['groupIds'], message: 'Group-restricted media requires at least one group' })
    if (value.exposureMode === 'all_agent_users' && value.groupIds?.length)
      context.addIssue({ code: 'custom', path: ['groupIds'], message: 'Unrestricted media must not carry group grants' })
  })
export type AgentMediaProviderWrite = z.input<typeof AgentMediaProviderWriteSchema>

export interface AgentMediaProviderActor {
  readonly id: number
  readonly authVersion: number
}
export interface AgentMediaProviderView {
  readonly id: string
  readonly profileVersionId: string
  readonly revision: number
  readonly displayName: string
  readonly config: AgentMediaProviderConfig
  readonly enabled: boolean
  readonly isDefault: boolean
  readonly exposureMode: 'all_agent_users' | 'groups'
  readonly groupIds: readonly number[]
  readonly secretConfigured: boolean
  readonly createdAt: string
  readonly updatedAt: string
}
export type AgentMediaBindings = Readonly<Partial<Record<AgentMediaKind, string>>>
