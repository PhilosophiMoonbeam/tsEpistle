import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import commonDisk, { collectStorageEntries } from '../../modules/storage/disk/common.ts'
import { openStorageRoot, type StorageRootHandle } from '../../modules/storage/local-filesystem.ts'
import {
  buildStorageImportPreview, validateStorageImportReview, withStorageImportReview,
  type StorageImportReview, type StorageImportScope
} from '../../modules/storage/import-identity.ts'
import pageHelper from '../../helpers/page.ts'
import assetHelper from '../../helpers/asset.ts'
import type { StoragePageImportOwnerRecord } from '../../helpers/storage-page-import-owner.ts'
import { bindGitPreviousContent, collectGitContentEntries, gitContentAction, resolveGitContentChoices, serializeGitContentChoices } from '../../modules/storage/git/content-visibility.ts'
import { prepareStorageImportIdentities, storageImportLocationKey, storageImportSourceKey } from '../../modules/storage/import-identity.ts'

interface ImportedPage {
  id: number
  path: string
  localeCode: string
  sourceRevision: string
  content: string
  title: string
  description: string
  isPublished: boolean
  tags: { tag: string }[]
  extra: Record<string, unknown>
}
const rows = <T extends object>(values: T[]) => {
  let selected = values
  let bound = values.length
  return {
    where(criteria: Record<string, unknown>) {
      selected = selected.filter(value => Object.entries(criteria).every(([key, expected]) => Reflect.get(value, key) === expected))
      return this
    },
    whereIn(key: string, expected: readonly unknown[]) {
      selected = selected.filter(value => expected.includes(Reflect.get(value, key)))
      return this
    },
    whereRaw(_sql: string, [maxBytes]: number[]) {
      selected = selected.filter(value => Reflect.get(value, 'data').byteLength <= maxBytes!)
      return this
    },
    select() { return this },
    orderBy() { return this },
    limit(maximum: number) { bound = maximum; return this },
    first: async () => selected[0],
    then<TResult1 = T[], TResult2 = never>(
      fulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
      rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ) { return Promise.resolve(selected.slice(0, bound)).then(fulfilled, rejected) }
  }
}
const scope: StorageImportScope = { actorId: 1, apiKeyId: null, targetKey: 'disk', configurationRevision: 'reviewed-target-revision' }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

describe('descriptor-confined storage import identity admission', () => {
  const originalWiki = globalThis.WIKI
  let directory: string
  let root: StorageRootHandle
  let pages: ImportedPage[]
  let mutations: string[]
  let owners: StoragePageImportOwnerRecord[]
  let history: Record<string, unknown>[]
  let assets: Record<string, unknown>[]
  let assetData: { id: number; data: Buffer }[]
  const ingestion = { path: 'reviewed-source' }
  const source = async (name: string, bytes = `Source ${name}`) => {
    const filename = path.join(directory, name)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, bytes)
  }
  const preview = async () => buildStorageImportPreview(await collectStorageEntries(root), ingestion, 'DISK', scope)
  const importAll = () => commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion })
  const plan = async () => prepareStorageImportIdentities(await collectStorageEntries(root), ingestion, 'DISK')
  const nativePage = (overrides: Partial<ImportedPage> = {}): ImportedPage => ({
    id: 42, localeCode: 'en', path: 'guide', sourceRevision: '7', content: 'Accepted source',
    title: 'Native title', description: '', isPublished: false, tags: [], extra: {}, ...overrides
  })
  const accept = (page: ImportedPage, sourcePath: string, bytes: string, moduleName: 'DISK' | 'GIT' = 'DISK', overrides: Partial<StoragePageImportOwnerRecord> = {}) => {
    const owner: StoragePageImportOwnerRecord = {
      pageId: page.id, nativeRevision: page.sourceRevision, nativePath: page.path, nativeLocaleCode: page.localeCode,
      sourceKey: storageImportSourceKey(root.sourceIdentity, moduleName, ingestion),
      locationKey: storageImportLocationKey(moduleName, ingestion), sourcePath, sourceSha256: digest(bytes), mapped: false,
      status: 'active', operationId: '11111111-1111-4111-8111-111111111111',
      moveBinding: null, updatedAt: new Date(), deletedAt: null, ...overrides
    }
    owners.push(owner)
    return owner
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wiki-import-identity-'))
    root = await openStorageRoot(directory)
    pages = []
    mutations = []
    owners = []
    history = []
    assets = []
    assetData = []
    globalThis.WIKI = {
      config: { lang: { code: 'en', namespaces: ['fr'] }, uploads: { maxFileSize: 1024 * 1024 } },
      logger: { info() {}, warn() {}, error() {} },
      models: {
        knex: (table: string) => rows<object>(table === 'locales' ? [{ code: 'en' }, { code: 'fr' }]
          : table === 'storagePageImportOwners' ? owners
            : table === 'pages' ? pages.map(page => ({ ...page, visibility: 'public', ownerId: null }))
              : table === 'pageHistory' ? history
                : table === 'assets' ? assets : table === 'assetData' ? assetData : []),
        users: { getRootUser: async () => ({ id: 1 }) },
        editors: { getDefaultEditor: async () => 'markdown' },
        pages: {
          query: () => rows(pages.map(page => ({ ...page, visibility: 'public', ownerId: null }))),
          getPageFromDb: async (identity: { path: string; locale: string }) => pages.find(page => page.path === identity.path && page.localeCode === identity.locale) ?? null,
          createPage: async (input: Record<string, unknown>) => {
            mutations.push('create')
            const page: ImportedPage = {
              id: pages.length + 1, path: String(input.path), localeCode: String(input.locale), sourceRevision: '1',
              content: String(input.content), title: String(input.title), description: String(input.description),
              isPublished: input.isPublished === true, tags: (input.tags as string[]).map(tag => ({ tag })), extra: { okf: input.okfMetadata }
            }
            pages.push(page)
            return page
          },
          updatePage: async (input: Record<string, unknown>) => {
            const page = pages.find(page => page.id === input.id)!
            if (page.sourceRevision !== input.expectedSourceRevision) throw new Error('Revision conflict')
            mutations.push('update')
            Object.assign(page, {
              content: input.content, title: input.title, description: input.description, isPublished: input.isPublished,
              tags: (input.tags as string[]).map(tag => ({ tag })), extra: { okf: input.okfMetadata }, sourceRevision: String(Number(page.sourceRevision) + 1)
            })
            return page
          }
        },
        assets: { upload: async () => { mutations.push('asset') } },
        assetFolders: { getAllPaths: async () => ({}) }
      }
    } as never
    commonDisk.clearFolderCache()
  })
  afterEach(async () => {
    await root.close()
    await rm(directory, { recursive: true, force: true })
    globalThis.WIKI = originalWiki
  })

  it.each([
    ['a.b.md', 'ab.md'], ['x.y/a.b.md', 'xy/ab.md'], ['a.b.md', 'valid.md'],
    ['Guide.md', 'guide.md'], ['caf\u00e9.md', 'cafe\u0301.md'], ['guide.md', 'en/guide.md'],
    ['fr/guide.md', 'FR/guide.adoc']
  ])('rejects %s and %s before any page or asset mutation', async (first, second) => {
    await source('00-sentinel.bin', 'Must not import')
    await source(first)
    await source(second)
    await expect(importAll()).rejects.toThrow(/Unsupported native page identity|Ambiguous page import/u)
    expect(mutations).toEqual([])
    expect(pages).toEqual([])
    expect(await readFile(path.join(directory, first), 'utf8')).toBe(`Source ${first}`)
  })

  it('removes only the final extension and keeps native punctuation, locales and canonical OKF identities', async () => {
    expect(pageHelper.getPagePath('x.y/a.b.md')).toEqual({ locale: 'en', path: 'x.y/a.b' })
    await source('release_notes-v2!+.md', 'Ordinary punctuation remains')
    await source('fr/guide.md', 'French')
    await source('README.md', 'Root README stays README by default')
    await source('docs/README.md', 'Nested README')
    await source('en/index.concept.md', '---\ntype: Reference\n---\n\nCanonical')
    expect((await importAll()).every(result => result.ok)).toBe(true)
    expect(pages.map(page => [page.localeCode, page.path])).toEqual(expect.arrayContaining([
      ['en', 'release_notes-v2!+'], ['fr', 'guide'], ['en', 'README'], ['en', 'docs/README'], ['en', 'index']
    ]))
    expect(pages).toHaveLength(5)
  })

  it('marks only fresh exact review as replacement and retains an accepted dotted mapping without another review', async () => {
    const page = nativePage({ path: 'ab', content: 'External replacement' })
    pages.push(page)
    await source('a.b.md', 'External replacement')
    await expect(plan()).rejects.toThrow('Unsupported native page identity')
    const reviewed = await preview()
    const review: StorageImportReview = {
      scope, snapshot: reviewed.snapshot,
      mappings: [{ sourcePath: 'a.b.md', sourceSha256: digest('External replacement'), locale: 'en', path: 'ab', existingPageId: 42, expectedSourceRevision: '7' }]
    }
    let guarded = 0
    const reviewedPlan = await withStorageImportReview(review, async () => { guarded += 1 }, plan)
    expect(guarded).toBeGreaterThan(0)
    expect(reviewedPlan.pages.get('a.b.md')).toMatchObject({
      identity: { locale: 'en', path: 'ab' }, existingPageId: 42, expectedSourceRevision: '7',
      reviewedReplacement: true, mapped: true
    })
    expect(owners).toEqual([])
    expect(page.sourceRevision).toBe('7')
    accept(page, 'a.b.md', 'External replacement', 'DISK', { mapped: true })
    const replay = await plan()
    expect(replay.pages.get('a.b.md')).toMatchObject({ identity: { locale: 'en', path: 'ab' }, mapped: true })
    expect(replay.pages.get('a.b.md')?.reviewedReplacement).not.toBe(true)
    await expect(withStorageImportReview(review, async () => {}, plan)).rejects.toThrow('review is stale')
    expect(mutations).toEqual([])
    expect(await readFile(path.join(directory, 'a.b.md'), 'utf8')).toBe('External replacement')
  })

  it('does not overwrite an unrelated native destination without a reviewed id and revision', async () => {
    pages.push({ id: 42, localeCode: 'en', path: 'guide', sourceRevision: '7', content: 'Keep me', title: 'Private diagnostic is not an error message', description: '', isPublished: false, tags: [], extra: {} })
    await source('guide.md', 'External')
    await source('00-sentinel.bin')
    await expect(importAll()).rejects.toThrow('Existing page ownership is unreviewed for guide.md')
    expect(pages[0]!.content).toBe('Keep me')
    expect(mutations).toEqual([])
  })

  it('requires a fresh exact mapping after a human move instead of creating another owner or refreshing the accepted revision', async () => {
    await source('guide.md', 'Accepted source')
    const page = nativePage()
    pages.push(page)
    const accepted = accept(page, 'guide.md', 'Accepted source')
    page.path = 'moved-guide'
    page.sourceRevision = '8'
    await expect(plan()).rejects.toThrow('already owns another canonical destination')
    const reviewed = await preview()
    const review: StorageImportReview = {
      scope, snapshot: reviewed.snapshot,
      mappings: [{
        sourcePath: 'guide.md', sourceSha256: digest('Accepted source'), locale: 'en', path: 'moved-guide',
        existingPageId: page.id, expectedSourceRevision: '8'
      }]
    }
    const reconciled = await withStorageImportReview(review, async () => {}, plan)
    expect(reconciled.pages.get('guide.md')).toMatchObject({
      identity: { locale: 'en', path: 'moved-guide' }, existingPageId: page.id,
      expectedSourceRevision: '8', reviewedReplacement: true, mapped: true
    })
    expect(accepted).toMatchObject({ nativeRevision: '7', nativePath: 'guide' })
    expect(pages).toHaveLength(1)
    expect(mutations).toEqual([])
  })

  it.each(['content', 'title'] as const)('treats a human %s-only edit as stale native ownership', async field => {
    await source('guide.md', 'Accepted source')
    const page = nativePage()
    pages.push(page)
    const accepted = accept(page, 'guide.md', 'Accepted source')
    expect((await plan()).pages.get('guide.md')?.reviewedReplacement).not.toBe(true)
    page[field] = 'Human-only edit'
    page.sourceRevision = '8'
    expect((await preview()).pages[0]?.owned).toBe(false)
    await expect(plan()).rejects.toThrow('ownership is unreviewed')
    expect(accepted.nativeRevision).toBe('7')
    expect(page[field]).toBe('Human-only edit')
    expect(mutations).toEqual([])
  })

  it('does not accept authored owner JSON or equal bytes as an association', async () => {
    await source('guide.md', 'Accepted source')
    const page = nativePage()
    page.extra = { okf: { 'x-wiki': { storage_import: {
      sourceKey: storageImportSourceKey(root.sourceIdentity, 'DISK', ingestion),
      locationKey: storageImportLocationKey('DISK', ingestion), sourcePath: 'guide.md',
      sourceSha256: digest('Accepted source'), mapped: false
    } } } }
    pages.push(page)
    expect((await preview()).pages[0]?.owned).toBe(false)
    await expect(plan()).rejects.toThrow('ownership is unreviewed')
    expect(owners).toEqual([])
    expect(mutations).toEqual([])
  })

  it.each(['content', 'title'] as const)('never refreshes previous-source CAS after a human %s-only edit', async field => {
    const page = nativePage()
    pages.push(page)
    const accepted = accept(page, 'guide.md', 'Accepted source', 'GIT')
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    bindGitPreviousContent(admission, [{ path: 'guide.md', bytes: Buffer.from('Accepted source'), revision: 'a'.repeat(40) }])
    const previous = [{ sourcePath: 'guide.md', contentType: 'markdown', rawDocument: Buffer.from('Accepted source') }]
    const initial = await prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)
    expect(initial.previous.get('guide.md')).toMatchObject({ existingPageId: page.id, expectedSourceRevision: '7' })
    page[field] = 'Human-only edit'
    page.sourceRevision = '8'
    await expect(prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)).rejects.toThrow('stale')
    expect(accepted.nativeRevision).toBe('7')
    expect(page[field]).toBe('Human-only edit')
  })

  it('requires durable deleted proof rather than forged history, and refuses restored or reused identities', async () => {
    const deletedPage = nativePage({ path: 'ab' })
    const receipt = accept(deletedPage, 'a.b.md', 'Accepted source', 'GIT', {
      mapped: true, status: 'deleted', deletedAt: new Date()
    })
    owners = []
    history.push({ action: 'deleted', visibility: 'public', path: 'ab', localeCode: 'en',
      extra: { okf: { 'x-wiki': { storage_import: receipt } } } })
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    bindGitPreviousContent(admission, [{ path: 'a.b.md', bytes: Buffer.from('Accepted source'), revision: 'a'.repeat(40) }])
    const previous = [{ sourcePath: 'a.b.md', contentType: 'markdown', rawDocument: Buffer.from('Accepted source') }]
    await expect(prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)).rejects.toThrow('deletion ownership is unavailable')
    owners.push(receipt)
    history = []
    const replay = await prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)
    expect(replay.previous.has('a.b.md')).toBe(true)
    expect(replay.previous.get('a.b.md')).toBeNull()
    pages.push(nativePage({ id: 99, path: 'ab' }))
    await expect(prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)).rejects.toThrow('reused')
    pages[0] = nativePage({ id: deletedPage.id, path: 'restored-elsewhere' })
    await expect(prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)).rejects.toThrow('reused')
    pages = []
    receipt.sourceSha256 = digest('Different old source')
    await expect(prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)).rejects.toThrow('deletion ownership is unavailable')
    expect(mutations).toEqual([])
  })

  it.each(['moved', 'completed'] as const)('requires exact positive %s binding for rename replay and preserves its actual CAS', async phase => {
    await source('moved-guide.md', 'Accepted source')
    const page = nativePage({ path: 'moved-guide', sourceRevision: phase === 'moved' ? '11' : '14' })
    pages.push(page)
    const accepted = accept(page, phase === 'moved' ? 'guide.md' : 'moved-guide.md', 'Accepted source', 'GIT', {
      moveBinding: {
        phase, fromGitRevision: 'a'.repeat(40), toGitRevision: 'b'.repeat(40),
        oldSourcePath: 'guide.md', newSourcePath: 'moved-guide.md',
        oldSourceSha256: digest('Accepted source'), newSourceSha256: digest('Accepted source'),
        previousNativeRevision: '7', previousNativePath: 'guide', previousNativeLocaleCode: 'en',
        moveOperationId: '11111111-1111-4111-8111-111111111111', moveNativeRevision: '11'
      }
    })
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    bindGitPreviousContent(admission, [{ path: 'guide.md', destinationPath: 'moved-guide.md',
      bytes: Buffer.from('Accepted source'), revision: 'a'.repeat(40) }])
    const previous = [{ sourcePath: 'guide.md', destinationSourcePath: 'moved-guide.md',
      contentType: 'markdown', rawDocument: Buffer.from('Accepted source') }]
    const replay = await prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)
    expect(replay.previous.get('guide.md')).toMatchObject({
      identity: { locale: 'en', path: 'moved-guide' }, existingPageId: page.id, expectedSourceRevision: accepted.nativeRevision
    })
    expect(replay.pages.get('moved-guide.md')?.reviewedReplacement).not.toBe(true)
    accepted.moveBinding!.newSourceSha256 = digest('Unrelated source')
    await expect(prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)).rejects.toThrow()
    accepted.moveBinding!.newSourceSha256 = digest('Accepted source')
    page.title = 'Human changed after native move'
    page.sourceRevision = '15'
    await expect(prepareStorageImportIdentities(admission, ingestion, 'GIT', previous)).rejects.toThrow('stale')
    expect(accepted.nativeRevision).toBe(phase === 'moved' ? '11' : '14')
    expect(mutations).toEqual([])
  })

  it('keeps an accepted mapped association after saved Git operational choices are cleared', async () => {
    await source('guide.md', 'Accepted source')
    const page = nativePage()
    pages.push(page)
    accept(page, 'guide.md', 'Accepted source', 'GIT', { mapped: true })
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    const result = await prepareStorageImportIdentities(admission, ingestion, 'GIT')
    expect(result.pages.get('guide.md')).toMatchObject({ existingPageId: page.id, mapped: true })
    expect(result.pages.get('guide.md')?.reviewedReplacement).not.toBe(true)
  })

  it('bounds native source-owner inventory including deleted positive facts', async () => {
    const receipt = accept(nativePage(), 'guide.md', 'Accepted source', 'DISK', {
      status: 'deleted', deletedAt: new Date()
    })
    owners = Array.from({ length: 10_001 }, (_, index) => ({ ...receipt, pageId: index + 1 }))
    await expect(preview()).rejects.toThrow('owner inventory exceeds its bound')
    expect(mutations).toEqual([])
  })

  it('does not promote saved Git include choices into a fresh exact replacement', async () => {
    await source('.guide.md', 'Accepted source')
    const page = nativePage()
    pages.push(page)
    accept(page, '.guide.md', 'Accepted source', 'GIT', { mapped: true })
    page.title = 'Human-only title edit'
    page.sourceRevision = '8'
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    const gitScope = { ...scope, targetKey: 'git' as const }
    const reviewed = await buildStorageImportPreview(admission, ingestion, 'GIT', gitScope)
    const entry = reviewed.gitContent![0]!
    const review: StorageImportReview = {
      scope: gitScope, snapshot: reviewed.snapshot, mappings: [],
      gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256,
        sourceRevision: entry.sourceRevision, sourceAvailable: entry.sourceAvailable, owner: entry.owner, action: 'include' }]
    }
    const configured = { ...ingestion, dotContentReview: serializeGitContentChoices(
      storageImportSourceKey(root.sourceIdentity, 'GIT', ingestion), review.gitContent!
    ) }
    await expect(prepareStorageImportIdentities(admission, configured, 'GIT')).rejects.toThrow('ownership is unreviewed')
    const fresh = await withStorageImportReview(review, async () => {}, () => prepareStorageImportIdentities(admission, ingestion, 'GIT'))
    expect(fresh.pages.get('.guide.md')).toMatchObject({
      existingPageId: page.id, expectedSourceRevision: '8', mapped: true, reviewedReplacement: true
    })
    expect(owners[0]!.nativeRevision).toBe('7')
    expect(page.title).toBe('Human-only title edit')
    expect(mutations).toEqual([])
  })

  it.each([
    { sourceKey: digest('another root') }, { locationKey: digest('another location') },
    { pageId: 99 }, { nativeRevision: '6' }, { nativePath: 'other' }, { nativeLocaleCode: 'fr' }
  ])('rejects an inexact native association %j', async mismatch => {
    await source('guide.md', 'Accepted source')
    const page = nativePage()
    pages.push(page)
    accept(page, 'guide.md', 'Accepted source', 'DISK', mismatch)
    expect((await preview()).pages[0]?.owned).toBe(false)
    await expect(plan()).rejects.toThrow()
    expect(mutations).toEqual([])
  })

  it('preserves asset authority only with the exact actual native asset id and bytes', async () => {
    const bytes = 'Actual native asset'
    await source('ordinary.bin', bytes)
    const proof = {
      sourceKey: storageImportSourceKey(root.sourceIdentity, 'GIT', ingestion),
      locationKey: storageImportLocationKey('GIT', ingestion), sourcePath: 'ordinary.bin',
      sourceSha256: digest(bytes), mapped: false, assetId: 8, assetSha256: digest(bytes)
    }
    assets.push({ id: 8, filename: 'ordinary.bin', folderId: null,
      hash: assetHelper.generateHash('ordinary.bin'), metadata: { storage_import: proof } })
    assetData.push({ id: 8, data: Buffer.from(bytes) })
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    const gitScope = { ...scope, targetKey: 'git' as const }
    expect((await buildStorageImportPreview(admission, ingestion, 'GIT', gitScope)).gitContent![0]!.owner)
      .toMatchObject({ kind: 'asset', id: 8, sourceOwned: true })
    assetData[0]!.data = Buffer.from('Human replaced native bytes')
    expect((await buildStorageImportPreview(admission, ingestion, 'GIT', gitScope)).gitContent![0]!.owner?.sourceOwned).toBe(false)
    assetData[0]!.data = Buffer.from(bytes)
    proof.assetId = 99
    expect((await buildStorageImportPreview(admission, ingestion, 'GIT', gitScope)).gitContent![0]!.owner?.sourceOwned).toBe(false)
    expect(mutations).toEqual([])
  })

  it('rejects colliding mappings, stale source hashes, revisions, actor scopes, options and asset snapshots without partial writes', async () => {
    await source('a.b.md', 'First')
    await source('second.md', 'Second')
    await source('00-sentinel.bin', 'Asset A')
    const reviewed = await preview()
    const review: StorageImportReview = { scope, snapshot: reviewed.snapshot, mappings: [
      { sourcePath: 'a.b.md', sourceSha256: digest('First'), locale: 'en', path: 'second', existingPageId: null, expectedSourceRevision: null }
    ] }
    expect(() => validateStorageImportReview(reviewed, review)).toThrow('Ambiguous page import')
    review.mappings[0]!.path = 'first'
    review.mappings[0]!.sourceSha256 = digest('Not the reviewed source')
    expect(() => validateStorageImportReview(reviewed, review)).toThrow('Reviewed import source changed')
    review.mappings[0]!.sourceSha256 = digest('First')
    review.mappings[0]!.locale = 'zz'
    expect(() => validateStorageImportReview(reviewed, review)).toThrow('Page locale is not installed')
    review.mappings[0]!.locale = 'en'
    review.mappings[0]!.existingPageId = 42
    review.mappings[0]!.expectedSourceRevision = '1'
    expect(() => validateStorageImportReview(reviewed, review)).toThrow('Reviewed import destination changed')
    review.mappings[0]!.existingPageId = null
    review.mappings[0]!.expectedSourceRevision = null
    await expect(withStorageImportReview({ ...review, scope: { ...scope, actorId: 2 } }, async () => {}, importAll)).rejects.toThrow('review is stale')
    await expect(withStorageImportReview(review, async () => {}, () => commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion: { ...ingestion, stripLeadingH1: true } }))).rejects.toThrow('review is stale')
    await source('00-sentinel.bin', 'Asset B')
    await expect(withStorageImportReview(review, async () => {}, importAll)).rejects.toThrow('review is stale')
    expect(mutations).toEqual([])
    expect(pages).toEqual([])
  })

  it('rejects canonical, locale-prefixed and configured README/home aliases before any writes', async () => {
    await source('README.md', '# Home\n\nREADME')
    await source('en/home.md', 'Home')
    await source('00-sentinel.bin')
    await expect(commonDisk.importFromDisk({ root, moduleName: 'DISK', ingestion: { mapReadmeToHome: true } })).rejects.toThrow('Ambiguous page import')
    expect(mutations).toEqual([])
    await rm(path.join(directory, 'README.md'))
    await rm(path.join(directory, 'en/home.md'))
    await source('en/index.concept.md', '---\ntype: Reference\n---\n\nCanonical')
    await source('index.md', 'Ordinary index')
    await expect(importAll()).rejects.toThrow('Ambiguous page import')
    expect(mutations).toEqual([])
  })

  it('excludes new root/nested Git dot-content only, while retaining the complete admitted inventory and ordinary assets', async () => {
    for (const name of ['.root.md', '.root.bin', '.nested/page.md', 'docs/.nested/asset.bin']) await source(name)
    await source('ordinary.md', 'Ordinary page')
    await source('ordinary.bin', 'Ordinary asset')
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    const plan = await prepareStorageImportIdentities(admission, ingestion, 'GIT')
    expect(plan.pages.has('ordinary.md')).toBe(true)
    expect(plan.pages.has('.root.md')).toBe(false)
    expect(plan.pages.has('.nested/page.md')).toBe(false)
    expect(plan.preview.entries.filter(entry => entry.kind === 'file')).toHaveLength(6)
    expect([...plan.gitContent!.values()].filter(entry => entry.hidden).map(entry => gitContentAction(entry, plan.gitChoices!))).toEqual(['ignore', 'ignore', 'ignore', 'ignore'])
    expect([...plan.gitContent!.values()].filter(entry => !entry.hidden)).toEqual([
      expect.objectContaining({ automatic: true, kind: 'asset', owner: null })
    ])
    expect(mutations).toEqual([])
    // Disk retains its existing fail-closed native identity policy, not Git's visibility policy.
    await expect(importAll()).rejects.toThrow('Unsupported native page identity')
  })

  it.each(['.ignored/.GiT/config', '.ignored/nested/.git/secret', '.ignored/.page.123.11111111-1111-4111-8111-111111111111.tmp', '_daily/.ignored/file.md', '_manual/.ignored/file.md'])(
    'refuses unsafe/internal %s before dot-content visibility can ignore it', async name => {
      await source(name)
      await expect(collectGitContentEntries(root, 1024 * 1024)).rejects.toThrow()
      expect(mutations).toEqual([])
    }
  )

  it('charges hidden bytes and rejects hidden symlinks before deciding content visibility', async () => {
    await source('.too-large.bin', 'Hidden content still consumes the asset bound')
    await expect(collectGitContentEntries(root, 4)).rejects.toThrow('exceeds')
    await rm(path.join(directory, '.too-large.bin'))
    await source('ordinary.bin', 'Ordinary asset')
    await symlink('ordinary.bin', path.join(directory, '.ignored-link.bin'))
    await expect(collectGitContentEntries(root, 1024 * 1024)).rejects.toThrow()
    expect(mutations).toEqual([])
  })

  it('requires both an exact compatibility decision and a valid native destination for supported dotted Git page sources', async () => {
    await source('.guide.md', 'Reviewed compatibility content')
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    const gitScope = { ...scope, targetKey: 'git' as const }
    const reviewed = await buildStorageImportPreview(admission, ingestion, 'GIT', gitScope)
    const entry = reviewed.gitContent![0]!
    const review: StorageImportReview = {
      scope: gitScope, snapshot: reviewed.snapshot,
      mappings: [{ sourcePath: '.guide.md', sourceSha256: entry.sourceSha256, locale: 'en', path: 'guide', existingPageId: null, expectedSourceRevision: null }],
      gitContent: [{ sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'include' }]
    }
    await withStorageImportReview(review, async () => {}, async () => {
      const plan = await prepareStorageImportIdentities(admission, ingestion, 'GIT')
      expect(plan.pages.get('.guide.md')?.identity).toEqual({ locale: 'en', path: 'guide' })
    })
    expect(() => validateStorageImportReview(reviewed, { ...review, mappings: [] })).toThrow('Unsupported native page identity')
    const configured = { ...ingestion, dotContentReview: serializeGitContentChoices(
      storageImportSourceKey(root.sourceIdentity, 'GIT', ingestion), review.gitContent!
    ) }
    await source('.guide.md', 'Changed after the exact review')
    const changed = await collectGitContentEntries(root, 1024 * 1024)
    await expect(prepareStorageImportIdentities(changed, configured, 'GIT')).rejects.toThrow('review is stale')
    expect(mutations).toEqual([])
  })

  it('does not turn a supplied owner claim or matching bytes into native removal authority', async () => {
    await source('.unowned.bin', 'Same bytes are not source ownership')
    const admission = await collectGitContentEntries(root, 1024 * 1024)
    const preview = await buildStorageImportPreview(admission, ingestion, 'GIT', { ...scope, targetKey: 'git' })
    const entry = preview.gitContent![0]!
    const remove = { sourcePath: entry.sourcePath, sourceSha256: entry.sourceSha256, owner: null, action: 'remove' as const }
    expect(() => resolveGitContentChoices(preview, [remove])).toThrow('requires exact native source ownership')
    expect(() => resolveGitContentChoices(preview, [{ ...remove, owner: {
      kind: 'asset', id: 42, path: entry.sourcePath, locale: '', revision: '1', sha256: entry.sourceSha256, sourceOwned: true
    } }])).toThrow('review is stale')
    expect(mutations).toEqual([])
  })
})
