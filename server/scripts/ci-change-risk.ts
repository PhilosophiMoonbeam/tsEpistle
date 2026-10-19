import { spawnSync } from 'node:child_process'

export function nativePostgresRequired(paths: string[] | undefined): boolean {
  if (!paths?.length) return true
  return paths.some(file => {
    // Only positively identified documentation/frontend inputs may omit native PG.
    // Shared/schema inputs remain risky even when located under the client tree.
    if (/(^|\/)(shared|schemas?|auth(?:entication|orization)?)(\/|\.)/i.test(file)) return true
    if (/(^|\/)(package\.json|bun\.lockb?|[^/]*lock\.(json|ya?ml)|[^/]*config\.[cm]?[jt]s)$/.test(file)) return true
    return !file.startsWith('client/') && !file.startsWith('docs/') && !/^[^/]+\.md$/i.test(file)
  })
}

if (import.meta.main) {
  const base = process.env.BASE_SHA
  const head = process.env.HEAD_SHA
  let paths: string[] | undefined
  if (base && head && /^[a-f0-9]{40}$/.test(base) && /^[a-f0-9]{40}$/.test(head) && !/^0+$/.test(base)) {
    const result = spawnSync('git', ['diff', '--name-only', '--no-renames', '-z', base, head], { encoding: 'utf8' })
    if (!result.error && result.status === 0) paths = result.stdout.split('\0').filter(Boolean)
  }
  console.log(`native_required=${nativePostgresRequired(paths)}`)
  console.log(`chart_changed=${paths === undefined || paths.some(file => file.startsWith('dev/helm/'))}`)
}
