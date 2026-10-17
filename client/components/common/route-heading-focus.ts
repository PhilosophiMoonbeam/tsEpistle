/**
 * Move focus to the main heading after an in-app route change, so keyboard and
 * screen-reader users land on the new content. Never call it for the first
 * route: on page load the browser already starts at the top of the document,
 * and an early focus jump would announce the heading twice.
 */
export const focusRouteHeading = (container: Element | null | undefined, focusAtNavigation: Element | null = null): boolean => {
  const heading = container?.querySelector<HTMLElement>('h1')
  if (!heading || heading.closest('[inert], [aria-hidden="true"]')) return false
  const active = heading.ownerDocument.activeElement
  // An entering view can already accept input before its transition finishes.
  // Keep that newly claimed focus, but still announce a reused view whose old
  // control retained focus across the route change.
  if (active && active !== focusAtNavigation && active !== heading && container?.contains(active)) return false
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
  heading.focus({ preventScroll: true })
  return true
}
