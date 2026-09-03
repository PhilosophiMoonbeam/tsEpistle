import { readFile } from 'node:fs/promises'

import { describe, expect, it } from './bun-test.mts'

type ProductPackage = {
  product: {
    containerRepository: string
    upstreamName: string
    upstreamVersion: string
  }
  dependencies: Record<string, string>
}

type ScarlettLedger = {
  upstream: {
    branch: string
    recordedTip: string
  }
  candidates: unknown[]
}

const readText = (path: string): Promise<string> => readFile(path, 'utf8')

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readText(path)) as T

describe('active product governance contracts', () => {
  it('keeps upgrade and artifact promises aligned with package and release facts', async () => {
    const [packageJson, readme, security, buildWorkflow] = await Promise.all([
      readJson<ProductPackage>('package.json'),
      readText('README.md'),
      readText('SECURITY.md'),
      readText('.github/workflows/build.yml')
    ])

    const upstreamSource = `${packageJson.product.upstreamName} ${packageJson.product.upstreamVersion}`
    const upgradePromise = `The only supported upstream database upgrade source is exactly ${upstreamSource}.`
    const artifactPromise = 'Official binary artifacts are the Linux archive and Linux container images; Windows archives are not published or supported.'

    expect(upstreamSource).toBe('Wiki.js 2.5.314')
    expect(readme).toContain(packageJson.product.containerRepository)
    expect(security).toContain(packageJson.product.containerRepository)
    expect(buildWorkflow).toContain('path: tsepistle-linux.tar.gz')
    expect(buildWorkflow).toContain('platforms: linux/amd64')
    expect(buildWorkflow).toContain('platforms: linux/arm64')
    expect(buildWorkflow).not.toMatch(/tsepistle-windows|windows\.(?:zip|tar)/i)

    for (const publicContract of [readme, security]) {
      expect(publicContract).toContain(upgradePromise)
      expect(publicContract).toContain(artifactPromise)
      expect(publicContract).not.toMatch(/Wiki\.js 2\.x\b|Wiki\.js 2(?!\.\d)/i)
    }
  })

  it('makes the ledger the current Scarlett authority and the prose roadmap historical', async () => {
    const [roadmap, ledger] = await Promise.all([
      readText('docs/.planning/2026-08-14_scarlett-design-synthesis-roadmap.md'),
      readJson<ScarlettLedger>('docs/.planning/scarlett-upstream-ledger.json')
    ])

    const historicalTip = roadmap.match(/- upstream commit: `([0-9a-f]{40})`/)?.[1]

    expect(ledger.upstream.branch).toBe('scarlett')
    expect(ledger.upstream.recordedTip).toMatch(/^[0-9a-f]{40}$/)
    expect(ledger.candidates.length).toBeGreaterThan(0)
    expect(historicalTip).toMatch(/^[0-9a-f]{40}$/)
    expect(historicalTip).not.toBe(ledger.upstream.recordedTip)
    expect(roadmap).toContain('Status: historical record — superseded; not an active product roadmap')
    expect(roadmap).toContain('[`scarlett-upstream-ledger.json`](./scarlett-upstream-ledger.json) is the sole current authority')
    expect(roadmap).not.toContain('Status: authoritative product roadmap')
  })

  it('identifies Tiptap as the current visual-editor engine and the CKEditor plan as superseded', async () => {
    const [packageJson, plan, visualMarkdown, visualHtml, definition] = await Promise.all([
      readJson<ProductPackage>('package.json'),
      readText('docs/.planning/2026-08-14_visual-markdown-ckeditor-plan.md'),
      readText('client/components/editor/editor-visual-markdown.vue'),
      readText('client/components/editor/editor-ckeditor.vue'),
      readText('server/modules/editor/visual-markdown/definition.yml')
    ])

    expect(packageJson.dependencies['@tiptap/core']).toBe(packageJson.dependencies['@tiptap/vue-3'])
    expect(packageJson.dependencies['@tiptap/markdown']).toBe(packageJson.dependencies['@tiptap/core'])
    expect(Object.keys(packageJson.dependencies).some(name => name.toLowerCase().includes('ckeditor'))).toBe(false)
    expect(visualMarkdown).toContain("import TiptapEditor from './tiptap/editor.vue'")
    expect(visualMarkdown).toContain("tiptap-editor(format='markdown'")
    expect(visualHtml).toContain("import TiptapEditor from './tiptap/editor.vue'")
    expect(visualHtml).toContain("tiptap-editor(format='html'")
    expect(definition).toContain('key: visual-markdown')
    expect(definition).toContain('contentType: markdown')
    expect(plan).toContain('Status: historical record — superseded by the current Tiptap implementation and contract; not ready for implementation')
    expect(plan).toContain('Do not implement it or use it as an active product contract.')
    expect(plan).not.toContain('Status: ready for implementation')
  })
})
