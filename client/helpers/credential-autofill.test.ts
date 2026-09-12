import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../server/test/bun-test.mts'
import { protectCredentialControl } from './credential-autofill.ts'

const protectedAttributes = {
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other'
}

describe('credential autofill protection', () => {
  it.each([
    ['text', 'off'],
    ['number', 'off'],
    ['password', 'new-password']
  ])('protects a native %s input', (type, autocomplete) => {
    const dom = new JSDOM(`<div><input type="${type}"></div>`)
    const root = dom.window.document.querySelector('div') as HTMLElement
    const control = root.querySelector('input') as HTMLInputElement

    protectCredentialControl(root)

    expect(control.getAttribute('autocomplete')).toBe(autocomplete)
    for (const [name, value] of Object.entries(protectedAttributes)) expect(control.getAttribute(name)).toBe(value)
  })

  it('protects a native textarea and leaves an empty wrapper alone', () => {
    const dom = new JSDOM('<textarea></textarea><div></div>')
    const control = dom.window.document.querySelector('textarea') as HTMLElement

    protectCredentialControl(control)
    protectCredentialControl(dom.window.document.querySelector('div') as HTMLElement)

    expect(control.getAttribute('autocomplete')).toBe('off')
    for (const [name, value] of Object.entries(protectedAttributes)) expect(control.getAttribute(name)).toBe(value)
  })

  it('is required by every dynamic authentication and storage text control', () => {
    const auth = fs.readFileSync('client/components/admin/admin-auth-fields.vue', 'utf8')
    const storage = fs.readFileSync('client/components/admin/admin-storage.vue', 'utf8')

    expect(auth.match(/v-credential-autofill/g)).toHaveLength(5)
    expect(storage.match(/v-credential-autofill/g)).toHaveLength(5)
  })
})
