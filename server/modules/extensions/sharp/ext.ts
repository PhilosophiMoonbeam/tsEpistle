import type { OptionalExtensionDefinition } from '../../../../shared/extensions-workspace.ts'
const plugin: OptionalExtensionDefinition = {
  key: 'sharp',
  title: 'Sharp',
  description: 'The native image-processing package used for uploaded workspace-logo processing.',
  installation: {
    boundary: 'application-package',
    detail: 'Sharp is a production dependency resolved when the reviewed application image is built for its target platform.',
    recovery:
      'If the native package cannot load, rebuild and deploy the reviewed image for the target architecture. Do not replace native packages inside a running container.'
  },
  capabilities: [
    {
      title: 'Workspace logo processing',
      detail: 'Logo uploads are decoded and normalized by Sharp before the workspace identity is updated.',
      configuration: { label: 'Manage workspace logo', path: '/general', hash: 'identity' }
    }
  ],
  dependencies: [
    {
      title: 'Sharp native module',
      detail: 'Compatibility is verified by loading the production module in this application process. This observation does not process image data.'
    }
  ],
  async observe() {
    try {
      // Sharp’s native binding is platform-specific and may be absent or unloadable on an otherwise bootable deployment.
      const loaded = await import('sharp')
      if (typeof loaded.default !== 'function') {
        return { state: 'unknown', compatibility: 'unknown', evidence: 'The loaded Sharp package did not expose an image processor.' }
      }
      return { state: 'usable', compatibility: 'verified', evidence: 'The Sharp native module loaded in the application process.' }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
        ? { state: 'missing', compatibility: 'unknown', evidence: 'The Sharp native module is not installed in the application process.' }
        : { state: 'unknown', compatibility: 'unknown', evidence: 'The Sharp native module could not be observed in the application process.' }
    }
  }
}

export default plugin
