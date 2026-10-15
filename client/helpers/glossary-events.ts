import { createEventBus } from './simple-event-bus'

export type OpenGlossaryInput = { locale?: string; term?: string }
const glossaryBus = createEventBus<[OpenGlossaryInput]>()
const OPEN_GLOSSARY = 'openGlossary'
export function openGlossary(input: OpenGlossaryInput = {}): void {
  glossaryBus.emit(OPEN_GLOSSARY, input)
}
export function onOpenGlossary(handler: (input: OpenGlossaryInput) => void): () => void {
  glossaryBus.on(OPEN_GLOSSARY, handler)
  return () => glossaryBus.off(OPEN_GLOSSARY, handler)
}
