export type PersonalMcpClient = 'claude-code' | 'cursor' | 'vscode-local'

// Only the server-provided endpoint is interpolated. Issued keys must stay in
// the separate one-time secret flow, never in a reusable setup snippet.
export function formatPersonalMcpSetup(client: PersonalMcpClient, endpoint: string): string {
  if (client === 'vscode-local') {
    return JSON.stringify(
      {
        servers: {
          wiki: { type: 'http', url: endpoint, headers: { Authorization: `Bearer \${input:wiki-mcp-key}` } }
        },
        inputs: [{ type: 'promptString', id: 'wiki-mcp-key', description: 'Wiki MCP key', password: true }]
      },
      null,
      2
    )
  }
  return JSON.stringify(
    {
      mcpServers: {
        wiki: {
          ...(client === 'claude-code' ? { type: 'http' } : {}),
          url: endpoint,
          headers: { Authorization: client === 'claude-code' ? `Bearer \${WIKI_MCP_KEY}` : `Bearer \${env:WIKI_MCP_KEY}` }
        }
      }
    },
    null,
    2
  )
}
