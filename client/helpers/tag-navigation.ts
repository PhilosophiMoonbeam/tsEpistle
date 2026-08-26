const TAGS_PATH_PREFIX = '/t'

export function tagSelectionFromPath (path: string): string[] {
  const segments = path.split('/').filter(Boolean)
  if (segments[0] === TAGS_PATH_PREFIX.slice(1)) segments.shift()
  return segments.map(segment => decodeURIComponent(segment))
}

export function pathFromTagSelection (selection: string[]): string {
  const encodedSelection = selection.map(tag => encodeURIComponent(tag)).join('/')
  return encodedSelection.length > 0 ? `${TAGS_PATH_PREFIX}/${encodedSelection}` : TAGS_PATH_PREFIX
}
