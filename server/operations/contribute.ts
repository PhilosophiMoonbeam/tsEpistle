import _ from 'lodash'

const contributorsQuery = '{\n  sponsors {\n    list(kind: BACKER) {\n      id\n      source\n      name\n      joined\n      website\n      twitter\n      avatar\n    }\n  }\n}\n'

const listContributors = async (): Promise<unknown[]> => {
  try {
    const response = await fetch('https://graph.requarks.io', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: contributorsQuery, variables: {} })
    })
    if (!response.ok) {
      throw new Error(`Contributor service returned ${response.status} ${response.statusText}`)
    }
    const body: unknown = await response.json()
    const contributors: unknown = _.get(body, 'data.sponsors.list', [])
    return Array.isArray(contributors) ? contributors : []
  } catch (error) {
    ;(WIKI.logger as { warn(error: unknown): void }).warn(error)
    return []
  }
}

export default { listContributors }
