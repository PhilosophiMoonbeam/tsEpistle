import type { OptionalExtensionDefinition } from '../../../../shared/extensions-workspace.ts'
import { observeBundledCommand } from '../command-observation.ts'

const plugin: OptionalExtensionDefinition = {
  key: 'pandoc',
  title: 'Pandoc',
  description: 'An optional document-conversion command retained for deployment-owned integrations.',
  installation: {
    boundary: 'application-image',
    detail: 'The standard application image does not add Pandoc. Its executable belongs in a reviewed custom image when an integration needs it.',
    recovery:
      'Build and deploy a reviewed application image that includes a compatible Pandoc executable, then refresh this page. Administration never runs a package manager or installer.'
  },
  capabilities: [
    {
      title: 'No active application consumer',
      detail:
        'This build does not register an import, rendering or export workflow that invokes Pandoc. Installing the executable alone does not add a conversion feature.'
    }
  ],
  dependencies: [
    {
      title: 'Pandoc executable',
      detail: 'Availability is based on a fixed, bounded `pandoc --version` check in the application process; command output is not retained or exposed.'
    }
  ],
  async observe() {
    const outcome = await observeBundledCommand('pandoc')
    return outcome === 'usable'
      ? { state: 'usable', compatibility: 'verified', evidence: 'The application completed a bounded Pandoc executable check.' }
      : outcome === 'missing'
        ? { state: 'missing', compatibility: 'unknown', evidence: 'The Pandoc executable is not present in the application process.' }
        : { state: 'unknown', compatibility: 'unknown', evidence: 'The Pandoc executable could not be observed within its bounded check.' }
  }
}

export default plugin
