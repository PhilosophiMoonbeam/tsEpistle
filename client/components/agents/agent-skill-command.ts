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

export const filterSkillsForCommand = <T extends SkillCommandCandidate>(skills: readonly T[], queryValue: string): T[] => {
  const query = queryValue.trim().toLocaleLowerCase()
  if (!query) return [...skills]

  return skills
    .map(skill => {
      const nameScore = fieldScore(skill.name.toLocaleLowerCase(), query)
      const descriptionScore = fieldScore(skill.description.toLocaleLowerCase(), query, false)
      const score = nameScore ?? (descriptionScore === null ? null : 1_000 + descriptionScore)
      return { skill, score }
    })
    .filter((entry): entry is { skill: T; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.skill.name.localeCompare(right.skill.name))
    .map(entry => entry.skill)
}
