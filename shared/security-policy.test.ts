import { describe, it, expect } from 'bun:test'
import { securityPolicyDefaults, validateSecurityPolicy, newPasswordIssue, securityEndsSessions } from './security-policy.ts'
const policy = () => structuredClone(securityPolicyDefaults)
describe('Workspace security policy boundaries', () => {
  it('accepts a complete policy and normalizes textarea directives into one header line', () => {
    const p = policy()
    p.securityCSPMode = 'report-only'
    p.securityCSPDirectives = "default-src 'self'\r\nimg-src 'self' https:;"
    expect(validateSecurityPolicy(p)).toEqual({ ok: true, value: { ...p, securityCSPDirectives: "default-src 'self'; img-src 'self' https:" } })
  })
  it('rejects omitted or unknown fields, coercible booleans and unsafe numeric limits', () => {
    for (const patch of [
      { authEnforce2FA: 'true' },
      { authJwtExpirationSeconds: 0 },
      { authJwtRenewalSeconds: -1 },
      { uploadMaxFileSize: Infinity },
      { authPasswordMinLength: 6 },
      { securityHSTSDuration: 1.5 },
      { unrelatedSiteSetting: true }
    ])
      expect(validateSecurityPolicy({ ...policy(), ...patch }).ok).toBe(false)
    const p: Record<string, unknown> = policy()
    delete p.authEnforce2FA
    expect(validateSecurityPolicy(p).ok).toBe(false)
  })
  it('rejects malformed CSP and header controls, including duplicate directives', () => {
    for (const directives of ["default-src 'self'\rX-Injected: yes", "default-src 'self'; default-src *", 'Default-Src *', 'x\u0000y', 'é'])
      expect(validateSecurityPolicy({ ...policy(), securityCSPDirectives: directives }).ok).toBe(false)
    for (const directives of ["default-src 'self'\u0000", 'img-src https://é.example.invalid'])
      expect(validateSecurityPolicy({ ...policy(), securityCSPDirectives: directives }).ok).toBe(false)
    expect(validateSecurityPolicy({ ...policy(), securityCSPMode: 'enforce' }).ok).toBe(false)
  })
  it('allows empty or same-workspace backgrounds while excluding script, protocol-relative and credential URLs', () => {
    for (const url of ['', '/uploads/background.svg', 'https://example.invalid/background.jpg'])
      expect(validateSecurityPolicy({ ...policy(), authLoginBgUrl: url }).ok).toBe(true)
    for (const url of ['javascript:alert(1)', '//example.invalid/a', 'https://user:password@example.invalid/a', '/\\example.invalid/a', '/a b', 'https://'])
      expect(validateSecurityPolicy({ ...policy(), authLoginBgUrl: url }).ok).toBe(false)
  })
  it('distinguishes new-password policy from token and two-factor session effects', () => {
    const p = policy()
    expect(securityEndsSessions(p, { ...p, authPasswordMinLength: 20 })).toBe(false)
    expect(securityEndsSessions(p, { ...p, authEnforce2FA: true })).toBe(true)
    expect(securityEndsSessions({ ...p, authEnforce2FA: true }, p)).toBe(false)
    expect(securityEndsSessions(p, { ...p, authJwtRenewalSeconds: 0 })).toBe(true)
  })
  it('counts Unicode characters without accepting bcrypt-truncated passwords', () => {
    expect(newPasswordIssue('a'.repeat(12))).toBeNull()
    expect(newPasswordIssue('a'.repeat(72))).toBeNull()
    expect(newPasswordIssue('a'.repeat(73))).not.toBeNull()
    expect(newPasswordIssue('😀'.repeat(11))).not.toBeNull()
    expect(newPasswordIssue('😀'.repeat(18))).toBeNull()
    expect(newPasswordIssue('😀'.repeat(19))).not.toBeNull()
    expect(newPasswordIssue('a'.repeat(19), 20)).not.toBeNull()
  })
})
