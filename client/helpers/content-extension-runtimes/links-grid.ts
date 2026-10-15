type Cleanup = () => void

type StyleLease = { element: HTMLStyleElement; users: number }
const stylesByDocument = new WeakMap<Document, StyleLease>()

const LINKS_GRID_STYLES = `
.contents .content-extension.content-extension--links-grid > ul.content-extension-links-grid__list[role="list"],
.content-extension--links-grid .content-extension-links-grid__list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
  gap: 1rem;
  list-style: none;
  margin: 1rem 0;
  padding: 0;
}
.contents .content-extension.content-extension--links-grid > ul.content-extension-links-grid__list[role="list"] > li.content-extension-links-grid__item,
.content-extension--links-grid .content-extension-links-grid__item {
  min-width: 0;
  margin: 0;
  padding: 0;
}
.content-extension--links-grid .content-extension-links-grid__link {
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  border: 1px solid currentColor;
  border-color: color-mix(in srgb, currentColor 25%, transparent);
  border-radius: .5rem;
  overflow-wrap: anywhere;
  text-decoration: none;
}
.content-extension--links-grid .content-extension-links-grid__link:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 3px;
}
.content-extension.content-extension--links-grid img.content-extension-links-grid__image {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-radius: .5rem .5rem 0 0;
  margin: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.content-extension--links-grid .content-extension-links-grid__body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: .5rem;
  padding: 1rem;
}
.content-extension.content-extension--links-grid img.content-extension-links-grid__icon {
  width: 2rem;
  height: 2rem;
  object-fit: contain;
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.content-extension--links-grid .content-extension-links-grid__title {
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: .15em;
}
.content-extension--links-grid .content-extension-links-grid__description {
  color: inherit;
  white-space: pre-wrap;
}
.content-extension--links-grid .content-extension-links-grid__tags {
  display: flex;
  flex-wrap: wrap;
  gap: .35rem;
}
.content-extension--links-grid .content-extension-links-grid__tag {
  padding: .1rem .5rem;
  border: 1px solid currentColor;
  border-radius: 1rem;
  font-size: .875em;
}
`

export const hydrateLinksGrid = (grid: HTMLElement): Cleanup => {
  const document = grid.ownerDocument
  let lease = stylesByDocument.get(document)
  if (!lease) {
    const element = document.createElement('style')
    element.textContent = LINKS_GRID_STYLES
    document.head.append(element)
    lease = { element, users: 0 }
    stylesByDocument.set(document, lease)
  }
  const retained = lease
  retained.users += 1
  let released = false
  return () => {
    if (released) return
    released = true
    retained.users -= 1
    if (retained.users === 0) {
      retained.element.remove()
      stylesByDocument.delete(document)
    }
  }
}
