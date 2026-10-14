import { readFileSync } from 'node:fs'
import type { WikiContextReadinessRead } from '../../../agents/providers/wiki-context-readiness.ts'

const denseBody = readFileSync(new URL('./owned79-dense-policy.txt', import.meta.url), 'utf8')
const selection = JSON.parse(readFileSync(new URL('./wiki-synthesis-selection.json', import.meta.url), 'utf8')) as {
  id: string
  sourceReads: { evidenceId: string; sourceRevision: string; readId: string; title: string; source: string }[]
}[]
const quayOriginal = selection.find(fixture => fixture.id === 'selection-narrative-restriction-challenge')!.sourceReads[0]!
const dense: WikiContextReadinessRead = Object.freeze({
  evidenceId: 'fixture:owned79-dense-policy', sourceRevision: 'fixture:owned79-dense-policy-r1', readId: 'fixture:owned79-dense-policy-read',
  source: denseBody, authorText: denseBody, context: 'Meridian dense QA policies — fictional and non-operative'
})
const quay: WikiContextReadinessRead = Object.freeze({
  evidenceId: quayOriginal.evidenceId, sourceRevision: quayOriginal.sourceRevision, readId: quayOriginal.readId,
  source: quayOriginal.source, authorText: quayOriginal.source, context: quayOriginal.title
})

// Human-policy routing expectations, not native proof. No rubric fact inventory is sent to the decision.
export const wikiContextReadinessCases = Object.freeze([
  { id: 'dense-pronoun', expected: 'answerable', userRequest: 'How many named operators does it include?', conversationContext: 'User: Tell me about the Boreal pilot plan.\nAssistant: Boreal is a fictional pilot plan.', reads: [dense] },
  { id: 'quay-simple-fact', expected: 'answerable', userRequest: 'How long is a North Quay telescope-kit loan?', conversationContext: '', reads: [quay] },
  { id: 'dense-broad-summary', expected: 'answerable', userRequest: 'Summarize the pilot plans, including all material restrictions stated in this source.', conversationContext: '', reads: [dense] },
  { id: 'quay-broad-summary', expected: 'answerable', userRequest: 'Summarize the North Quay fictional loan program, including every material restriction stated in this source.', conversationContext: '', reads: [quay] },
  { id: 'dense-missing-linked-target', expected: 'collect', userRequest: 'What minimum order and quote requirements apply in the linked Meridian remote delivery annex?', conversationContext: '', reads: [dense] },
  { id: 'new-topic', expected: 'collect', userRequest: 'What are the current Westhaven swimming-pool opening hours?', conversationContext: 'User: Tell me about the Boreal pilot plan.\nAssistant: Boreal is a fictional pilot plan.', reads: [dense, quay] },
  { id: 'mixed-required-action', expected: 'collect', userRequest: 'Tell me the North Quay loan duration and reserve a telescope kit for me.', conversationContext: '', reads: [quay] },
  { id: 'corpus-wide-exhaustive', expected: 'collect', userRequest: 'Find every telescope lending program anywhere in this Wiki and compare all their material restrictions.', conversationContext: '', reads: [dense, quay] },
  { id: 'explicit-non-guarantee', expected: 'answerable', userRequest: 'Does the Meridian source establish a service uptime commitment?', conversationContext: '', reads: [dense] },
  { id: 'absence-is-not-non-guarantee', expected: 'collect', userRequest: 'Does North Quay guarantee weekend staffed-desk opening hours?', conversationContext: '', reads: [quay] },
  { id: 'two-read-bounded-comparison', expected: 'answerable', userRequest: 'Compare the return-window rule in the Meridian source with the return-location and inspection rules in the North Quay source, retaining their qualifications.', conversationContext: '', reads: [dense, quay] }
].map(entry => Object.freeze({
  id: entry.id,
  expected: entry.expected as 'answerable' | 'collect',
  input: Object.freeze({
    userRequest: entry.userRequest,
    conversationContext: entry.conversationContext,
    requestFacets: Object.freeze([entry.userRequest]),
    scope: Object.freeze({ type: 'all' }),
    reads: Object.freeze(entry.reads)
  })
})))
