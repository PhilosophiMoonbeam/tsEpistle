import knexModule from 'knex'
import { resetAgentDailyTokenQuota } from '../agents/coordinator.ts'

const { knex: createKnex } = knexModule

export const parseQuotaResetOwnerId = (args: readonly string[]): number => {
  if (args.length !== 2 || args[0] !== '--owner-id' || !/^[1-9][0-9]*$/u.test(args[1] ?? '')) {
    throw new Error('Usage: bun server/scripts/agent-reset-daily-tokens.ts --owner-id <positive-user-id>')
  }
  const ownerId = Number(args[1])
  if (!Number.isSafeInteger(ownerId)) throw new Error('Owner ID must be a positive safe integer')
  return ownerId
}

const main = async (): Promise<void> => {
  const ownerId = parseQuotaResetOwnerId(process.argv.slice(2))
  const connection = process.env.AGENT_MAINTENANCE_DATABASE_URL?.trim()
  if (!connection) throw new Error('AGENT_MAINTENANCE_DATABASE_URL is required')
  const knex = createKnex({ client: 'pg', connection, pool: { min: 0, max: 1 } })
  try {
    const result = await resetAgentDailyTokenQuota(knex, ownerId)
    process.stdout.write(`${JSON.stringify({ reset: 'complete', scope: 'owner-current-utc-day-tokens', ...result })}\n`)
  } finally {
    await knex.destroy()
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    process.stderr.write('Daily token quota reset failed. Verify the owner ID, database connection, and applied migrations.\n')
    process.exitCode = 1
  }
}
