import fs from 'node:fs'
import { describe, expect, it } from '../../../server/test/bun-test.mts'

// Browsers indent <dd> by 40px (margin-inline-start). Every description list in
// the security workspace aligns its values with their labels instead.
describe('security workspace description lists', () => {
  it('resets the browser dd indent wherever a dd rule sets a margin', () => {
    const css = fs.readFileSync('client/components/admin/security-workspace.scss', 'utf8')
    const rules = Array.from(css.matchAll(/\bdd\s*\{([^{}]*)/gu), match => match[1]!).filter(rule => rule.includes('margin'))
    expect(rules.length).toBeGreaterThanOrEqual(3)
    for (const rule of rules) {
      expect(rule).toMatch(/(?:^|[;\s])margin:\s*[\d.]+(?:px|rem)?\s+0\s+0\s*;/u)
      expect(rule).not.toMatch(/margin-top:/u)
    }
  })
})
