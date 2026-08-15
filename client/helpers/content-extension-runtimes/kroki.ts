import { hydrateRemoteDiagram } from './remote-diagram.ts'

export const hydrateKroki = (figure: HTMLElement, signal: AbortSignal): (() => void) =>
  hydrateRemoteDiagram(figure, 'kroki', signal)
