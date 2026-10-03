import fs from 'node:fs'
import { describe, expect, it } from '../../../server/test/bun-test.mts'
import { agentProviderProtocolDefaults, isAgentProviderTransport } from '../../helpers/agent-provider-protocols.ts'

const source = fs.readFileSync(new URL('./agent-admin.vue', import.meta.url), 'utf8')
const payloadSource = source.slice(source.indexOf('const mediaPayload ='), source.indexOf('const profilePayload ='))
const payload = new Function('profileDraft', `${payloadSource}; return mediaPayload()`)
const draft = {
  transportKind: 'gemini-api',
  mediaAttachments: false,
  mediaImages: false,
  mediaSpeech: false,
  mediaVideo: false,
  mediaMusic: false,
  videoInputRate: '1500000',
  videoOutputRate: '17500000',
  videoTextOutputRate: '9000000',
  musicSongRate: '80000'
}

describe('provider generation configuration', () => {
  it('omits media configuration until an administrator enables it and for other transports', () => {
    expect(payload(draft)).toEqual({})
    expect(payload({ ...draft, transportKind: 'openai-responses', mediaVideo: true, mediaMusic: true })).toEqual({})
  })
  it('serializes explicit generation pricing without enabling unrelated capabilities', () => {
    expect(payload({ ...draft, mediaVideo: true, mediaMusic: true, videoInputRate: '1800000', musicSongRate: '90000' })).toEqual({
      media: {
        attachments: false,
        videoGeneration: {
          model: 'gemini-omni-1.1-flash',
          pricingRevision: 'video-v1|1800000|17500000',
          textOutputMicrosPerMillionTokens: 9000000,
          usagePolicy: 'reported-or-estimated'
        },
        musicGeneration: { model: 'lyria-3.5', costMicrosPerSong: 90000, usagePolicy: 'reported-or-estimated' }
      }
    })
  })
  it('preserves independent image and speech rates when adding generation', () => {
    expect(
      payload({
        ...draft,
        mediaImages: true,
        imageInputRate: '50',
        imageOutputRate: '60',
        mediaSpeech: true,
        speechInputRate: '70',
        speechOutputRate: '80',
        mediaMusic: true
      }).media
    ).toMatchObject({
      imageGeneration: { model: 'gemini-3.1-flash-image', pricingRevision: 'gemini-image-v1|50|60' },
      transcription: { model: 'gemini-3.5-transcribe', pricingRevision: 'gemini-speech-v1|70|80' }
    })
  })
})

const executable = (start: string, end: string): string =>
  new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(source.indexOf(start), source.indexOf(end)))

describe('provider editor interactions', () => {
  it('preserves customized endpoints but applies authentication required by the destination protocol', () => {
    const profileDraft = {
      ...agentProviderProtocolDefaults('legacy-completions'),
      transportKind: 'legacy-completions',
      baseUrl: 'https://api.example.com/v1',
      authMode: 'api-key-header',
      agentReasoningEffort: 'high',
      mediaAttachments: true
    }
    const selectProtocol = new Function(
      'profileDraft',
      'agentProviderProtocolDefaults',
      'isAgentProviderTransport',
      `${executable('const selectProtocol =', 'const selectToolCalling =')}; return selectProtocol`
    )(profileDraft, agentProviderProtocolDefaults, isAgentProviderTransport)
    selectProtocol('legacy-completions')
    expect(profileDraft.authMode).toBe('api-key-header')
    selectProtocol('openresponses')
    expect(profileDraft.baseUrl).toBe('https://api.example.com/v1')
    expect(profileDraft.authMode).toBe('bearer')
    selectProtocol('openai-chat')
    expect(profileDraft.baseUrl).toBe('https://api.example.com/v1')
    expect(profileDraft.authMode).toBe('bearer')
    expect(profileDraft.agentReasoningEffort).toBeNull()
    expect(profileDraft.mediaAttachments).toBe(false)
    Object.assign(profileDraft, agentProviderProtocolDefaults('openai-chat'))
    selectProtocol('anthropic-messages')
    expect(profileDraft.baseUrl).toBe(agentProviderProtocolDefaults('anthropic-messages').baseUrl)
    expect(profileDraft.authMode).toBe(agentProviderProtocolDefaults('anthropic-messages').authMode)
  })

  it('advances on Enter before the final step instead of saving an edited profile', () => {
    let advances = 0
    let saves = 0
    const index = { value: 2 }
    const submit = new Function(
      'profileStepIndex',
      'profileSteps',
      'nextProfileStep',
      'saveProfile',
      `${executable('const submitProfileStep =', 'const confirmRemove =')}; return submitProfileStep`
    )(
      index,
      { value: ['identity', 'models', 'connection', 'limits'] },
      () => {
        advances++
      },
      () => {
        saves++
      }
    )
    submit()
    expect(advances).toBe(1)
    expect(saves).toBe(0)
    index.value = 3
    submit()
    expect(saves).toBe(1)
  })

  it('rejects normalized private mapped IPv6 without rejecting public mapped or numeric origins', () => {
    const validate = new Function(
      'profileDraft',
      'computed',
      't',
      `${executable('const providerBaseUrlError =', 'const providerBaseUrlRule =')}; return providerBaseUrlError.value`
    )
    for (const baseUrl of ['https://2130706433/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://[::10.0.0.1]/v1']) {
      expect(
        validate(
          { baseUrl },
          (fn: () => string) => ({ value: fn() }),
          (key: string) => key
        )
      ).toBe('admin:agentAdmin.usePublicHttpsOrigin')
    }
    for (const baseUrl of ['https://[::ffff:8.8.8.8]/v1', 'https://134744072/v1', 'https://api.example.com/v1']) {
      expect(
        validate(
          { baseUrl },
          (fn: () => string) => ({ value: fn() }),
          (key: string) => key
        )
      ).toBe('')
    }
  })
  it('names the invalid timeout in footer guidance and becomes ready only when valid', () => {
    const profileDraft = {
      maxContextTokens: 128000,
      maxOutputTokens: 8192,
      dailyTokens: 1000000,
      dailyCostMicros: 10000000,
      reservationTokens: 32000,
      reservationCostMicros: 1000000,
      timeoutMs: 10,
      maxAttempts: 1
    }
    const footer = new Function(
      'profileDraft',
      'computed',
      't',
      'saving',
      'profileSteps',
      'profileDirty',
      `${executable('const integerInRange =', 'const requiredTextRule =')}
       ${executable('const profileRules =', 'const providerBaseUrlError =')}
       ${executable('const profileStepIsValid =', 'const profileStepValid =')}
       ${executable('const profileSaveState =', 'const previousProfileStep =')}
       return profileSaveState.value`
    )
    const t = (key: string, values?: Record<string, unknown>) =>
      key === 'admin:agentAdmin.reviewInvalidField'
        ? `${values?.step}: ${values?.field}`
        : key === 'admin:agentAdmin.mustWholeNumber'
          ? String(values?.label)
          : key
    expect(
      footer(profileDraft, (fn: () => string) => ({ value: fn() }), t, { value: false }, { value: [{ value: 'limits', title: 'Limits' }] }, { value: true })
    ).toBe('Limits: admin:agentAdmin.requestTimeout')
    profileDraft.timeoutMs = 1000
    expect(
      footer(profileDraft, (fn: () => string) => ({ value: fn() }), t, { value: false }, { value: [{ value: 'limits', title: 'Limits' }] }, { value: true })
    ).toBe('admin:agentAdmin.readyReviewSave')
  })
})

describe('provider administration refresh', () => {
  it('retains independent successful and prior data, retries only requested resources, and ignores superseded responses', async () => {
    const resourceState = Object.fromEntries(['runtime', 'profiles', 'browser', 'groups'].map(key => [key, { loaded: false, loading: false, error: '' }]))
    const runtime = { value: null }
    const toolInventory = { value: [] }
    const profiles = { value: [{ id: 'prior' }] }
    const browserTargets = { value: [] }
    const groups = { value: [{ id: 1 }] }
    const paths: string[] = []
    const deferred = Promise.withResolvers<unknown>()
    let delayProfiles = false
    let failProfiles = false
    const request = async (path: string) => {
      paths.push(path)
      if (path === '/_api/groups') throw new Error('Groups denied')
      if (path.endsWith('/runtime')) return { runtime: { enabled: true } }
      if (path.endsWith('/browser-targets')) return { targets: [{ id: 'target' }] }
      if (failProfiles) throw new Error('Profiles unavailable')
      if (delayProfiles) {
        delayProfiles = false
        return await deferred.promise
      }
      return { profiles: [{ id: 'fresh' }] }
    }
    const refresh = new Function(
      'disposed',
      'resourceControllers',
      'resourceState',
      'request',
      'runtime',
      'toolInventory',
      'profiles',
      'browserTargets',
      'groups',
      't',
      `${executable('const refreshResources =', 'const load =')}; return refreshResources`
    )(false, new Map(), resourceState, request, runtime, toolInventory, profiles, browserTargets, groups, (key: string) => key)
    await refresh(['runtime', 'profiles', 'browser', 'groups'])
    expect(profiles.value).toEqual([{ id: 'fresh' }])
    expect(groups.value).toEqual([{ id: 1 }])
    expect(resourceState.groups.error).toBe('Groups denied')
    expect(resourceState.profiles.loaded).toBe(true)
    failProfiles = true
    await refresh(['profiles'])
    expect(profiles.value).toEqual([{ id: 'fresh' }])
    expect(resourceState.profiles.error).toBe('Profiles unavailable')
    failProfiles = false
    paths.length = 0
    await refresh(['browser'])
    expect(paths).toEqual(['/_api/agents/admin/browser-targets'])
    delayProfiles = true
    const old = refresh(['profiles'])
    await refresh(['profiles'])
    deferred.resolve({ profiles: [{ id: 'obsolete' }] })
    await old
    expect(profiles.value).toEqual([{ id: 'fresh' }])
    expect(resourceState.profiles.loading).toBe(false)
  })
})
