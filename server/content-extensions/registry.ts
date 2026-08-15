import {
  BUILTIN_CONTENT_EXTENSIONS,
  type ContentExtensionDefinition,
  type ContentExtensionEnvelope
} from '../../shared/content-extensions.ts'
import { renderDiagramContentExtension } from './diagram.ts'
import { renderGalleryContentExtension } from './gallery.ts'
import { renderIndexContentExtension } from './index.ts'
import { renderInfoboxContentExtension } from './infobox.ts'
import { renderKrokiContentExtension } from './kroki.ts'
import { renderMapContentExtension } from './map.ts'
import { renderMediaContentExtension } from './media.ts'
import { renderPdfContentExtension } from './pdf.ts'
import { renderPlantUmlContentExtension } from './plantuml.ts'
import { renderQrContentExtension } from './qr.ts'
import { renderSpoilerContentExtension } from './spoiler.ts'
import { renderTabsContentExtension } from './tabs.ts'
import { renderYoutubeContentExtension } from './youtube.ts'

export interface ContentExtensionRegistration {
  definition: ContentExtensionDefinition
  render(envelope: ContentExtensionEnvelope): Promise<string>
}

const definitionByKey = Object.fromEntries(
  BUILTIN_CONTENT_EXTENSIONS.map(definition => [definition.key, definition])
) as Record<string, ContentExtensionDefinition>

const rendererByKey: Record<string, ContentExtensionRegistration['render']> = {
  diagram: renderDiagramContentExtension,
  gallery: renderGalleryContentExtension,
  index: renderIndexContentExtension,
  infobox: renderInfoboxContentExtension,
  kroki: renderKrokiContentExtension,
  map: renderMapContentExtension,
  media: renderMediaContentExtension,
  pdf: renderPdfContentExtension,
  plantuml: renderPlantUmlContentExtension,
  qr: renderQrContentExtension,
  spoiler: renderSpoilerContentExtension,
  tabs: renderTabsContentExtension,
  youtube: renderYoutubeContentExtension
}

export const getContentExtensionRegistration = (key: string): ContentExtensionRegistration | undefined => {
  const definition = definitionByKey[key]
  const render = rendererByKey[key]
  return definition && render ? { definition, render } : undefined
}
