export interface SkillCommandCandidate {
  readonly name: string
  readonly description: string
}

const subsequenceScore = (target: string, query: string): number | null => {
  let previous = -1
  let score = 0
  for (const character of query) {
    const index = target.indexOf(character, previous + 1)
    if (index < 0) return null
    score += previous < 0 ? index * 2 : Math.max(0, index - previous - 1)
    previous = index
  }
  return score
}

const fieldScore = (target: string, query: string, fuzzy = true): number | null => {
  if (target === query) return 0
  if (target.startsWith(query)) return 10 + target.length - query.length
  const containedAt = target.indexOf(query)
  if (containedAt >= 0) return 100 + containedAt
  if (!fuzzy) return null
  const fuzzyScore = subsequenceScore(target, query)
  return fuzzyScore === null ? null : 200 + fuzzyScore
}

const compareNames = (left: string, right: string): number => {
  const leftName = left.toLowerCase()
  const rightName = right.toLowerCase()
  if (leftName < rightName) return -1
  if (leftName > rightName) return 1
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export const filterSkillsForCommand = <T extends SkillCommandCandidate>(skills: readonly T[], queryValue: string): T[] => {
  const query = queryValue.trim().toLowerCase()
  if (!query) return [...skills]

  return skills
    .map((skill, index) => {
      const nameScore = fieldScore(skill.name.toLowerCase(), query)
      const descriptionScore = fieldScore(skill.description.toLowerCase(), query, false)
      const score = nameScore ?? (descriptionScore === null ? null : 1_000 + descriptionScore)
      return { skill, index, score }
    })
    .filter((entry): entry is { skill: T; index: number; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || compareNames(left.skill.name, right.skill.name) || left.index - right.index)
    .map(entry => entry.skill)
}
