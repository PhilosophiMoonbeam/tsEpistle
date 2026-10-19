import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [mode, directory] = process.argv.slice(2)
if ((mode !== 'prepare' && mode !== 'verify') || !directory || process.argv.length !== 4) {
  throw new Error('Usage: check-release-candidate.ts prepare|verify DIRECTORY')
}
const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const assert = (valid: unknown, message: string): void => {
  if (!valid) throw new Error(message)
}
const revision = required('APP_REVISION')
const ref = required('APP_REF')
const runId = required('PRIVATE_RUN_ID')
const runAttempt = required('PRIVATE_RUN_ATTEMPT')
const controllerRevision = required('PRIVATE_CONTROLLER_REVISION')
assert(/^[0-9a-f]{40}$/.test(controllerRevision), 'Private controller revision must be a full SHA')
assert(/^[0-9a-f]{40}$/.test(revision), 'Application revision must be a full SHA')
assert(/^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(ref), 'Candidate must name a concrete release tag')
assert(/^[1-9][0-9]*$/.test(runId) && /^[1-9][0-9]*$/.test(runAttempt), 'Private run identity is required')
assert(Object.hasOwn(process.env, 'REQUEST_ID'), 'REQUEST_ID must explicitly identify the relay or private manual request')
const requestId = process.env.REQUEST_ID!
const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim()
assert(git('rev-parse', mode === 'prepare' ? 'HEAD' : `${ref}^{commit}`) === revision, 'Authorized source/tag does not match requested application revision')
const pkg = JSON.parse(git('show', `${revision}:package.json`))
const imageRepository = 'ghcr.io/philosophimoonbeam/wiki'
assert(pkg.product?.sourceRepository === 'https://github.com/PhilosophiMoonbeam/tsEpistle', 'Unexpected application source repository')
assert(pkg.product?.containerRepository === imageRepository, 'Unexpected application image repository')
assert(pkg.product?.version === pkg.version && ref === `refs/tags/v${pkg.version}`, 'Tag/product version mismatch')
const releaseFiles = [
  'tsepistle-linux.tar.gz', 'tsepistle-source.tar.gz', `tsepistle-${pkg.version}.tgz`,
  'tsepistle.spdx.json', 'wiki-agent-browser.spdx.json', 'third-party-licenses.json',
  'release-manifest.json', 'SHA256SUMS'
]
const descriptors = ['image-amd64-descriptor.txt', 'image-arm64-descriptor.txt', 'agent-browser-amd64-descriptor.txt', 'agent-browser-arm64-descriptor.txt']
const metadata = ['release-image-metadata.json', 'agent-browser-image-metadata.json'] as const
const files = [...releaseFiles, ...descriptors, ...metadata].sort()
const root = path.resolve(directory)
const read = (name: string): Buffer => {
  const file = path.join(root, name)
  assert(fs.lstatSync(file).isFile(), `Candidate entry must be a regular file: ${name}`)
  return fs.readFileSync(file)
}
const json = (name: string) => JSON.parse(read(name).toString())
if (mode === 'prepare') {
  fs.mkdirSync(root, { recursive: false })
  for (const name of releaseFiles) fs.copyFileSync(name, path.join(root, name))
  for (const name of descriptors) fs.copyFileSync(path.join('image-descriptors', name), path.join(root, name))
  for (const name of metadata) fs.copyFileSync(name, path.join(root, name))
}
assert(fs.lstatSync(root).isDirectory(), 'Candidate root must be a real directory')
const expectedFiles = mode === 'prepare' ? files : [...files, 'release-candidate.json'].sort()
assert(JSON.stringify(fs.readdirSync(root).sort()) === JSON.stringify(expectedFiles), 'Candidate must contain exactly the declared release inputs')
const measuredFiles = new Map<string, { name: string; sha256: string; bytes: number }>()
for (const name of files) {
  const file = path.join(root, name)
  const metadata = fs.lstatSync(file)
  assert(metadata.isFile(), `Candidate entry must be a regular file: ${name}`)
  const digest = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk)
  measuredFiles.set(name, { name, sha256: digest.digest('hex'), bytes: metadata.size })
}
if (mode === 'prepare') {
  fs.writeFileSync(path.join(root, 'release-candidate.json'), `${JSON.stringify({
    schemaVersion: 1,
    applicationRepository: 'PhilosophiMoonbeam/tsEpistle', revision, ref,
    controllerRepository: 'PhilosophiMoonbeam/tsEpistle-ci', controllerRevision,
    runId, runAttempt, requestId,
    files: [...measuredFiles.values()]
  }, null, 2)}\n`)
}
const receipt = json('release-candidate.json')
assert(receipt.schemaVersion === 1 && receipt.applicationRepository === 'PhilosophiMoonbeam/tsEpistle' && receipt.controllerRepository === 'PhilosophiMoonbeam/tsEpistle-ci', 'Invalid release candidate authority')
assert(receipt.revision === revision && receipt.ref === ref && receipt.runId === runId && receipt.runAttempt === runAttempt && receipt.requestId === requestId, 'Candidate does not belong to this exact source/request/private run attempt')
assert(receipt.controllerRevision === controllerRevision, 'Candidate does not belong to the exact private controller revision')
assert(Array.isArray(receipt.files) && JSON.stringify(receipt.files.map((entry: { name: string }) => entry.name)) === JSON.stringify(files), 'Receipt file set mismatch')
for (const entry of receipt.files) {
  const measured = measuredFiles.get(entry.name)!
  assert(entry.sha256 === measured.sha256 && entry.bytes === measured.bytes, `Candidate hash/size mismatch: ${entry.name}`)
}
const manifest = json('release-manifest.json')
assert(manifest.schemaVersion === 1 && manifest.product?.name === pkg.product.name && manifest.product?.version === pkg.version, 'Manifest product mismatch')
assert(manifest.release?.revision === revision && manifest.release?.tag === ref.slice('refs/tags/'.length) && manifest.release?.sourceRepository === pkg.product.sourceRepository, 'Manifest source binding mismatch')
assert(manifest.release?.buildDate === new Date(git('show', '-s', '--format=%cI', revision)).toISOString(), 'Manifest build date must match source commit')
const payloadFiles = releaseFiles.filter(name => !['release-manifest.json', 'SHA256SUMS'].includes(name)).sort()
assert(Array.isArray(manifest.artifacts) && JSON.stringify(manifest.artifacts.map((entry: { name: string }) => entry.name).sort()) === JSON.stringify(payloadFiles), 'Manifest artifact set mismatch')
for (const artifact of manifest.artifacts) {
  const measured = measuredFiles.get(artifact.name)!
  assert(artifact.sha256 === measured.sha256 && artifact.bytes === measured.bytes, `Manifest hash/size mismatch: ${artifact.name}`)
}
const expectedChecksums = [...payloadFiles, 'release-manifest.json'].sort().map(name => `${measuredFiles.get(name)!.sha256}  ${name}`).join('\n') + '\n'
assert(read('SHA256SUMS').toString() === expectedChecksums, 'SHA256SUMS must bind exactly the public release payload and manifest')
for (const [key, repository, metadataFile] of [
  ['containerImage', imageRepository, metadata[0]],
  ['agentBrowserImage', `${imageRepository}-agent-browser`, metadata[1]]
] as const) {
  const image = manifest[key]
  assert(/^sha256:[0-9a-f]{64}$/.test(image?.digest) && image.reference === `${repository}@${image.digest}`, `Invalid ${key} reference`)
  assert(json(metadataFile)['containerimage.descriptor']?.digest === image.digest, `${key} manifest metadata mismatch`)
}
for (const name of descriptors) {
  const repository = name.startsWith('agent-browser-') ? `${imageRepository}-agent-browser` : imageRepository
  assert(new RegExp(`^${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@sha256:[0-9a-f]{64}\\n?$`).test(read(name).toString()), `Invalid image descriptor: ${name}`)
}
if (mode === 'verify' && process.env.GITHUB_ENV) {
  const values = {
    APP_REVISION: revision, APP_REF: ref, APP_REF_NAME: ref.slice('refs/tags/'.length),
    RELEASE_VERSION: pkg.version, IMAGE_REPOSITORY: imageRepository,
    IMAGE_DIGEST: manifest.containerImage.digest,
    AGENT_BROWSER_IMAGE_DIGEST: manifest.agentBrowserImage.digest
  }
  fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''))
}
console.log(`Release candidate valid: ${revision} ${ref} private run ${runId}/${runAttempt}`)
