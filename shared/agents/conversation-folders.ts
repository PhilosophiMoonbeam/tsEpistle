export const cleanAgentConversationFolderName = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ')

export const agentConversationFolderNameKey = (cleanName: string): string => cleanName.toLowerCase()
