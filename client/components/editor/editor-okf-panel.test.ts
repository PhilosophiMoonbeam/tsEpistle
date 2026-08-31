import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

const panelPath = path.join(process.cwd(), 'client/components/editor/editor-okf-panel.vue')
const panelSource = fs.readFileSync(panelPath, 'utf8')
const script = panelSource.match(/<script lang=['"]ts['"]>\s*([\s\S]*?)\s*<\/script>/)?.[1] ?? ''
type PanelMethod = (...args: unknown[]) => unknown
type PanelDefinition = { methods: Record<string, PanelMethod> }
type ExtensionParser = (text: string) => { value: Record<string, unknown> | null; error: string | null }

const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script
    .replace(/^import .*$/gm, '')
    .replace('export function parseExtensionJson', 'function parseExtensionJson')
    .replace('export default defineComponent', 'const panel = defineComponent')
    + '\nreturn { panel, parseExtensionJson }'
)
const loadPanel = () => new Function('defineComponent', executableScript)((options: unknown) => options) as { panel: PanelDefinition; parseExtensionJson: ExtensionParser }
const loadParser = () => loadPanel().parseExtensionJson

describe('Knowledge / OKF editor panel', () => {
  it('exposes editable metadata controls and uses immutable metadata updates', () => {
    expect(panelSource).toContain("v-text-field(v-model='metadataType'")
    expect(panelSource).toContain("v-select(v-model='metadataStatus'")
    expect(panelSource).toContain("v-model='metadataResource'")
    expect(panelSource).toContain("v-model='metadataStaleAfter'")
    expect(panelSource).toContain('replaceMetadata({ ...metadata, ...patch })')
    expect(panelSource).toContain('this.okfStore.page.okf = {')
  })

  it('deletes cleared optional fields without changing required metadata', () => {
    const methods = loadPanel().panel.methods
    const projection = { state: 'pending', value: { summary: 'derived data' } }
    const store = {
      page: {
        okf: {
          authority: {
            state: 'valid',
            metadata: {
              type: 'Reference',
              status: 'stable',
              resource: 'urn:example:resource',
              stale_after: '2026-12-01T00:00:00.000Z'
            },
            trust: null
          },
          projection
        }
      }
    }
    const context: Record<string, unknown> = { okfStore: store }
    Object.defineProperty(context, 'authorityMetadata', {
      get: () => store.page.okf.authority.metadata
    })
    context.replaceMetadata = methods.replaceMetadata.bind(context)

    methods.updateOptionalMetadata.call(context, 'resource', '')
    methods.updateOptionalMetadata.call(context, 'stale_after', '')

    expect(store.page.okf.authority.metadata).toEqual({ type: 'Reference', status: 'stable' })
    expect(store.page.okf.projection).toBe(projection)
    expect(panelSource).toContain('set (value: string) { this.updateMetadata({ type: value }) }')
  })

  it('renders source rows and routes source edits through immutable replacement', () => {
    expect(panelSource).toContain("v-for='(source, index) of sources'")
    expect(panelSource).toContain("@update:model-value='updateSource(index, { resource: $event })'")
    expect(panelSource).toContain('const sources = this.sources.map')
    expect(panelSource).toContain('sources: this.sources.filter')
  })

  it('validates extension JSON and rejects core or unsafe keys', () => {
    const parseExtensionJson = loadParser()
    expect(parseExtensionJson('{"custom":{"enabled":true}}')).toEqual({ value: { custom: { enabled: true } }, error: null })
    expect(parseExtensionJson('{')).toMatchObject({ value: null })
    expect(parseExtensionJson('[]').error).toContain('JSON object')
    expect(parseExtensionJson('{"status":"stable"}').error).toContain('non-core')
    expect(parseExtensionJson('{"__proto__":{}}').error).toContain('non-core')
    expect(panelSource).toContain('Apply extensions')
    expect(panelSource).toContain("v-alert.mb-2(v-if='extensionError'")
  })

  it('resets missing or invalid authority locally without replacing derived data', () => {
    const resetInvalid = loadPanel().panel.methods.resetInvalid
    for (const state of ['invalid', 'missing']) {
      const projection = { state: 'current', value: { summary: 'derived data' } }
      const trust = { preserved: true }
      const store = {
        page: {
          okf: {
            authority: { state, metadata: null, trust },
            projection
          }
        }
      }
      const context = {
        okfStore: store,
        hasMetadata: false,
        extensionError: 'previous error',
        extensionEditing: true
      }

      resetInvalid.call(context)

      expect(store.page.okf.authority).toEqual({
        state: 'valid',
        metadata: { type: 'Reference', status: 'stable' },
        trust
      })
      expect(store.page.okf.projection).toBe(projection)
    }
    expect(panelSource).toContain("@click='resetInvalid'")
    expect(panelSource).toContain('Reset to stable reference')
    expect(panelSource).not.toContain('Reset to draft')
  })

  it('shows authority and projection status badges', () => {
    expect(panelSource).toContain(':color=\'authorityStateColor\'')
    expect(panelSource).toContain(':color=\'projectionStateColor\'')
    expect(panelSource).toContain('projectionComplete ? `success` : `warning`')
    expect(panelSource).toContain("{{ trust ? (trust.stale ? 'stale' : 'current') : '—' }}")
  })

  it('shows deterministic and utility provenance details', () => {
    for (const field of ['deterministicVersion', 'field', 'source', 'evidence', 'profileVersionId', 'model', 'inputSha256', 'outputSha256', 'generatedAt']) {
      expect(panelSource).toContain(field)
    }
    expect(panelSource).toContain('No field-level evidence recorded.')
    expect(panelSource).toContain('No utility projection was used.')
  })
})
