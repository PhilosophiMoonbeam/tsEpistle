const graphHelper = require('../../helpers/graph')
const importV1Operations = require('../../operations/import-v1')
const systemOperations = require('../../operations/system')

module.exports = {
  Query: {
    async system () { return {} }
  },
  Mutation: {
    async system () { return {} }
  },
  SystemQuery: {
    flags: systemOperations.listFlags,
    info: systemOperations.getInfo,
    extensions: systemOperations.listExtensions,
    exportStatus: systemOperations.getExportStatus
  },
  SystemMutation: {
    async updateFlags (obj, args) {
      try {
        await systemOperations.updateFlags(args.flags)
        return { responseResult: graphHelper.generateSuccess('System Flags applied successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async resetTelemetryClientId () {
      try {
        await systemOperations.resetTelemetryClientId()
        return { responseResult: graphHelper.generateSuccess('Telemetry state updated successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async setTelemetry (obj, args) {
      try {
        await systemOperations.setTelemetry(args.enabled)
        return { responseResult: graphHelper.generateSuccess('Telemetry Client ID has been reset successfully') }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    },
    async importUsersFromV1 (obj, args) {
      try {
        const result = await importV1Operations.importUsers(args)
        return {
          responseResult: graphHelper.generateSuccess('Import completed.'),
          ...result
        }
      } catch (err) {
        return graphHelper.generateError(err)
      }
    }
  }
}
