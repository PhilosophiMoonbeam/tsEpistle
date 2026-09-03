import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createProductMetadata, loadProductMetadata, productDefinition } from '../../core/product.ts'
import { normalizeLegacyProductDefaults } from '../../core/config.ts'

const revision = '0123456789abcdef0123456789abcdef01234567'
const date = '2026-08-13T12:34:56.000Z'

describe('product metadata contract', () => {
  test('defines the independent preview identity from package metadata', () => {
    expect(productDefinition).toEqual({
      name: 'tsEpistle',
      version: '0.1.0-alpha.1',
      description: 'tsEpistle, an independent community fork of Wiki.js',
      sourceRepository: 'https://github.com/PhilosophiMoonbeam/tsEpistle',
      containerRepository: 'ghcr.io/philosophimoonbeam/wiki',
      upstreamName: 'Wiki.js',
      upstreamVersion: '2.5.314',
      independentFork: true,
      modifiedAt: '2026-08-13'
    })
  })

  test('binds the source URL to the exact full revision', () => {
    expect(createProductMetadata({ revision, date })).toEqual({
      ...productDefinition,
      revision,
      date,
      upstreamBase: 'Wiki.js 2.5.314',
      sourceUrl: `https://github.com/PhilosophiMoonbeam/tsEpistle/tree/${revision}`
    })
  })

  test('rejects abbreviated or invalid revisions', () => {
    expect(() => createProductMetadata({ revision: revision.slice(0, 12), date })).toThrow('full lowercase Git commit SHA')
    expect(() => createProductMetadata({ revision: revision.toUpperCase(), date })).toThrow('full lowercase Git commit SHA')
  })

  test('migrates inherited product defaults', () => {
    const legacyConfig = {
      title: 'Wiki.ts Preview',
      logoUrl: '/_assets/svg/logo-wikijs.svg'
    }
    expect(normalizeLegacyProductDefaults(legacyConfig, 'tsEpistle')).toEqual(['title', 'logoUrl'])
    expect(legacyConfig).toEqual({
      title: 'tsEpistle',
      logoUrl: '/_assets/svg/icon-tsepistle.svg'
    })
  })

  test('migrates exact persisted old defaults but preserves custom branding', () => {
    const legacyConfig = {
      title: 'tsFranki',
      logoUrl: '/_assets/svg/icon-tsfranki.svg'
    }
    expect(normalizeLegacyProductDefaults(legacyConfig, 'tsEpistle')).toEqual(['title', 'logoUrl'])
    expect(legacyConfig).toEqual({
      title: 'tsEpistle',
      logoUrl: '/_assets/svg/icon-tsepistle.svg'
    })

    const customConfig = { title: 'Engineering Handbook', logoUrl: '/assets/company.svg' }
    expect(normalizeLegacyProductDefaults(customConfig, 'tsEpistle')).toEqual([])
    expect(customConfig).toEqual({ title: 'Engineering Handbook', logoUrl: '/assets/company.svg' })
  })

  test('loads deterministic generated identity without a Git checkout', () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tsepistle-product-'))
    fs.mkdirSync(path.join(rootPath, 'server'))
    fs.writeFileSync(path.join(rootPath, 'server', '.build-metadata.json'), JSON.stringify({ revision, date }))

    try {
      expect(loadProductMetadata(rootPath)).toEqual(createProductMetadata({ revision, date }))
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true })
    }
  })
})
