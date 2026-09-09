const DESCRIPTOR_TEMPORARY_LEAF = /^\.[^/]+\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu

function pathParts (relativePath: string): string[] {
  if (typeof relativePath !== 'string') return []
  return relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
}

/** True for Git metadata components at any depth, independent of case. */
export function isStorageGitMetadataPath (relativePath: string): boolean {
  return pathParts(relativePath).some(part => part.toLowerCase() === '.git')
}

/** True only for the reserved backup namespaces directly below the storage root. */
export function isStorageReservedPath (relativePath: string): boolean {
  const first = pathParts(relativePath)[0]
  return first === '_daily' || first === '_manual'
}

/** True for temporary leaves created by descriptor-confined atomic writes. */
export function isStorageTemporaryPath (relativePath: string): boolean {
  const parts = pathParts(relativePath)
  const leaf = parts.at(-1)
  return leaf !== undefined && DESCRIPTOR_TEMPORARY_LEAF.test(leaf)
}

/**
 * Storage paths that are never content-addressable user assets. This is a pure
 * namespace policy; callers choose whether to prune a particular subset while
 * inventorying internal operational files.
 */
export function isStorageInternalPath (relativePath: string): boolean {
  return isStorageGitMetadataPath(relativePath) || isStorageReservedPath(relativePath) || isStorageTemporaryPath(relativePath)
}
