import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { fetchExtensionsWorkspace } from './extensions-workspace-api.ts'

const response = (payload: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => payload
})

const extension = {
  key: 'git',
  title: 'Git',
  description: 'Git storage client.',
  installation: {
    boundary: 'application-image',
    detail: 'Supplied by the reviewed image.',
    recovery: 'Deploy a reviewed image, then refresh.'
  },
  capabilities: [
    {
      title: 'Git storage',
      detail: 'Synchronizes the configured target.',
      configuration: { label: 'Configure Git storage', path: '/storage', query: { section: 'targets', target: 'git' } }
    }
  ],
  dependencies: [{ title: 'Git executable', detail: 'Checked with a fixed command.' }],
  observation: {
    state: 'usable',
    compatibility: 'verified',
    evidence: 'The bounded executable check completed.',
    checkedAt: '2026-09-07T00:00:00.000Z'
  }
}

describe('extensions workspace transport', () => {
  it('loads the read-only deployment projection without accepting arbitrary route links', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ observedAt: '2026-09-07T00:00:00.000Z', extensions: [extension] }))

    await expect(fetchExtensionsWorkspace(fetchImpl)).resolves.toEqual({ observedAt: '2026-09-07T00:00:00.000Z', extensions: [extension] })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/extensions/workspace', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })

    const agentBrowser = vi.fn().mockResolvedValue(
      response({
        observedAt: '2026-09-07T00:00:00.000Z',
        extensions: [
          {
            ...extension,
            key: 'puppeteer',
            capabilities: [
              {
                title: 'No application-process renderer',
                detail: 'This application process has no browser renderer.',
                configuration: { label: 'Open Agent Browser', path: '/agents', hash: 'browser' }
              }
            ],
            observation: { ...extension.observation, state: 'not-provided', compatibility: 'not-applicable' }
          }
        ]
      })
    )
    await expect(fetchExtensionsWorkspace(agentBrowser)).resolves.toMatchObject({
      extensions: [{ capabilities: [{ configuration: { path: '/agents', hash: 'browser' } }] }]
    })

    const malformed = vi.fn().mockResolvedValue(
      response({
        observedAt: '2026-09-07T00:00:00.000Z',
        extensions: [
          { ...extension, capabilities: [{ ...extension.capabilities[0], configuration: { ...extension.capabilities[0].configuration, path: '/dev-flags' } }] }
        ]
      })
    )
    await expect(fetchExtensionsWorkspace(malformed)).rejects.toThrow('Extension observations could not be loaded.')
  })

  it('rejects unconfirmed observations and preserves actionable server errors', async () => {
    const malformed = vi.fn().mockResolvedValue(
      response({
        observedAt: '2026-09-07T00:00:00.000Z',
        extensions: [{ ...extension, observation: { ...extension.observation, state: 'installed' } }]
      })
    )
    await expect(fetchExtensionsWorkspace(malformed)).rejects.toThrow('Extension observations could not be loaded.')

    const unavailable = vi.fn().mockResolvedValue(response({ error: 'Current system administration access is required.' }, false))
    await expect(fetchExtensionsWorkspace(unavailable)).rejects.toThrow('Current system administration access is required.')
  })
})
