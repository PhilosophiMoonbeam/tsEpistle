import { describe, expect, it } from '../bun-test.mts'

import {
  buildLoginBundleBudgets,
  buildLoginBundleGraph,
  collectManifestClosure,
  findBudgetFailures,
  findForbiddenLoginInitialFiles,
  type LoginBundleMeasurements,
  type Manifest
} from '../../scripts/check-bundle-budgets.ts'

const manifest: Manifest = {
  'entry-app-4f3a.js': {
    file: 'js/app-4f3a.js',
    src: 'client/index-app.ts',
    imports: ['shared-a11c.js'],
    dynamicImports: ['login-b921.js'],
    css: ['assets/app-1000.css']
  },
  'login-b921.js': {
    file: 'js/login-b921.js',
    src: 'client/components/login.vue',
    imports: ['shared-a11c.js', 'login-branch-662e.js'],
    dynamicImports: ['scene-8ca2.js'],
    css: ['assets/login-2291.css', 'assets/shared-4da0.css']
  },
  'login-branch-662e.js': {
    file: 'js/login-branch-662e.js',
    imports: ['shared-a11c.js', 'login-leaf-cd31.js']
  },
  'login-leaf-cd31.js': {
    file: 'js/login-leaf-cd31.js'
  },
  'shared-a11c.js': {
    file: 'js/shared-a11c.js',
    css: ['assets/shared-4da0.css']
  },
  'scene-8ca2.js': {
    file: 'js/scene-8ca2.js',
    src: 'client/components/login-logo/LogoParticleScene.vue',
    imports: ['shared-a11c.js', 'scene-branch-76b1.js'],
    dynamicImports: ['scene-deferred-09f4.js'],
    css: ['assets/scene-3340.css']
  },
  'scene-branch-76b1.js': {
    file: 'js/scene-branch-76b1.js',
    imports: ['shared-a11c.js'],
    css: ['assets/shared-4da0.css'],
    assets: ['assets/scene-points-51a8.bin']
  },
  'scene-deferred-09f4.js': {
    file: 'js/scene-deferred-09f4.js',
    imports: ['scene-branch-76b1.js']
  }
}

describe('login bundle manifest graph', () => {
  it('follows static branches for the initial closure while excluding dynamic imports', () => {
    const graph = buildLoginBundleGraph(manifest)

    expect([...graph.initialChunks].sort()).toEqual(['entry-app-4f3a.js', 'login-b921.js', 'login-branch-662e.js', 'login-leaf-cd31.js', 'shared-a11c.js'])
    expect(graph.initialChunks.has('scene-8ca2.js')).toBe(false)
    expect([...graph.initialFiles.styles].sort()).toEqual(['assets/app-1000.css', 'assets/login-2291.css', 'assets/shared-4da0.css'])
  })

  it('includes dynamic scene descendants but removes shared chunks and aliased files once', () => {
    const graph = buildLoginBundleGraph(manifest)

    expect([...graph.sceneOnlyChunks].sort()).toEqual(['scene-8ca2.js', 'scene-branch-76b1.js', 'scene-deferred-09f4.js'])
    expect([...graph.sceneOnlyFiles.scripts].sort()).toEqual(['js/scene-8ca2.js', 'js/scene-branch-76b1.js', 'js/scene-deferred-09f4.js'])
    expect([...graph.sceneOnlyFiles.styles]).toEqual(['assets/scene-3340.css'])
    expect([...graph.sceneOnlyFiles.assets]).toEqual(['assets/scene-points-51a8.bin'])

    const staticSceneClosure = collectManifestClosure(manifest, [graph.sceneKey])
    expect(staticSceneClosure.has('scene-deferred-09f4.js')).toBe(false)
  })

  it('reports forbidden initial dependencies and deliberate gzip and scene budget failures', () => {
    const loginChunk = manifest['login-b921.js']!
    const contaminatedManifest: Manifest = {
      ...manifest,
      'login-b921.js': {
        ...loginChunk,
        imports: [...(loginChunk.imports ?? []), 'three-core-a550.js']
      },
      'three-core-a550.js': {
        file: 'js/three-core-a550.js',
        name: 'three',
        assets: ['assets/login-particle-data-d70d.bin']
      }
    }
    const graph = buildLoginBundleGraph(contaminatedManifest)
    const forbidden = findForbiddenLoginInitialFiles(contaminatedManifest, graph.initialChunks, graph.initialFiles)
    const measurements: LoginBundleMeasurements = {
      directJavascript: { rawBytes: 40_000, gzipBytes: 5_878 + 5 * 1_024 + 1 },
      directStyles: { rawBytes: 12_000, gzipBytes: 2_019 },
      initialForbiddenFiles: forbidden,
      lazyScene: { rawBytes: 950 * 1_024 + 1, gzipBytes: 200_000 }
    }

    expect(forbidden).toEqual(['assets/login-particle-data-d70d.bin', 'js/three-core-a550.js'])
    expect(findBudgetFailures(buildLoginBundleBudgets(measurements))).toEqual([
      'login direct JavaScript delta from 16fa062 (gzip)',
      'login initial scene/Tres/Three/shader/particle assets',
      'lazy login particle scene reachable-only closure (raw)'
    ])
  })
})
