import { SUBAGENT_READ_ACTIONS } from '../orchestration.ts'
import type { AxHarnessFunction } from './session-harness.ts'
import { TOOL_DISCOVERY_CATEGORIES, type ToolDiscoveryCategory } from './tool-discovery.ts'

export interface InitialToolCategoriesOptions {
  readonly child?: boolean
}

const NO_TOOL_CATEGORIES: readonly ToolDiscoveryCategory[] = Object.freeze([])
const TOOL_CATEGORY_MASK = {
  explore: 1 << 0,
  history: 1 << 1,
  canonical: 1 << 2,
  authoring: 1 << 3,
  browser: 1 << 4
} as const satisfies Readonly<Record<ToolDiscoveryCategory, number>>

const isSubagentReadAction = (name: AxHarnessFunction['name']): boolean => (SUBAGENT_READ_ACTIONS as readonly string[]).includes(name)

const promptInjectionPattern =
  /\b(?:ignore|disregard|override|forget)\b.{0,48}\b(?:all\s+)?(?:previous|prior|earlier|above|system|developer)\s+(?:instructions?|prompts?|rules?|messages?)\b|\b(?:reveal|print|show)\b.{0,24}\b(?:the\s+)?(?:system|developer)\s+(?:prompt|instructions?)\b/iu

const activeRequestText = (message: string): string =>
  message
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/"[^"\n]*"|“[^”]*”|‘[^’]*’/gu, ' ')
    .replace(/(^|\s)'[^'\n]+'(?=$|\s|[.,!?;:])/gu, '$1 ')
    .replace(/^\s*>.*$/gmu, ' ')

const hasHistoryIntent = (text: string): boolean => {
  const hasPageReference = /\b(?:wiki\s+)?(?:page|article)\b|\bthis\s+wiki\b/iu.test(text)
  const hasRetrievalRequest = /\b(?:compare|diff|contrast|show|list|get|read|view|review|inspect|open|fetch|retrieve|find|tell\s+me|what|how|when|which)\b/iu.test(text)
  const hasDirectHistoryRequest = /\b(?:compare|diff|contrast|show|list|get|read|view|review|inspect|open|fetch|retrieve|find)\b/iu.test(text)
  const pageHistoryPhrase =
    /\b(?:page|wiki)\s+(?:edit|change|version|revision)\s+history\b/iu.test(text) ||
    /\b(?:history|versions?|revisions?)\b.{0,48}\b(?:of|for|on|between)\s+(?:this|that|the|current|selected)\s+(?:wiki\s+)?(?:page|article)\b/iu.test(text) ||
    /\b(?:this|that|the|current|selected|wiki)\s+(?:page|article)\b.{0,48}\b(?:history|versions?|revisions?)\b/iu.test(text)
  const versionHistoryPhrase = /\b(?:version|revision)\s+history\b/iu.test(text)
  const versionComparison = /\b(?:compare|diff|contrast)\b.{0,64}\b(?:versions?|revisions?|edits?|changes?)\b/iu.test(text) && hasPageReference
  const previousVersionRequest =
    hasPageReference &&
    hasDirectHistoryRequest &&
    /\b(?:previous|prior|older|historical|earlier|past)\s+(?:version|revision)\b/iu.test(text)
  const summarizedHistoricalVersion =
    hasPageReference &&
    /\b(?:summari[sz]e|(?:give|provide)\s+(?:me\s+)?a\s+summary\s+of)\b.{0,64}\b(?:(?:previous|prior|older|historical|earlier|past)\s+(?:version|revision)|(?:version|revision)\s+#?\d+)\b/iu.test(
      text
    )
  if (
    (pageHistoryPhrase && hasRetrievalRequest) ||
    (versionHistoryPhrase && (hasDirectHistoryRequest || (hasPageReference && hasRetrievalRequest))) ||
    versionComparison ||
    previousVersionRequest ||
    summarizedHistoricalVersion
  )
    return true

  if (!hasPageReference) return false
  const historicalDate =
    /\b(?:on|as\s+of|from|at|in)\s+(?:\d{4}(?:[-/]\d{1,2}(?:[-/]\d{1,2})?)?|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?)/iu.test(
      text
    )
  const requestedHistoricalPage =
    /\b(?:read|view|fetch|retrieve|open|show|get|compare)\b.{0,72}\b(?:page|article)\b/iu.test(text) ||
    /\b(?:what|how|when)\b.{0,48}\b(?:page|article)\b.{0,48}\b(?:say|said|look|looked|contain|contained|show|showed|include|included)\b/iu.test(text)
  const relativeHistoryRequest =
    /\b(?:what|how|when)\b.{0,48}\b(?:page|article)\b.{0,48}\b(?:say|said|look|looked|contain|contained|show|showed|include|included)\b.{0,32}\b(?:previously|before|after|last\s+(?:year|month|week)|earlier|historically)\b/iu.test(
      text
    )
  return (historicalDate && requestedHistoricalPage) || relativeHistoryRequest
}

const hasExploreIntent = (text: string): boolean => {
  const taxonomyCommand =
    /\b(?:list|browse|show|search|explore|find|look\s+up|enumerate|discover)\b.{0,42}\b(?:wiki\s+)?(?:tags?|taxonomies|taxonomy)\b/iu.test(text) ||
    /\b(?:tags?|taxonomy|taxonomies)\b.{0,42}\b(?:list|browse|show|search|explore|find|look\s+up|enumerate|discover)\b/iu.test(text) ||
    /\b(?:what|which)\s+(?:(?:are|is)\s+)?(?:the\s+)?(?:available|existing|all|wiki)?\s*tags?\b/iu.test(text) ||
    /\b(?:what|which)\s+tags?\b.{0,32}\b(?:available|exist|used|defined|has|have)\b/iu.test(text)
  const taggedPagesCommand =
    /\b(?:browse|show|search|find|explore|list|discover)\b.{0,42}\b(?:pages?|articles?)\b.{0,28}\b(?:tagged|with\s+(?:the\s+)?tag|by\s+tag)\b/iu.test(text) ||
    /\b(?:tagged|with\s+(?:the\s+)?tag|by\s+tag)\b.{0,32}\b(?:pages?|articles?)\b/iu.test(text) &&
      /\b(?:browse|show|search|find|explore|list|discover)\b/iu.test(text)
  const pathBrowseCommand =
    /\b(?:browse|explore|navigate|list|show|find|discover)\b.{0,56}\b(?:pages?|articles?|wiki)\b.{0,56}(?:\b(?:under|beneath|inside|within|in\s+the\s+path|path|folder|directory|subtree)\b|\/[^\s,;!?]+)/iu.test(
      text
    ) ||
    /\b(?:browse|explore|navigate|list|show|find|discover)\b.{0,48}\b(?:wiki\s+path|page\s+path|wiki\s+subtree)\b/iu.test(text)
  return taxonomyCommand || taggedPagesCommand || pathBrowseCommand
}

const hasCanonicalIntent = (text: string): boolean => {
  const requestedFormat =
    /\b(?:okf|open\s+knowledge\s+format)\b/iu.test(text) ||
    /\bcanonical\s+(?:wiki\s+)?(?:page|document|representation|resource|source|version|output|copy)\b/iu.test(text) ||
    /\b(?:page|document|representation|resource|source|output)\b.{0,28}\bcanonical\b/iu.test(text) ||
    /\bcanonical\s+format\b.{0,32}\b(?:page|article|wiki|document|source)\b/iu.test(text)
  const explicitRequest = /\b(?:get|read|fetch|retrieve|show|give|have|provide|return|export|render|open|download|use|need|want|convert|format)\b/iu.test(text)
  return requestedFormat && explicitRequest
}

const hasAuthoringIntent = (text: string): boolean => {
  const directMutation =
    /\b(?:create|make|draft|write|edit|update|revise|rewrite|change|correct|fix|delete|remove|move|rename|restore|undelete)\s+(?:(?:a|an|the|this|that|new|existing|current|selected|all)\s+)*(?:wiki\s+)?(?:pages?|articles?|entries?)\b/iu.test(
      text
    )
  const contentMutation =
    /\b(?:add|insert|remove|replace|rewrite|correct|fix|change|update)\b.{0,48}\b(?:to|on|in|from)\s+(?:(?:the|this|that|current|selected)\s+)?(?:wiki\s+)?(?:page|article|entry)\b/iu.test(
      text
    )
  const requestedStateChange =
    /\b(?:(?:a|an|the|this|that|new|existing|current|selected|all)\s+)*(?:wiki\s+)?(?:pages?|articles?|entries?).{0,48}\b(?:should|needs?\s+to|must)\s+(?:be\s+)?(?:created|edited|updated|revised|rewritten|changed|corrected|fixed|deleted|removed|moved|renamed|restored)\b/iu.test(
      text
    )
  return directMutation || contentMutation || requestedStateChange
}

const hasBrowserIntent = (text: string): boolean =>
  /\b(?:search|browse|look\s+up|find|visit|open|go\s+to|navigate\s+to|fetch|read|use)\b.{0,48}\b(?:public\s+)?(?:web|internet|online|websites?|sites?)\b/iu.test(text) ||
  /\b(?:open|visit|browse|fetch|read|navigate\s+to|go\s+to)\b.{0,32}\b(?:https?:\/\/|www\.)\S+/iu.test(text)

export const initialToolCategoriesFor = (
  latestUserMessage: string,
  admittedActions: readonly AxHarnessFunction[],
  options: InitialToolCategoriesOptions = {}
): readonly ToolDiscoveryCategory[] => {
  if (promptInjectionPattern.test(latestUserMessage)) return NO_TOOL_CATEGORIES

  const text = activeRequestText(latestUserMessage)
  let requestedMask = 0
  if (hasHistoryIntent(text)) requestedMask |= TOOL_CATEGORY_MASK.history
  if (hasExploreIntent(text)) requestedMask |= TOOL_CATEGORY_MASK.explore
  if (hasCanonicalIntent(text)) requestedMask |= TOOL_CATEGORY_MASK.canonical
  if (hasAuthoringIntent(text)) requestedMask |= TOOL_CATEGORY_MASK.authoring
  if (hasBrowserIntent(text)) requestedMask |= TOOL_CATEGORY_MASK.browser
  if (requestedMask === 0) return NO_TOOL_CATEGORIES

  let admittedMask = 0
  for (const action of admittedActions) {
    if (action.group === 'core') continue
    if (options.child === true && !isSubagentReadAction(action.name)) continue
    admittedMask |= TOOL_CATEGORY_MASK[action.group]
  }

  const enabledMask = requestedMask & admittedMask
  if (enabledMask === 0) return NO_TOOL_CATEGORIES
  const categories: ToolDiscoveryCategory[] = []
  for (const category of TOOL_DISCOVERY_CATEGORIES) {
    if ((enabledMask & TOOL_CATEGORY_MASK[category]) !== 0) categories.push(category)
  }
  return Object.freeze(categories)
}

