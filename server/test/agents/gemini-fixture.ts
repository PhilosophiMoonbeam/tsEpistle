import { deriveAgentProviderResourceLimits } from '../../agents/providers/factory.ts'
import { createGeminiAxService, type GeminiAxServiceOptions } from '../../agents/providers/gemini.ts'

export const geminiFixtureService = (config: Omit<GeminiAxServiceOptions, 'limits' | 'maxOutputTokens'>) =>
  createGeminiAxService({
    ...config,
    maxOutputTokens: 32_768,
    limits: deriveAgentProviderResourceLimits(32_768)
  })
