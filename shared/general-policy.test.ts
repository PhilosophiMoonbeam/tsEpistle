import { describe, expect, it } from '../server/test/bun-test.mts'
import { generalPolicyDefaults, validateGeneralPolicy, externalSourceUrl } from './general-policy.ts'
const valid = () => ({ ...structuredClone(generalPolicyDefaults), host: 'https://wiki.example.com' })
describe('general policy', () => {
  it('normalizes origins, URL extensions and indexing selections', () => {
    const result = validateGeneralPolicy({
      ...valid(),
      host: 'HTTPS://wiki.example.com:443/',
      pageExtensions: ['MD', 'md', 'html'],
      robots: ['follow', 'index', 'index']
    })
    expect(result).toMatchObject({ ok: true, value: { host: 'https://wiki.example.com', pageExtensions: ['html', 'md'], robots: ['follow', 'index'] } })
  })
  it('preserves fixed local, tailnet, IPv6 and explicitly ported public origins', () => {
    for (const host of [
      'http://127.0.0.1:3014',
      'https://wiki.example.com',
      'http://localhost:3014',
      'https://wiki.tailnet-name.ts.net:8443',
      'http://[::1]:3014'
    ])
      expect(validateGeneralPolicy({ ...valid(), host })).toMatchObject({ ok: true, value: { host } })
  })
  it('rejects unsupported, contradictory and unsafe values', () => {
    for (const patch of [
      { host: 'javascript:alert(1)' },
      { host: 'https://wiki.example.com/path' },
      { host: 'https://a:b@wiki.example.com' },
      { host: 'https://*' },
      { host: 'https://*.example.com' },
      { host: 'https://%2A.example.com' },
      { robots: ['index', 'noindex'] },
      { robots: ['all'] },
      { pageExtensions: ['.md'] },
      { pageExtensions: ['../a'] },
      { title: '' },
      { title: '<script>' },
      { contentLicense: 'unrecognized' },
      { editFab: 'true' },
      { editMenuExternalUrl: 'javascript:alert(1)' },
      { editMenuExternalIcon: '<svg>' },
      { analyticsId: 'unexpected' },
      { editMenuExternalBtn: true, editMenuExternalName: '', editMenuExternalUrl: '' }
    ])
      expect(validateGeneralPolicy({ ...valid(), ...patch }).ok).toBe(false)
  })
  it('builds external links without turning filenames into URL control characters', () => {
    expect(externalSourceUrl('https://git.example.com/src/{filename}', 'folder/a?b#c%.md')).toBe('https://git.example.com/src/folder/a%3Fb%23c%25.md')
    expect(externalSourceUrl('javascript:{filename}', 'a')).toBe('')
    expect(externalSourceUrl('https://user:pass@git.example.com/{filename}', 'a')).toBe('')
    expect(externalSourceUrl('//git.example.com/{filename}', 'a')).toBe('')
  })
})
