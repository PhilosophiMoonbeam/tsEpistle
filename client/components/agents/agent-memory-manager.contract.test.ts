import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, test } from '../../../server/test/bun-test.mts'

const componentPath = join(process.cwd(), 'client/components/agents/agent-memory-manager.vue')
const source = readFileSync(componentPath, 'utf8')
const { descriptor, errors } = parse(source, { filename: componentPath })
const template = descriptor.template?.content ?? ''
const script = descriptor.scriptSetup?.content ?? ''

const occurrences = (value: string, fragment: string): number => value.split(fragment).length - 1

describe('Agent memory manager concise surface contract', () => {
  test('frames memory once with terse, icon-led sections and one saved-record count', () => {
    expect(errors).toEqual([])
    expect(template).toContain('A deliberate snapshot, not hidden learning.')
    expect(occurrences(template, 'A deliberate snapshot, not hidden learning.')).toBe(1)
    expect(occurrences(template, '{{ memoryCountLabel }}')).toBe(1)
    expect(template).toContain('class="agent-memory__count"')
    expect(template).toContain('aria-live="polite"')
    expect(script).toContain("title: 'You'")
    expect(script).toContain("title: 'Agent'")
    expect(script).toContain("icon: 'mdi-account-outline'")
    expect(script).toContain("icon: 'mdi-notebook-outline'")
  })

  test('derives an accurate pluralized count from both memory stores', () => {
    expect(script).toMatch(/memoryCount\s*=\s*computed\(\(\)\s*=>\s*memories\.value\.user\.entries\.length\s*\+\s*memories\.value\.agent\.entries\.length\)/)
    expect(script).toContain("memoryCount.value === 1 ? 'record' : 'records'")
    expect(template).not.toContain('agent-memory__scope')
    expect(template).not.toContain('agent-memory__capacity-copy')
    expect(template).not.toContain('agent-memory__capacity"')
  })

  test('removes the repeated archive, scope, and capacity filler', () => {
    for (const filler of [
      'Personal archive',
      'New conversations',
      'Review the durable details Wiki carries forward on your account.',
      'Scope &amp; retention',
      'Memory is copied into a conversation when it begins.',
      'Preferences, role, communication style, and durable working habits.',
      'Stable project, environment, convention, and workflow facts.',
      'characters used'
    ])
      expect(source).not.toContain(filler)
  })

  test('keeps memory operations, limits, announcements, and accessible action names', () => {
    expect(template).toContain(':counter="targetLimit"')
    expect(template).toContain(':maxlength="targetLimit"')
    expect(template).toContain('role="alert"')
    expect(template).toContain('role="status"')
    expect(template).toContain('aria-label="Loading agent memory"')
    expect(template).toContain('aria-label="Close agent memory"')
    expect(template).toMatch(/:aria-label="`Edit memory: \$\{entry\.content\}`"/)
    expect(template).toMatch(/:aria-label="`Remove memory: \$\{entry\.content\}`"/)
    expect(template).toContain('@click="save"')
    expect(template).toContain('@click="remove"')
    expect(template).toContain('@click="clear"')
    expect(template).toContain('@click="beginAdd()"')
  })

  test('retains account privacy, future-conversation scope, and snapshot safety', () => {
    expect(template).toContain('Private to your account.')
    expect(template).toContain('Changes apply to future conversations only.')
    expect(template).toContain('Never save passwords, keys, or tokens.')
    expect(template).toContain('Existing conversation snapshots are unchanged.')
    expect(template).toContain('Conversation history and existing memory snapshots are not affected.')
  })
})
