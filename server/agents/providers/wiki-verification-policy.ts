import type { DecisionBatchQuestion, DecisionResult } from '../../../shared/agents/decision-providers.ts'
import { normalizeDecisionAnswer } from '../decision-providers.ts'

export const WIKI_VERIFICATION_POLICY_ID = 'wiki-evidence-probability-v2'
export const WIKI_VERIFICATION_MIN_PROBABILITY = 0.8

export interface WikiDecisionAssessment {
  readonly integrityValid: boolean
  readonly accepted: boolean
  readonly reason: 'accepted' | 'unexpected_choice' | 'insufficient_probability' | 'invalid_response'
  readonly answer: Pick<DecisionResult, 'choice' | 'probabilities' | 'confidence'> | null
}

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Native confidence is retained for diagnostics, not used as an acceptance gate. */
export const assessWikiDecisionAnswer = (value: unknown, criteria: DecisionBatchQuestion['criteria'], expectedChoice: string): WikiDecisionAssessment => {
  try {
    if (
      typeof criteria !== 'object' ||
      criteria === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(criteria)) ||
      typeof expectedChoice !== 'string' ||
      !Object.hasOwn(criteria, expectedChoice)
    ) {
      return { integrityValid: false, accepted: false, reason: 'invalid_response', answer: null }
    }
    const labels = Object.keys(criteria)
    if (
      labels.length < 1 ||
      labels.length > 255 ||
      labels.some(label => !label || label.length > 255 || hasControlCharacters(label) || ['__proto__', 'constructor', 'prototype'].includes(label))
    ) {
      return { integrityValid: false, accepted: false, reason: 'invalid_response', answer: null }
    }
    const answer = normalizeDecisionAnswer(value, criteria)
    if (answer.choice !== expectedChoice) {
      return { integrityValid: true, accepted: false, reason: 'unexpected_choice', answer }
    }
    if (!(answer.probabilities[answer.choice]! > WIKI_VERIFICATION_MIN_PROBABILITY)) {
      return { integrityValid: true, accepted: false, reason: 'insufficient_probability', answer }
    }
    return { integrityValid: true, accepted: true, reason: 'accepted', answer }
  } catch {
    return { integrityValid: false, accepted: false, reason: 'invalid_response', answer: null }
  }
}
