import type MarkdownIt from 'markdown-it'

type PlantUmlConfig = {
  openMarker?: string
  closeMarker?: string
  imageFormat?: string
  server?: string
}

declare const plantuml: {
  init: (markdown: MarkdownIt, config: PlantUmlConfig) => void
}

export default plantuml
