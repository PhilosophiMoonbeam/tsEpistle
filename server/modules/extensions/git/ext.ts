import type { OptionalExtensionDefinition } from '../../../../shared/extensions-workspace.ts'
import { observeBundledCommand } from '../command-observation.ts'

const plugin: OptionalExtensionDefinition = {
  key: 'git',
  title: 'Git',
  description: 'The command-line client used by the configured Git storage target.',
  installation: {
    boundary: 'application-image',
    detail: 'Git is supplied by the reviewed application image, not installed from Administration.',
    recovery:
      'If this observation is missing, rebuild and deploy an application image that includes Git, then refresh this page. Do not install packages in a running container.'
  },
  capabilities: [
    {
      title: 'Git storage',
      detail: 'The Git storage target uses the Git executable for repository initialization, synchronization and recovery.',
      configuration: { label: 'Configure Git storage', path: '/storage', query: { section: 'targets', target: 'git' } }
    }
  ],
  dependencies: [
    {
      title: 'Git executable',
      detail:
        'The application runs a fixed `git --version` check from its own PATH. A target with a reviewed custom binary path is observed by the Storage workspace instead.'
    }
  ],
  async observe() {
    const outcome = await observeBundledCommand('git')
    return outcome === 'usable'
      ? { state: 'usable', compatibility: 'verified', evidence: 'The application completed a bounded Git executable check.' }
      : outcome === 'missing'
        ? { state: 'missing', compatibility: 'unknown', evidence: 'The Git executable is not present in the application process.' }
        : { state: 'unknown', compatibility: 'unknown', evidence: 'The Git executable could not be observed within its bounded check.' }
  }
}

export default plugin
