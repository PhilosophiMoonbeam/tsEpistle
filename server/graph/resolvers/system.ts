import graphHelper from '../../helpers/graph.ts'
import importV1Operations from '../../operations/import-v1.ts'
import systemOperations from '../../operations/system.ts'

type ResolverArgs = Record<string, unknown>

export default {
  Query: { async system () { return {} } },
  Mutation: { async system () { return {} } },
  SystemQuery: {
    flags: systemOperations.listFlags,
    info: systemOperations.getInfo,
    extensions: systemOperations.listExtensions,
    exportStatus: systemOperations.getExportStatus
  },
  SystemMutation: {
    async updateFlags (_obj: unknown, args: ResolverArgs) {
      try {
        await systemOperations.updateFlags(args.flags)
        return { responseResult: graphHelper.generateSuccess('System Flags applied successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async resetTelemetryClientId () {
      try {
        await systemOperations.resetTelemetryClientId()
        return { responseResult: graphHelper.generateSuccess('Telemetry state updated successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async setTelemetry (_obj: unknown, args: ResolverArgs) {
      try {
        await systemOperations.setTelemetry(args.enabled)
        return { responseResult: graphHelper.generateSuccess('Telemetry Client ID has been reset successfully') }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    },
    async importUsersFromV1 (_obj: unknown, args: ResolverArgs) {
      try {
        const result = await importV1Operations.importUsers(args)
        return {
          responseResult: graphHelper.generateSuccess('Import completed.'),
          ...result
        }
      } catch (err: unknown) { return graphHelper.generateError(err) }
    }
  }
}
