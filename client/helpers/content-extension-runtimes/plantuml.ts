import { hydrateRemoteDiagram } from './remote-diagram.ts'

export const hydratePlantUml = (figure: HTMLElement, signal: AbortSignal): (() => void) =>
  hydrateRemoteDiagram(figure, 'plantuml', signal)
