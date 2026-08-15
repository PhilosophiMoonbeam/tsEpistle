import {
  BUILTIN_CONTENT_EXTENSIONS,
  type ContentExtensionDefinition,
  type ContentExtensionEnvelope
} from '../../shared/content-extensions.ts'
import { renderQrContentExtension } from './qr.ts'

export interface ContentExtensionRegistration {
  definition: ContentExtensionDefinition
  render(envelope: ContentExtensionEnvelope): Promise<string>
}

const definitionByKey = Object.fromEntries(
  BUILTIN_CONTENT_EXTENSIONS.map(definition => [definition.key, definition])
) as Record<string, ContentExtensionDefinition>

const rendererByKey: Record<string, ContentExtensionRegistration['render']> = {
  qr: renderQrContentExtension
}

export const getContentExtensionRegistration = (key: string): ContentExtensionRegistration | undefined => {
  const definition = definitionByKey[key]
  const render = rendererByKey[key]
  return definition && render ? { definition, render } : undefined
}
