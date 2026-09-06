import { describe, it, expect } from '../server/test/bun-test.mts'
import { MailDraftSchema, mailPolicyFromConfiguration, mailConfigurationIssues, isMailAddress } from './mail-workspace.ts'
describe('Mail policy and credential contracts', () => {
  it('retains legacy transport behavior and supports pausing without removing a configured host', () => {
    expect(mailPolicyFromConfiguration({ host: 'smtp.example.test', secure: true })).toMatchObject({ enabled: true, tlsMode: 'implicit', port: 465 })
    expect(mailPolicyFromConfiguration({ host: 'smtp.example.test', secure: false, port: 2525 })).toMatchObject({ tlsMode: 'opportunistic', port: 2525 })
    expect(mailPolicyFromConfiguration({ host: 'smtp.example.test', enabled: false, tlsMode: 'starttls' })).toMatchObject({
      enabled: false,
      host: 'smtp.example.test',
      tlsMode: 'starttls'
    })
  })
  it('uses explicit secret actions and permits a literal sentinel-looking replacement password', () => {
    const policy = mailPolicyFromConfiguration({})
    expect(MailDraftSchema.safeParse({ policy, secrets: { pass: { action: 'replace', value: '********' }, dkimPrivateKey: { action: 'keep' } } }).success).toBe(
      true
    )
    expect(MailDraftSchema.safeParse({ policy, secrets: { pass: { action: 'keep', value: 'secret' }, dkimPrivateKey: { action: 'clear' } } }).success).toBe(
      false
    )
    expect(MailDraftSchema.safeParse({ policy, secrets: { pass: '********', dkimPrivateKey: '' } }).success).toBe(false)
  })
  it('checks configuration readiness without claiming delivery or requiring SMTP authentication for a relay', () => {
    const policy = mailPolicyFromConfiguration({ host: 'smtp.example.test', senderName: 'Wiki', senderEmail: 'wiki@example.test', secure: true })
    expect(mailConfigurationIssues(policy, { pass: false, dkimPrivateKey: false })).toEqual([])
    expect(mailConfigurationIssues({ ...policy, user: 'x' }, { pass: false, dkimPrivateKey: false })).toContain(
      'Provide the SMTP password or clear the username for an unauthenticated relay.'
    )
    expect(mailConfigurationIssues({ ...policy, senderName: 'Wiki\r\nBcc: other@example.test' }, { pass: false, dkimPrivateKey: false })).toContain(
      'Check the field lengths, SMTP port and transport settings.'
    )
    expect(mailConfigurationIssues({ ...policy, host: 'https://smtp.example.test' }, { pass: false, dkimPrivateKey: false })).toContain(
      'Enter an SMTP hostname or IP address, without a URL scheme or path.'
    )
    expect(isMailAddress('one@example.test,two@example.test')).toBe(false)
    expect(isMailAddress('a@example.test\r\nBcc: other@example.test')).toBe(false)
    expect(isMailAddress('one+tag@example.test')).toBe(true)
  })
})
