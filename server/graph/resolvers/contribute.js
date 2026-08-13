const contributeOperations = require('../../operations/contribute')

module.exports = {
  Query: {
    async contribute () { return {} }
  },
  ContributeQuery: {
    contributors: contributeOperations.listContributors
  }
}
