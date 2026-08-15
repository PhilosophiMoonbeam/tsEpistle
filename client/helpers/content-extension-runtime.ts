type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Cleanup = () => void
let tabsInstance = 0





const tabsCleanup = (tabs: HTMLElement): Cleanup => {
  const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('.content-extension-tabs__tab')]
  const panels = [...tabs.querySelectorAll<HTMLElement>('.content-extension-tabs__panel')]
  if (buttons.length < 2 || buttons.length !== panels.length) return () => {}
  const instance = ++tabsInstance
  let active = Number(tabs.dataset.tabsActive)
  if (!Number.isInteger(active) || active < 0 || active >= buttons.length) active = 0

  const select = (index: number, focus: boolean): void => {
    active = index
    buttons.forEach((button, buttonIndex) => {
      const selected = buttonIndex === index
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    })
    panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== index })
    if (focus) buttons[index]?.focus()
  }
  const clickHandlers = buttons.map((button, index) => {
    const buttonId = `content-extension-tabs-${instance}-tab-${index}`
    const panelId = `content-extension-tabs-${instance}-panel-${index}`
    button.id = buttonId
    button.hidden = false
    button.setAttribute('aria-controls', panelId)
    panels[index]!.id = panelId
    panels[index]!.setAttribute('aria-labelledby', buttonId)
    panels[index]!.querySelector<HTMLElement>('.content-extension-tabs__fallback-label')?.setAttribute('hidden', '')
    const handler = (): void => select(index, false)
    button.addEventListener('click', handler)
    return { button, handler }
  })
  const onKeydown = (event: KeyboardEvent): void => {
    let next: number | null = null
    if (event.key === 'ArrowRight') next = (active + 1) % buttons.length
    if (event.key === 'ArrowLeft') next = (active - 1 + buttons.length) % buttons.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = buttons.length - 1
    if (next === null) return
    event.preventDefault()
    select(next, true)
  }
  const tablist = tabs.querySelector<HTMLElement>('.content-extension-tabs__list')
  tablist?.addEventListener('keydown', onKeydown)
  select(active, false)

  return () => {
    for (const { button, handler } of clickHandlers) button.removeEventListener('click', handler)
    tablist?.removeEventListener('keydown', onKeydown)
  }
}

const spoilerCleanup = (spoiler: HTMLElement): Cleanup => {
  const button = spoiler.querySelector<HTMLButtonElement>('.content-extension-spoiler__toggle')
  const content = spoiler.querySelector<HTMLElement>('.content-extension-spoiler__content')
  if (!button || !content) return () => {}
  let expanded = false
  const update = (): void => {
    button.setAttribute('aria-expanded', String(expanded))
    content.hidden = !expanded
  }
  const toggle = (): void => {
    expanded = !expanded
    update()
  }
  button.hidden = false
  button.addEventListener('click', toggle)
  update()
  return () => button.removeEventListener('click', toggle)
}













export const hydrateContentExtensions = (
  root: ParentNode,
  fetchImpl: FetchLike = fetch
): Cleanup => {
  const controller = new AbortController()
  const cleanups: Cleanup[] = []
  for (const tabs of root.querySelectorAll<HTMLElement>('.content-extension--tabs')) cleanups.push(tabsCleanup(tabs))
  for (const spoiler of root.querySelectorAll<HTMLElement>('.content-extension--spoiler')) cleanups.push(spoilerCleanup(spoiler))

  const galleries = [...root.querySelectorAll<HTMLElement>('.content-extension--gallery')]
  if (galleries.length > 0) void import('./content-extension-runtimes/gallery.ts').then(({ hydrateGallery }) => {
    if (controller.signal.aborted) return
    for (const gallery of galleries) cleanups.push(hydrateGallery(gallery))
  }, () => {})
  const indexes = [...root.querySelectorAll<HTMLElement>('.content-extension--index')]
  if (indexes.length > 0) void import('./content-extension-runtimes/index.ts').then(({ hydratePageIndex }) => {
    if (controller.signal.aborted) return
    for (const index of indexes) void hydratePageIndex(index, fetchImpl, controller.signal)
  }, () => {
    for (const index of indexes) {
      index.setAttribute('aria-busy', 'false')
      const status = index.querySelector<HTMLElement>('.content-extension-index__status')
      if (status) status.textContent = 'Page index is temporarily unavailable.'
    }
  })
  const pdfs = [...root.querySelectorAll<HTMLElement>('.content-extension--pdf')]
  if (pdfs.length > 0) void import('./content-extension-runtimes/pdf.ts').then(({ hydratePdf }) => {
    if (controller.signal.aborted) return
    for (const pdf of pdfs) cleanups.push(hydratePdf(pdf))
  }, () => {})
  const youtubeFigures = [...root.querySelectorAll<HTMLElement>('.content-extension--youtube')]
  if (youtubeFigures.length > 0) void import('./content-extension-runtimes/youtube.ts').then(({ hydrateYoutube }) => {
    if (controller.signal.aborted) return
    for (const figure of youtubeFigures) cleanups.push(hydrateYoutube(figure))
  }, () => {})
  const maps = [...root.querySelectorAll<HTMLElement>('.content-extension--map')]
  if (maps.length > 0) void import('./content-extension-runtimes/map.ts').then(({ hydrateMap }) => {
    if (controller.signal.aborted) return
    for (const map of maps) cleanups.push(hydrateMap(map))
  }, () => {})
  const krokiFigures = [...root.querySelectorAll<HTMLElement>('.content-extension--kroki')]
  if (krokiFigures.length > 0) void import('./content-extension-runtimes/kroki.ts').then(({ hydrateKroki }) => {
    if (controller.signal.aborted) return
    for (const figure of krokiFigures) cleanups.push(hydrateKroki(figure, controller.signal))
  }, () => {})
  const plantUmlFigures = [...root.querySelectorAll<HTMLElement>('.content-extension--plantuml')]
  if (plantUmlFigures.length > 0) void import('./content-extension-runtimes/plantuml.ts').then(({ hydratePlantUml }) => {
    if (controller.signal.aborted) return
    for (const figure of plantUmlFigures) cleanups.push(hydratePlantUml(figure, controller.signal))
  }, () => {})
  const mermaidFigures = [...root.querySelectorAll<HTMLElement>('.content-extension--diagram')]
  if (mermaidFigures.length > 0) void import('./content-extension-runtimes/mermaid.ts').then(({ hydrateMermaid }) => {
    if (controller.signal.aborted) return
    for (const figure of mermaidFigures) void hydrateMermaid(figure, controller.signal)
  }, () => {})

  return () => {
    controller.abort()
    for (const cleanup of cleanups) cleanup()
  }
}
