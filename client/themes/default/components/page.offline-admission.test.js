import { readFileSync } from 'node:fs'
import path from 'node:path'
import { babelParse, parse } from '@vue/compiler-sfc'
import { describe, expect, it } from '../../../../server/test/bun-test.mts'
import { OfflineReadingVaultV1Schema, OFFLINE_READING_SALT_BYTES, OFFLINE_READING_NONCE_BYTES } from '../../../../shared/offline.ts'
import { offlinePageControl } from '../../../helpers/offline-page-status.ts'

const filename = path.join(process.cwd(), 'client/themes/default/components/page.vue')
const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.script) throw new Error('Cannot parse page component')
const ast = babelParse(descriptor.script.content, { sourceType: 'module', plugins: ['typescript'] })
const exported = ast.program.body.find(node => node.type === 'ExportDefaultDeclaration')
const options = exported?.declaration.type === 'CallExpression' ? exported.declaration.arguments[0] : null
const methods = options?.type === 'ObjectExpression'
  ? options.properties.find(node => node.type === 'ObjectProperty' && node.key.type === 'Identifier' && node.key.name === 'methods')?.value
  : null
const refreshMethod = methods?.type === 'ObjectExpression'
  ? methods.properties.find(node => node.type === 'ObjectMethod' && node.key.type === 'Identifier' && node.key.name === 'refreshOfflinePageState')
  : null
if (!refreshMethod) throw new Error('Page offline admission method is unavailable')
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(`return ({${descriptor.script.content.slice(refreshMethod.start, refreshMethod.end)}}).refreshOfflinePageState`)
const refreshOfflinePageState = new Function(executable)()

const vault = OfflineReadingVaultV1Schema.parse({
  schemaVersion: 1,
  context: {
    schemaVersion: 1,
    canonicalOrigin: 'https://wiki.example.test',
    siteId: 'https://wiki.example.test',
    accountId: 1,
    authVersion: 1,
    keyVersion: 'random-reading-v1',
    keyId: Buffer.alloc(16).toString('base64url')
  },
  sessionGeneration: 7,
  salt: new Uint8Array(OFFLINE_READING_SALT_BYTES),
  nonce: new Uint8Array(OFFLINE_READING_NONCE_BYTES),
  wrappedKey: new Uint8Array(48)
})

const fixture = () => {
  const read = Promise.withResolvers()
  const page = {
    offlineDisposed: false,
    pageId: 3,
    locale: 'en',
    offlineOperationId: 0,
    offlinePrivatePath: true,
    offlineState: 'locked',
    offlineAccessState: 'locked',
    offlineGeneration: vault.sessionGeneration,
    offlinePrivateHandle: () => null,
    offlineStorageForOperation: async () => ({ getReadingVault: () => read.promise }),
    isCurrentOfflineOperation(operationId, pageId) {
      return operationId === this.offlineOperationId && pageId === this.pageId
    },
    $t: key => key
  }
  return { page, read }
}

const controlFor = page => offlinePageControl({
  state: page.offlineState,
  accessState: page.offlineAccessState,
  selected: false,
  hasSnapshot: page.offlineHasSnapshot,
  hasValidBody: false,
  excluded: false,
  manual: false,
  automatic: false,
  tag: false,
  tagNames: [],
  revealTagNames: true,
  quietIneligibility: false,
  localReason: '',
  connected: true,
  busy: false
}, (_key, options = {}) => String(options.defaultValue ?? ''))

describe('private page offline admission', () => {
  it('keeps unlock available while a same-generation passive vault read is pending', async () => {
    const { page, read } = fixture()
    const pending = refreshOfflinePageState.call(page, true)
    try {
      expect(controlFor(page)).toMatchObject({ action: 'unlock', blocked: false })
      expect(page.offlineGeneration).toBe(vault.sessionGeneration)
    } finally {
      read.resolve(vault)
      await pending
    }
    expect(controlFor(page)).toMatchObject({ action: 'unlock', blocked: false })
  })

  it('withdraws the retained unlock action when vault inspection fails', async () => {
    const { page, read } = fixture()
    const pending = refreshOfflinePageState.call(page, true)
    await Promise.resolve()
    read.reject(new Error('Reading vault storage is unavailable'))
    await pending
    expect(controlFor(page)).toMatchObject({ state: 'unavailable', action: 'none', blocked: true })
    expect(page.offlineGeneration).toBeNull()
  })

  it('withdraws old admission immediately for an authoritative identity refresh', async () => {
    const { page, read } = fixture()
    const pending = refreshOfflinePageState.call(page)
    try {
      expect(controlFor(page)).toMatchObject({ state: 'checking', action: 'none', blocked: true })
      expect(page.offlineGeneration).toBeNull()
    } finally {
      read.resolve(null)
      await pending
    }
    expect(controlFor(page)).toMatchObject({ state: 'setup-required', action: 'setup' })
  })
})
