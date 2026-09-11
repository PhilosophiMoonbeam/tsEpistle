import { z } from 'zod'

import { AGENT_ACTION_NAMES, TOOL_DISCOVERY_CONTROL_NAME, type AgentActionName, type AgentToolControlName } from '../../../shared/agents/contracts.ts'
import { SUBAGENT_READ_ACTIONS } from '../orchestration.ts'
import type { ActionGroup } from '../actions/catalog.ts'
import type { AxHarnessFunction } from './session-harness.ts'

export type ToolDiscoveryCategory = Exclude<ActionGroup, 'core'>

export const TOOL_DISCOVERY_CATEGORIES = ['explore', 'history', 'canonical', 'authoring', 'browser'] as const satisfies readonly ToolDiscoveryCategory[]

const SUBAGENT_READ_ACTION_SET: ReadonlySet<AgentActionName> = new Set(SUBAGENT_READ_ACTIONS)
const AGENT_ACTION_NAME_SET: ReadonlySet<string> = new Set(AGENT_ACTION_NAMES)

export interface ToolDiscoveryTool {
  readonly name: AgentActionName
  readonly description: string
}

export interface ToolDiscoveryCategoryIndex {
  readonly category: ToolDiscoveryCategory
  readonly tools: readonly ToolDiscoveryTool[]
}

export interface ToolDiscoveryEnableResult {
  readonly category: ToolDiscoveryCategory
  readonly enabled: true
  readonly tools: readonly ToolDiscoveryTool[]
}

export interface ToolDiscoveryControlFunction {
  readonly kind: 'control'
  readonly name: AgentToolControlName
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface ToolDiscoveryActionFunction {
  readonly kind: 'action'
  readonly action: AxHarnessFunction
}

export type ToolDiscoveryFunction = ToolDiscoveryActionFunction | ToolDiscoveryControlFunction

export interface ToolDiscoveryActionCall {
  readonly kind: 'action'
  readonly name: AgentActionName
}

export interface ToolDiscoveryControlCall {
  readonly kind: 'control'
  readonly name: AgentToolControlName
  readonly category: ToolDiscoveryCategory
}

export type ToolDiscoveryCall = ToolDiscoveryActionCall | ToolDiscoveryControlCall

export interface ToolDiscoveryTurn {
  readonly categoryIndex: readonly ToolDiscoveryCategoryIndex[]
  readonly activeFunctions: readonly AxHarnessFunction[]
  readonly functions: readonly ToolDiscoveryFunction[]
  readonly visibleNames: readonly AgentActionName[]
  readonly control: ToolDiscoveryControlFunction | null
}

export interface ToolDiscoveryOptions {
  readonly child?: boolean
}

export interface ToolDiscoveryController {
  readonly categoryIndex: readonly ToolDiscoveryCategoryIndex[]
  beginTurn(): ToolDiscoveryTurn
  previewNextTurn(category?: unknown): ToolDiscoveryTurn
  enable(category: unknown): ToolDiscoveryEnableResult | null
}

const freezeTools = (tools: readonly ToolDiscoveryTool[]): readonly ToolDiscoveryTool[] =>
  Object.freeze(tools.map(tool => Object.freeze({ name: tool.name, description: tool.description })))

const freezeCategoryIndex = (categories: readonly ToolDiscoveryCategoryIndex[]): readonly ToolDiscoveryCategoryIndex[] =>
  Object.freeze(categories.map(category => Object.freeze({ category: category.category, tools: freezeTools(category.tools) })))

const controlParameters = (categories: readonly ToolDiscoveryCategory[]): Record<string, unknown> => ({
  type: 'object',
  properties: {
    category: {
      type: 'string',
      enum: [...categories]
    }
  },
  required: ['category'],
  additionalProperties: false
})

const controlDescription = 'Enable one admitted Wiki tool category for the next turn.'

const actionAllowed = (action: AxHarnessFunction, options: ToolDiscoveryOptions): boolean => options.child !== true || SUBAGENT_READ_ACTION_SET.has(action.name)

const admittedFunctions = (actions: readonly AxHarnessFunction[], options: ToolDiscoveryOptions): readonly AxHarnessFunction[] =>
  Object.freeze(actions.filter(action => actionAllowed(action, options)))

const deriveCategoryIndex = (actions: readonly AxHarnessFunction[]): readonly ToolDiscoveryCategoryIndex[] => {
  const byCategory = new Map<ToolDiscoveryCategory, ToolDiscoveryTool[]>()
  for (const action of actions) {
    if (action.group === 'core') continue
    const tools = byCategory.get(action.group) ?? []
    tools.push({ name: action.name, description: action.description })
    byCategory.set(action.group, tools)
  }
  return freezeCategoryIndex(
    TOOL_DISCOVERY_CATEGORIES.filter(category => (byCategory.get(category)?.length ?? 0) > 0).map(category => ({ category, tools: byCategory.get(category)! }))
  )
}

const activeFunctions = (actions: readonly AxHarnessFunction[], enabledCategories: ReadonlySet<ToolDiscoveryCategory>): readonly AxHarnessFunction[] =>
  Object.freeze(actions.filter(action => action.group === 'core' || enabledCategories.has(action.group)))

const controlFor = (categories: readonly ToolDiscoveryCategory[]): ToolDiscoveryControlFunction | null => {
  if (categories.length === 0) return null
  return Object.freeze({
    kind: 'control' as const,
    name: TOOL_DISCOVERY_CONTROL_NAME,
    description: controlDescription,
    parameters: Object.freeze(controlParameters(categories))
  })
}

const viewFor = (
  actions: readonly AxHarnessFunction[],
  categoryIndex: readonly ToolDiscoveryCategoryIndex[],
  enabledCategories: ReadonlySet<ToolDiscoveryCategory>
): ToolDiscoveryTurn => {
  const active = activeFunctions(actions, enabledCategories)
  const visibleNames = Object.freeze(active.map(action => action.name))
  const control = controlFor(categoryIndex.map(entry => entry.category))
  const functions: ToolDiscoveryFunction[] = active.map(action => Object.freeze({ kind: 'action' as const, action }))
  if (control) functions.push(control)
  return Object.freeze({
    categoryIndex,
    activeFunctions: active,
    functions: Object.freeze(functions),
    visibleNames,
    control
  })
}

const enableResultFor = (categoryIndex: readonly ToolDiscoveryCategoryIndex[], category: ToolDiscoveryCategory): ToolDiscoveryEnableResult | null => {
  const entry = categoryIndex.find(candidate => candidate.category === category)
  if (!entry) return null
  return Object.freeze({ category, enabled: true as const, tools: entry.tools })
}

class EphemeralToolDiscoveryController implements ToolDiscoveryController {
  readonly #actions: readonly AxHarnessFunction[]
  readonly #categoryIndex: readonly ToolDiscoveryCategoryIndex[]
  readonly #enabledCategories = new Set<ToolDiscoveryCategory>()
  readonly #pendingCategories = new Set<ToolDiscoveryCategory>()

  constructor(actions: readonly AxHarnessFunction[], options: ToolDiscoveryOptions) {
    this.#actions = admittedFunctions(actions, options)
    this.#categoryIndex = deriveCategoryIndex(this.#actions)
  }

  get categoryIndex(): readonly ToolDiscoveryCategoryIndex[] {
    return this.#categoryIndex
  }

  beginTurn(): ToolDiscoveryTurn {
    for (const category of this.#pendingCategories) this.#enabledCategories.add(category)
    this.#pendingCategories.clear()
    return viewFor(this.#actions, this.#categoryIndex, this.#enabledCategories)
  }

  previewNextTurn(category?: unknown): ToolDiscoveryTurn {
    const categories = new Set<ToolDiscoveryCategory>(this.#enabledCategories)
    for (const pending of this.#pendingCategories) categories.add(pending)
    if (isToolDiscoveryCategory(category) && this.#categoryIndex.some(entry => entry.category === category)) categories.add(category)
    return viewFor(this.#actions, this.#categoryIndex, categories)
  }

  enable(category: unknown): ToolDiscoveryEnableResult | null {
    if (!isToolDiscoveryCategory(category)) return null
    const result = enableResultFor(this.#categoryIndex, category)
    if (!result) return null
    if (!this.#enabledCategories.has(category)) this.#pendingCategories.add(category)
    return result
  }
}

export const createToolDiscovery = (actions: readonly AxHarnessFunction[], options: ToolDiscoveryOptions = {}): ToolDiscoveryController =>
  new EphemeralToolDiscoveryController(actions, options)

export const isToolDiscoveryCategory = (value: unknown): value is ToolDiscoveryCategory =>
  typeof value === 'string' && (TOOL_DISCOVERY_CATEGORIES as readonly string[]).includes(value)

export const toolDiscoveryControlSchema = (categories: readonly ToolDiscoveryCategory[]): z.ZodType<{ readonly category: ToolDiscoveryCategory }> => {
  if (categories.length === 0) return z.never() as z.ZodType<{ readonly category: ToolDiscoveryCategory }>
  const admitted = categories.filter(isToolDiscoveryCategory)
  if (admitted.length === 0) return z.never() as z.ZodType<{ readonly category: ToolDiscoveryCategory }>
  return z.strictObject({ category: z.enum(admitted as [ToolDiscoveryCategory, ...ToolDiscoveryCategory[]]) })
}

export const resolveToolDiscoveryCall = (turn: ToolDiscoveryTurn, name: string, input: unknown): ToolDiscoveryCall | null => {
  if (name === TOOL_DISCOVERY_CONTROL_NAME) {
    const parsed = toolDiscoveryControlSchema(turn.categoryIndex.map(entry => entry.category)).safeParse(input)
    if (!parsed.success) return null
    return Object.freeze({ kind: 'control', name: TOOL_DISCOVERY_CONTROL_NAME, category: parsed.data.category })
  }
  if (!AGENT_ACTION_NAME_SET.has(name) || !turn.visibleNames.includes(name as AgentActionName)) return null
  return Object.freeze({ kind: 'action', name: name as AgentActionName })
}

export const deriveToolDiscovery = (
  actions: readonly AxHarnessFunction[],
  enabledCategories: readonly ToolDiscoveryCategory[] = [],
  options: ToolDiscoveryOptions = {}
): ToolDiscoveryTurn => {
  const admitted = admittedFunctions(actions, options)
  const categoryIndex = deriveCategoryIndex(admitted)
  const admittedCategories = new Set(categoryIndex.map(entry => entry.category))
  const enabled = new Set(enabledCategories.filter(category => admittedCategories.has(category)))
  return viewFor(admitted, categoryIndex, enabled)
}
