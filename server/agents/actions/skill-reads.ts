import type { AgentActionName } from '../../../shared/agents/contracts.ts'
import { SkillRuntime } from '../skills/runtime.ts'
import { ActionKernel, ActionKernelError } from './kernel.ts'

export const registerSkillReadActions = (kernel: ActionKernel, runtime: SkillRuntime): void => {
  kernel.register('skills.list', async (_input, context) => {
    if (context.authority.requester.kind !== 'apiKey') throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'MCP skill reads require an API key', 401)
    const skills = await runtime.listVisibleForApiKey({
      principal: {
        apiKeyId: context.authority.requester.apiKeyId,
        groupIds: context.authority.groupIds
      },
      transportRequestId: context.authority.requestId
    })
    return {
      skills: skills.slice(0, 100).map(skill => ({
        name: skill.name,
        description: skill.description,
        versionId: skill.versionId,
        contentHash: skill.contentHash
      }))
    }
  })

  kernel.register('skills.read', async (rawInput, context) => {
    if (context.authority.requester.kind !== 'apiKey') throw new ActionKernelError('AUTHENTICATION_REQUIRED', 'MCP skill reads require an API key', 401)
    const input = rawInput as { name: string; versionId: string; path: string }
    const resource = await runtime.readVisibleResourceForApiKey({
      skillName: input.name,
      versionId: input.versionId,
      path: input.path,
      principal: {
        apiKeyId: context.authority.requester.apiKeyId,
        groupIds: context.authority.groupIds
      },
      transportRequestId: context.authority.requestId
    })
    if (!resource.mediaType.startsWith('text/') && resource.mediaType !== 'application/json') {
      throw new ActionKernelError('SKILL_RESOURCE_BINARY', 'Binary skill resources must be read through the MCP resource interface', 409)
    }
    return {
      name: resource.name,
      versionId: resource.versionId,
      path: resource.path,
      mediaType: resource.mediaType,
      contentHash: resource.contentHash,
      content: resource.bytes.toString('utf8')
    }
  })
}

export const SKILL_ACTION_NAMES = ['skills.list', 'skills.read'] as const satisfies readonly AgentActionName[]
