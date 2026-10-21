import { z } from 'zod'

/** Official Workspace MCP endpoints; consent is restricted to the selected service. */
export const GOOGLE_WORKSPACE_MCP_SERVICES = [
  { id: 'gmail', label: 'Gmail', endpointUrl: 'https://gmailmcp.googleapis.com/mcp/v1', scopes: ['gmail.readonly', 'gmail.compose'] },
  { id: 'drive', label: 'Google Drive', endpointUrl: 'https://drivemcp.googleapis.com/mcp/v1', scopes: ['drive.readonly', 'drive.file'] },
  { id: 'docs', label: 'Google Docs', endpointUrl: 'https://docsmcp.googleapis.com/mcp/v1', scopes: ['drive.readonly', 'drive.file', 'documents.readonly', 'documents'] },
  { id: 'sheets', label: 'Google Sheets', endpointUrl: 'https://sheetsmcp.googleapis.com/mcp/v1', scopes: ['drive.readonly', 'drive.file', 'spreadsheets.readonly', 'spreadsheets'] },
  { id: 'slides', label: 'Google Slides', endpointUrl: 'https://slidesmcp.googleapis.com/mcp/v1', scopes: ['drive.readonly', 'drive.file', 'presentations.readonly', 'presentations'] },
  { id: 'calendar', label: 'Google Calendar', endpointUrl: 'https://calendarmcp.googleapis.com/mcp/v1', scopes: ['calendar.calendarlist.readonly', 'calendar.events.freebusy', 'calendar.events.readonly'] },
  { id: 'chat', label: 'Google Chat', endpointUrl: 'https://chatmcp.googleapis.com/mcp/v1', scopes: ['chat.spaces.readonly', 'chat.memberships.readonly', 'chat.messages.readonly', 'chat.messages.create', 'chat.users.readstate'] },
  { id: 'people', label: 'Google People', endpointUrl: 'https://people.googleapis.com/mcp/v1', scopes: ['directory.readonly', 'userinfo.profile', 'contacts.readonly'] },
  { id: 'classroom', label: 'Google Classroom', endpointUrl: 'https://classroommcp.googleapis.com/mcp/v1', scopes: ['classroom.announcements', 'classroom.courses.readonly', 'classroom.coursework.students', 'classroom.courseworkmaterials', 'classroom.rosters.readonly', 'classroom.student-submissions.students.readonly', 'classroom.topics.readonly'] }
].map(service => ({ ...service, scopes: service.scopes.map(scope => `https://www.googleapis.com/auth/${scope}`) }))

export interface ExternalMcpOAuthView {
  readonly configured: boolean
  readonly connected: boolean
  readonly scopes: readonly string[]
  readonly reconnectRequired: boolean
  readonly issuer?: string
  readonly registrationMode?: 'automatic' | 'preregistered'
  readonly callbackUrl?: string
}

export const ExternalMcpOAuthInputSchema = z.strictObject({
  preset: z.literal('google-workspace').optional(),
  issuer: z.string().max(2_048).url().optional(),
  scopes: z.array(z.string().min(1).max(2_048).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/u)).max(64).optional(),
  registrationMode: z.enum(['automatic', 'preregistered']).default('automatic'),
  clientId: z.string().min(1).max(2_048).optional(),
  clientSecretValue: z.string().min(1).max(8_192).nullable().optional(),
  tokenEndpointAuthMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional()
})
export type ExternalMcpOAuthInput = z.infer<typeof ExternalMcpOAuthInputSchema>
export interface ExternalMcpOAuthConfigurationView {
  readonly preset?: 'google-workspace'
  readonly issuer?: string
  readonly scopes?: readonly string[]
  readonly registrationMode: 'automatic' | 'preregistered'
  readonly clientId?: string
  readonly tokenEndpointAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic'
  readonly clientSecretConfigured: boolean
}

export const ExternalMcpServerInputSchema = z.strictObject({
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(value => {
      for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        if (code <= 0x1f || code === 0x7f) return false
      }
      return true
    }),
  endpointUrl: z.string().max(2_048).url(),
  status: z.enum(['enabled', 'disabled']),
  authMode: z.enum(['none', 'bearer', 'oauth']),
  oauth: ExternalMcpOAuthInputSchema.optional(),
  // Omitted keeps this endpoint's credential; authMode none removes it. References are never accepted.
  secretValue: z
    .string()
    .min(1)
    .max(8_192)
    .regex(/^[\x21-\x7e]+$/u)
    .nullable()
    .optional()
})
export const CreateAdminExternalMcpServerSchema = ExternalMcpServerInputSchema.extend({
  groupIds: z.array(z.number().int().positive()).max(1_000)
}).strict()
export const ExternalMcpGroupPolicyInputSchema = z.strictObject({ allowPersonalEndpoints: z.boolean() })
export const ExternalMcpGrantsInputSchema = z.strictObject({ groupIds: z.array(z.number().int().positive()).max(1_000) })
export type ExternalMcpServerInput = z.infer<typeof ExternalMcpServerInputSchema>
export type CreateAdminExternalMcpServerInput = z.infer<typeof CreateAdminExternalMcpServerSchema>

export interface ExternalMcpServerView {
  readonly id: string
  readonly displayName: string
  readonly endpointUrl: string
  readonly destinationHost: string
  readonly namespace: string
  readonly scope: 'admin' | 'personal'
  readonly ownerId: number | null
  readonly status: 'enabled' | 'disabled'
  readonly revision: number
  readonly authMode: 'none' | 'bearer' | 'oauth'
  readonly oauth?: ExternalMcpOAuthConfigurationView
  readonly secretConfigured: boolean
  readonly groupIds: readonly number[]
  readonly trust: 'untrusted'
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ExternalMcpGroupPolicyView {
  readonly groupId: number
  readonly allowPersonalEndpoints: boolean
  /** Zero means no saved policy; personal endpoints are denied by default. */
  readonly revision: number
}

/** Client catalogs/results are attributed external data, never Wiki evidence or authority. */
export interface ExternalMcpAttribution {
  readonly serverId: string
  readonly namespace: string
  readonly displayName: string
  readonly destinationHost: string
  readonly trust: 'untrusted'
  readonly authority: 'external'
}
