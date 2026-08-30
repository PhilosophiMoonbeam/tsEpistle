import { describe, expect, it } from '../../../server/test/bun-test.mts'

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
  it('normalizes command boundaries without mutating the source list', () => {
    const result = filterSkillsForCommand(skills, '  NOTES  ')
    expect(result.map(skill => skill.name)).toEqual(['release-notes'])
    expect(result).not.toBe(skills)
    expect(filterSkillsForCommand(skills, '')).not.toBe(skills)
  })

  it('keeps a mixed draft query on the trailing command token boundary', () => {
    const mixedDraft = 'Explain /release-notes'
    const command = /(^|\s)\/([^\s/]*)$/.exec(mixedDraft)
    expect(command?.[2]).toBe('release-notes')
    expect(filterSkillsForCommand(skills, command?.[2] ?? '').map(skill => skill.name)).toEqual(['release-notes'])
    expect(/(^|\s)\/([^\s/]*)$/.exec('Explain docs/release-notes')).toBeNull()
  })

  it('keeps equal-ranked duplicate names in their source order', () => {
    const duplicates = [
      { name: 'build', description: 'first' },
      { name: 'build', description: 'second' },
      { name: 'builder', description: 'same' }
    ]
    expect(filterSkillsForCommand(duplicates, 'build').map(skill => skill.description)).toEqual(['first', 'second', 'same'])
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
