import contributeOperations from '../../operations/contribute.ts'

export default {
  Query: {
    async contribute () { return {} }
  },
  ContributeQuery: {
    contributors: contributeOperations.listContributors
  }
}
