import type { ObjectDirective } from 'vue'

const managerOptOutAttributes = {
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other'
} as const

export const protectCredentialControl = (root: HTMLElement): void => {
  const control = root.matches('input, textarea') ? root : root.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  if (!control) return

  control.setAttribute('autocomplete', control.tagName === 'INPUT' && (control as HTMLInputElement).type === 'password' ? 'new-password' : 'off')
  for (const [name, value] of Object.entries(managerOptOutAttributes)) control.setAttribute(name, value)
}

export const vCredentialAutofill: ObjectDirective<HTMLElement> = {
  mounted: protectCredentialControl,
  updated: protectCredentialControl
}
