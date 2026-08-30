import type { AgentMemoryTarget } from '../memory.ts'
import { AgentMemoryRepository } from '../memory.ts'
import { AgentRepositoryError } from '../repository.ts'
import { ActionKernel } from './kernel.ts'

interface MemoryActionInput {
  readonly action: 'add' | 'replace' | 'remove'
  readonly target: AgentMemoryTarget
  readonly content?: string
  readonly oldText?: string
}

export const registerMemoryAction = (kernel: ActionKernel, memory: AgentMemoryRepository): void => {
  kernel.register('memory.manage', async (rawInput, context) => {
    if (context.authority.requester.kind !== 'user') throw new AgentRepositoryError('AUTHENTICATION_REQUIRED', 'Personal memory requires a user principal', 401)
    await context.fenceSideEffect()
    return memory.manage(context.authority.requester.userId, rawInput as MemoryActionInput)
  })
}
