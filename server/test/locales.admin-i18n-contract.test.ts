import { describe, expect, it } from './bun-test.mts'
import english from '../locales/en.json'
import { translateEnglish } from '../../client/test/english-translate.mts'

const pluralCases = [
  ['common:agentComposer.creationToolEnabledAssistant', 'creation tool', 'creation tools'],
  ['common:offlineLibrary.searchingSavedPage', 'saved page', 'saved pages'],
  ['common:offlineLibrary.matchingSavedPage', 'saved page', 'saved pages'],
  ['common:offlineLibrary.savedPageDevice', 'saved page', 'saved pages'],
  ['common:offlineSettings.savedPageUsing', 'saved page', 'saved pages'],
  ['common:agentContextPicker.addingSource', 'source', 'sources'],
  ['common:agentContextPicker.sourcePendingResultShown', 'source', 'sources'],
  ['common:agentContextPicker.resultShown', 'result', 'results'],
  ['common:agentMemoryManager.matchingMemories', 'memory', 'memories'],
  ['common:agentMemoryManager.saved', 'record', 'records'],
  ['common:agentMemoryManager.sectionWouldExceedLimit', 'character', 'characters'],
  ['common:agentMemoryManager.charactersWillRemainSection', 'character', 'characters'],
  ['common:agentComposer.matchingSkills', 'skill', 'skills'],
  ['common:agentGoalStatus.completedRun', 'run', 'runs'],
  ['common:agentPersonalSkills.skill', 'skill', 'skills'],
  ['common:offlineSettings.localDraftProtectedReconnect', 'draft', 'drafts'],
  ['common:tags.tagFollowedOfflineSaving', 'tag', 'tags'],
  ['common:agentContextPicker.addSelectedSource', 'source', 'sources'],
  ['common:agentHistoryPanel.conversations2', 'conversation', 'conversations']
] as const

const resolve = (key: string): string => key.split('.').reduce((node, segment) => (node as Record<string, unknown>)[segment], english.common as unknown) as string
const tokens = (value: string): string[] => [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]!).sort()

describe('new English count forms and interpolation contract', () => {
  it('keeps matching interpolation tokens in all English singular/plural pairs', () => {
    const visit = (tree: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(tree)) {
        if (typeof value === 'object' && value !== null) visit(value as Record<string, unknown>)
        if (!key.endsWith('_one') || typeof value !== 'string') continue
        const other = tree[`${key.slice(0, -4)}_other`]
        expect(typeof other).toBe('string')
        expect(tokens(value)).toEqual(tokens(other as string))
      }
    }
    visit(english as Record<string, unknown>)
  })

  for (const [key, singular, plural] of pluralCases) {
    it(`uses grammatical forms and matching placeholders for ${key}`, () => {
      const path = key.slice('common:'.length)
      const one = resolve(`${path}_one`)
      const other = resolve(`${path}_other`)
      expect(tokens(one)).toEqual(tokens(other))
      expect(translateEnglish(key, { count: 1, resultSummary: '1 result shown.', more: '', managedBytes: '1 KiB', capacity: '' })).toContain(singular)
      expect(translateEnglish(key, { count: 2, resultSummary: '2 results shown.', more: '', managedBytes: '2 KiB', capacity: '' })).toContain(plural)
      expect(translateEnglish(key, { count: 0, resultSummary: '0 results shown.', more: '', managedBytes: '0 KiB', capacity: '' })).toContain(plural)
    })
  }

  it('renders the composed status and rejects numeric placeholder names', () => {
    expect(translateEnglish('common:agentContextPicker.sourcePendingResultShown', {
      count: 2, resultSummary: translateEnglish('common:agentContextPicker.resultShown', { count: 1 })
    })).toBe('2 sources pending. 1 result shown.')
    expect(translateEnglish('common:agentAssetPicker.kb', { sizeKb: 3 })).toBe('3 KB')
    expect(translateEnglish('common:offlineLibrary.savedPageRemovedLocally3', { detail: 'retry' })).toContain('retry')
    expect(translateEnglish('common:agentMemoryManager.showingLastLoadedMemory', { prefix: 'Saved. ', reason: 'Offline' })).toBe('Saved. Showing last-loaded memory. Offline')
  })
})
