import fs from 'node:fs'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

const source = fs.readFileSync(new URL('./agent-admin.vue', import.meta.url), 'utf8')
const payloadSource = source.slice(source.indexOf('const mediaPayload ='), source.indexOf('const profilePayload ='))
const payload = new Function('profileDraft', `${payloadSource}; return mediaPayload()`)
const draft = { transportKind: 'gemini-api', mediaAttachments: false, mediaImages: false, mediaSpeech: false, mediaVideo: false, mediaMusic: false, videoInputRate: '1500000', videoOutputRate: '17500000', videoTextOutputRate: '9000000', musicSongRate: '80000' }

describe('provider generation configuration', () => {
  it('omits media configuration until an administrator enables it and for other transports', () => {
    expect(payload(draft)).toEqual({})
    expect(payload({ ...draft, transportKind: 'openai-responses', mediaVideo: true, mediaMusic: true })).toEqual({})
  })
  it('serializes explicit generation pricing without enabling unrelated capabilities', () => {
    expect(payload({ ...draft, mediaVideo: true, mediaMusic: true, videoInputRate: '1800000', musicSongRate: '90000' })).toEqual({ media: {
      attachments: false,
      videoGeneration: { model: 'gemini-omni-1.1-flash', pricingRevision: 'video-v1|1800000|17500000', textOutputMicrosPerMillionTokens: 9000000, usagePolicy: 'reported-or-estimated' },
      musicGeneration: { model: 'lyria-3.5', costMicrosPerSong: 90000, usagePolicy: 'reported-or-estimated' }
    } })
  })
  it('preserves independent image and speech rates when adding generation', () => {
    expect(payload({ ...draft, mediaImages: true, imageInputRate: '50', imageOutputRate: '60', mediaSpeech: true, speechInputRate: '70', speechOutputRate: '80', mediaMusic: true }).media).toMatchObject({
      imageGeneration: { model: 'gemini-3.1-flash-image', pricingRevision: 'gemini-image-v1|50|60' },
      transcription: { model: 'gemini-3.5-transcribe', pricingRevision: 'gemini-speech-v1|70|80' }
    })
  })
})
