import { describe, expect, it } from '../../../server/test/bun-test.mts'

import { filterPreferredBuiltInSkills, filterSkillsForCommand, filterUserSelectableSkills } from './agent-skill-command.ts'

const skills = [
  { name: 'release-notes', description: 'Prepare a production release', exposureMode: 'owner' as const },
  { name: 'qa-runbook', description: 'Check acceptance criteria and collect evidence', exposureMode: 'owner' as const },
  { name: 'wiki-authoring', description: 'Create compatible Wiki pages', exposureMode: 'owner' as const }
] as const

describe('skill command filtering', () => {
  it('shows every user-selectable skill for the opening command', () => {
    expect(filterSkillsForCommand(skills, '')).toEqual(skills)
  })

  it('excludes built-in and system defaults before showing or matching commands', () => {
    const mixedSkills = [
      skills[0],
      { name: 'system-default', description: 'Built-in instructions', exposureMode: 'all_agent_users' as const },
      { name: 'group-default', description: 'System instructions for a group', exposureMode: 'groups' as const },
      skills[1]
    ]

    expect(filterUserSelectableSkills(mixedSkills)).toEqual([skills[0], skills[1]])
    expect(filterSkillsForCommand(mixedSkills, '')).toEqual([skills[0], skills[1]])
    expect(filterSkillsForCommand(mixedSkills, 'default')).toEqual([])
    expect(filterSkillsForCommand(mixedSkills, 'instructions')).toEqual([])
  })

  it('adds only already-preferred built-ins to the manual picker as unpin escape hatches', () => {
    const mixedSkills = [
      { ...skills[0], versionId: 'personal-version' },
      { name: 'system-default', description: 'Built-in instructions', exposureMode: 'all_agent_users' as const, versionId: 'system-version' },
      { name: 'group-default', description: 'System instructions for a group', exposureMode: 'groups' as const, versionId: 'group-version' }
    ]
    const preferredVersionIds = { has: (versionId: string) => versionId === 'system-version' }
    const manualSkills = [...filterUserSelectableSkills(mixedSkills), ...filterPreferredBuiltInSkills(mixedSkills, preferredVersionIds)]

    expect(manualSkills.map(skill => skill.name)).toEqual(['release-notes', 'system-default'])
    expect(filterPreferredBuiltInSkills(mixedSkills, { has: () => false })).toEqual([])
    expect(filterSkillsForCommand(mixedSkills, '')).toEqual([mixedSkills[0]])
    expect(filterSkillsForCommand(mixedSkills, 'system')).toEqual([])
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
      { name: 'build', description: 'first', exposureMode: 'owner' as const },
      { name: 'build', description: 'second', exposureMode: 'owner' as const },
      { name: 'builder', description: 'same', exposureMode: 'owner' as const }
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
