import { readFileSync } from 'node:fs'
import type { Knex } from 'knex'
import type Page from '../../../models/pages.ts'
import { buildApprovedSkillBundle } from '../parser.ts'
import { SkillRegistry } from '../registry.ts'

const NAME = 'wiki-authoring'
const INSTALL_LOCK = 0x574b534b
const source = readFileSync(new URL('./wiki-authoring.md', import.meta.url), 'utf8')
buildApprovedSkillBundle(Buffer.from(source, 'utf8'), NAME, [])

interface SourcePage {
  id: number
  content: string
  contentType: string
  editorKey: string
  visibility: string
  ownerId: number | null
  isPublished: boolean
  isSearchable: boolean
}

type PageCreateInput = Parameters<typeof Page.createPage>[0]

interface Installer {
  db: Knex
  namespace: string
  locale: string
  getRootUser(): Promise<PageCreateInput['user']>
  createPage(input: PageCreateInput): Promise<{ id: number }>
}

export const installBuiltinWikiAuthoring = async ({
  db,
  namespace,
  locale,
  getRootUser,
  createPage
}: Installer): Promise<'installed' | 'already-installed' | 'conflict'> => {
  const path = `${namespace}/${NAME}`
  const install = async (lock: Knex | Knex.Transaction): Promise<'installed' | 'already-installed' | 'conflict'> => {
    // Include retired mappings so a deliberate administrative removal is not undone at restart.
    const existingSkill = await lock('agentSkills').where({ name: NAME }).first('id')
    if (existingSkill) return 'already-installed'

    let page = (await lock('pages')
      .where({ path, localeCode: locale, visibility: 'public' })
      .first('id', 'content', 'contentType', 'editorKey', 'visibility', 'ownerId', 'isPublished', 'isSearchable')) as SourcePage | undefined
    if (!page) {
      const rootUser = await getRootUser()
      const created = await createPage({
        path,
        locale,
        user: rootUser,
        content: source,
        editor: 'markdown',
        description: 'Bundled Wiki authoring skill source; review before enabling.',
        visibility: 'public',
        isPublished: false,
        isSearchable: false,
        title: 'Wiki authoring skill',
        skipStorage: true
      })
      page = (await lock('pages')
        .where({ id: created.id })
        .first('id', 'content', 'contentType', 'editorKey', 'visibility', 'ownerId', 'isPublished', 'isSearchable')) as SourcePage | undefined
    }
    if (
      !page ||
      page.content !== source ||
      page.contentType !== 'markdown' ||
      page.editorKey !== 'markdown' ||
      page.visibility !== 'public' ||
      page.ownerId !== null ||
      page.isPublished ||
      page.isSearchable
    )
      return 'conflict'

    const rootUser = await getRootUser()
    await new SkillRegistry(db, namespace).create({
      name: NAME,
      rootPageId: page.id,
      rootPath: path,
      assetFolderId: null,
      exposureMode: 'all_agent_users',
      groupIds: [],
      actorId: rootUser.id
    })
    return 'installed'
  }
  if (!['pg', 'postgres', 'postgresql'].includes(String(db.client.config.client))) return install(db)
  return db.transaction(async lock => {
    await lock.raw('SELECT pg_advisory_xact_lock(?)', [INSTALL_LOCK])
    return install(lock)
  })
}
