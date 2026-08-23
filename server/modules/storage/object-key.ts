export function storageObjectKey(prefix: unknown, relativePath: string): string {
  const segments = typeof prefix === 'string'
    ? prefix.split('/').map(segment => segment.trim()).filter(segment => segment && segment !== '.' && segment !== '..')
    : []
  const normalizedPath = relativePath.replace(/^\/+/, '')
  return segments.length > 0 ? `${segments.join('/')}/${normalizedPath}` : normalizedPath
}

export function encodeS3CopySource(bucket: string, key: string): string {
  return [bucket, ...key.split('/')].map(segment => encodeURIComponent(segment)).join('/')
}
