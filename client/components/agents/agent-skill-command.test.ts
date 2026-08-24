import { describe, expect, it } from 'vitest'

import { filterSkillsForCommand } from './agent-skill-command.ts'

const skills = [
  { name: 'release-notes', description: 'Prepare a production release' },
  { name: 'qa-runbook', description: 'Check acceptance criteria and collect evidence' },
  { name: 'wiki-authoring', description: 'Create compatible Wiki pages' }
]

describe('skill command filtering', () => {
  it('shows every skill for the opening command', () => {
    expect(filterSkillsForCommand(skills, '')).toEqual(skills)
  })

  it('progressively ranks name prefixes, substrings, and fuzzy subsequences', () => {
    expect(filterSkillsForCommand(skills, 'q').map(skill => skill.name)).toEqual(['qa-runbook'])
    expect(filterSkillsForCommand(skills, 'notes').map(skill => skill.name)).toEqual(['release-notes'])
    expect(filterSkillsForCommand(skills, 'rln').map(skill => skill.name)).toEqual(['release-notes'])
  })

  it('falls back to description matches and excludes unrelated skills', () => {
    expect(filterSkillsForCommand(skills, 'accept').map(skill => skill.name)).toEqual(['qa-runbook'])
    expect(filterSkillsForCommand(skills, 'unrelated')).toEqual([])
  })
})
