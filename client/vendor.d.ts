declare module 'epic-spinners' {
  type SpinnerComponent = import('vue').Component

  export const AtomSpinner: SpinnerComponent
  export const BreedingRhombusSpinner: SpinnerComponent
  export const FingerprintSpinner: SpinnerComponent
  export const LoopingRhombusesSpinner: SpinnerComponent
  export const OrbitSpinner: SpinnerComponent
  export const SelfBuildingSquareSpinner: SpinnerComponent
  export const SemipolarSpinner: SpinnerComponent
}



declare module 'velocity-animate' {
  type VelocityTarget = Element | Element[] | NodeListOf<Element> | null | undefined
  type VelocityOptions = {
    container?: Element
    duration?: number
    offset?: string | number
  }

  export default function velocity (
    target: VelocityTarget,
    action: 'scroll' | 'stop',
    options?: VelocityOptions | boolean
  ): void
}

type MarkdownItPlugin = (md: import('markdown-it'), options?: unknown) => void

declare module 'markdown-it-attrs' {
  const plugin: MarkdownItPlugin
  export default plugin
}


declare module 'markdown-it-emoji' {
  export const full: MarkdownItPlugin
}

declare module 'markdown-it-task-lists' {
  const plugin: MarkdownItPlugin
  export default plugin
}

declare module 'markdown-it-expand-tabs' {
  const plugin: MarkdownItPlugin
  export default plugin
}

declare module 'markdown-it-abbr' {
  const plugin: MarkdownItPlugin
  export default plugin
}

declare module 'markdown-it-sup' {
  const plugin: MarkdownItPlugin
  export default plugin
}

declare module 'markdown-it-sub' {
  const plugin: MarkdownItPlugin
  export default plugin
}

declare module 'markdown-it-mark' {
  const plugin: MarkdownItPlugin
  export default plugin
}

declare module 'markdown-it-footnote' {
  const plugin: MarkdownItPlugin
  export default plugin
}

declare module 'markdown-it-imsize' {
  const plugin: MarkdownItPlugin
  export default plugin
}
