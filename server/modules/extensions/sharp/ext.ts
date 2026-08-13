import { wiki } from '../../types.ts'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'


const plugin = {
  key: 'sharp',
  title: 'Sharp',
  description: 'Process and transform images. Required to generate thumbnails of uploaded images and perform transformations.',
  async isCompatible () {
    return os.arch() === 'x64'
  },
  isInstalled: false,
  async check () {
    this.isInstalled = await fs.pathExists(path.join(wiki.ROOTPATH, 'node_modules/sharp'))
    return this.isInstalled
  }
}

export default plugin
