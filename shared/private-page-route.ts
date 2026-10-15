/** Interpret an already-normalized native page path; locale extraction happens before this boundary. */
export const parsePrivatePagePath = (path: string): { locale: string; path: string } | undefined => {
  const segments = path.split('/')
  const locale = segments[1]
  if (segments[0] === '_private' && locale && segments.length > 2) {
    return { locale, path: segments.slice(2).join('/') }
  }
  return undefined
}
