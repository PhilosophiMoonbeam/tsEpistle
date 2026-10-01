import { readFile } from 'node:fs/promises'
import * as yaml from 'js-yaml'

import { describe, expect, it } from './bun-test.mts'

type ProductPackage = {
  product: {
    containerRepository: string
    upstreamName: string
    upstreamVersion: string
  }
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

type BuildWorkflow = {
  jobs: Record<string, {
    steps?: Array<{
      uses?: string
      with?: { path?: string, platforms?: string, file?: string, artifacts?: string }
    }>
  }>
}


const readText = (path: string): Promise<string> => readFile(path, 'utf8')

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readText(path)) as T

describe('active product governance contracts', () => {
  it('checks supported upstream identity, public repository references and active Linux artifact configuration', async () => {
    const [packageJson, readme, security, buildWorkflow] = await Promise.all([
      readJson<ProductPackage>('package.json'),
      readText('README.md'),
      readText('SECURITY.md'),
      readText('.github/workflows/build.yml')
    ])

    const upstreamSource = `${packageJson.product.upstreamName} ${packageJson.product.upstreamVersion}`
    const workflow = yaml.load(buildWorkflow) as BuildWorkflow
    const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? [])
    const artifactPaths = steps
      .filter(step => step.uses?.startsWith('actions/upload-artifact@'))
      .flatMap(step => (step.with?.path ?? '').split('\n').map(path => path.trim()))
    const dockerBuilds = steps.filter(step => step.uses?.startsWith('docker/build-push-action@'))
    const applicationPlatforms = dockerBuilds
      .filter(step => ['dev/build/Dockerfile', 'dev/build-arm/Dockerfile'].includes(step.with?.file ?? ''))
      .flatMap(step => (step.with?.platforms ?? '').split(',').map(platform => platform.trim()).filter(Boolean))
    const releaseArtifacts = steps.flatMap(step => step.with?.artifacts ?? [])

    expect(upstreamSource).toBe('Wiki.js 2.5.314')
    expect(readme).toContain(packageJson.product.containerRepository)
    expect(security).toContain(packageJson.product.containerRepository)
    expect(artifactPaths).toContain('tsepistle-linux.tar.gz')
    expect(applicationPlatforms).toContain('linux/amd64')
    expect(applicationPlatforms).toContain('linux/arm64')
    expect([...artifactPaths, ...releaseArtifacts].join('\n')).not.toMatch(/tsepistle-windows|windows\.(?:zip|tar)/i)
    for (const step of dockerBuilds) {
      for (const platform of (step.with?.platforms ?? '').split(',').filter(Boolean)) {
        expect(platform.trim()).toMatch(/^linux\//)
      }
    }

    for (const publicContract of [readme, security]) {
      expect(publicContract).not.toMatch(/Wiki\.js 2\.x\b|Wiki\.js 2(?!\.\d)/i)
    }
  })

  it('keeps Tiptap package versions aligned, excludes CKEditor dependencies and preserves Markdown editor metadata', async () => {
    const [packageJson, definition] = await Promise.all([
      readJson<ProductPackage>('package.json'),
      readText('server/modules/editor/visual-markdown/definition.yml')
    ])

    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
    const versions = ['@tiptap/core', '@tiptap/vue-3', '@tiptap/markdown'].map(name => dependencies[name])
    for (const version of versions) {
      expect(typeof version).toBe('string')
      expect(version).toMatch(/\S/)
    }
    expect(versions[1]).toBe(versions[0])
    expect(versions[2]).toBe(versions[0])
    expect([...Object.keys(packageJson.dependencies), ...Object.keys(packageJson.devDependencies)].some(name => name.toLowerCase().includes('ckeditor'))).toBe(false)
    expect(yaml.load(definition)).toMatchObject({ key: 'visual-markdown', contentType: 'markdown' })
  })
})
