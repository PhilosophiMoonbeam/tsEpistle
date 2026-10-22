import type { GlossaryCatalogInput, GlossaryOperations } from '../../operations/glossary.ts'
import { ActionKernel, type ActionAuthority } from './kernel.ts'

export interface GlossaryReadActionDependencies {
  readonly operations: Pick<GlossaryOperations, 'list' | 'get'>
  readonly resolveRequester: (authority: ActionAuthority) => Promise<Express.User>
}

export const registerGlossaryReadActions = (kernel: ActionKernel, dependencies: GlossaryReadActionDependencies): void => {
  kernel.register('glossary.list', async (input, context) => {
    const requester = await dependencies.resolveRequester(context.authority)
    return dependencies.operations.list({ requester, sessionId: '' }, input as GlossaryCatalogInput)
  })
  kernel.register('glossary.get', async (rawInput, context) => {
    const input = rawInput as { id: number; locale: string }
    const requester = await dependencies.resolveRequester(context.authority)
    // Native projection is the only source of documentation metadata: it checks
    // current page ACLs, publication and password grants, including for API keys.
    const term = await dependencies.operations.get({ requester, sessionId: '' }, input.id, input.locale)
    return {
      id: term.id,
      revision: term.revision,
      locale: term.locale,
      term: term.term,
      expansion: term.expansion,
      category: term.category,
      definition: term.definition,
      aliases: term.aliases,
      relatedTerms: term.relatedTerms,
      references: term.references,
      documentation: term.documentation,
      updatedAt: term.updatedAt
    }
  })
}
