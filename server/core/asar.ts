import pickle from 'chromium-pickle-js'
import path from 'node:path'
import { UINT64 } from 'cuint'
import fs from 'node:fs'
import { promisify } from 'node:util'
import type { NextFunction, Request, Response } from 'express'

interface AsarNode { files: Record<string, AsarNode>; link?: string; offset?: string; size?: number }
interface CachedArchive { fd: number; filesystem: Filesystem }
interface WikiContext { ROOTPATH: string; logger: { info(message: string): void; warn(message: unknown): void } }
const wiki = WIKI as unknown as WikiContext
const packages: Record<string, string> = { twemoji: path.join(wiki.ROOTPATH, 'assets/svg/twemoji.asar') }

class Filesystem {
  src: string
  header: AsarNode = { files: {} }
  headerSize = 0
  offset = UINT64(0)
  constructor(src: string) { this.src = path.resolve(src) }
  searchNodeFromDirectory(target: string) { let node = this.header; for (const dir of target.split(path.sep)) if (dir !== '.') node = node.files[dir]!; return node }
  getNode(target: string) { const node = this.searchNodeFromDirectory(path.dirname(target)); const name = path.basename(target); return name ? node.files[name] : node }
  getFile(target: string, followLinks = true): AsarNode | false { const info = this.getNode(target); if (!info) return false; return info.link && followLinks ? this.getFile(info.link) : info }
}

const asar = {
  fdCache: {} as Record<string, CachedArchive>,
  async serve(pkgName: string, req: Request, res: Response, _next: NextFunction) {
    void _next
    const archive = packages[pkgName]
    if (!archive) { res.sendStatus(404); return }
    const { filesystem, fd } = this.readFilesystemSync(archive)
    const info = filesystem.getFile(req.path.substring(1))
    if (!info || info.size === undefined) { res.sendStatus(404); return }
    res.set({ 'Content-Type': 'image/svg+xml', 'Content-Length': info.size })
    fs.createReadStream('', { fd, autoClose: false, start: 8 + filesystem.headerSize + parseInt(info.offset ?? '0', 10), end: 8 + filesystem.headerSize + parseInt(info.offset ?? '0', 10) + info.size - 1 }).on('error', error => { wiki.logger.warn(error); res.sendStatus(404) }).pipe(res.status(200))
  },
  async unload() { const entries = Object.values(this.fdCache); if (entries.length) { wiki.logger.info('Closing ASAR file descriptors...'); const close = promisify(fs.close); await Promise.all(entries.map(entry => close(entry.fd))); this.fdCache = {} } },
  readArchiveHeaderSync(fd: number) { const sizeBuf = Buffer.alloc(8); if (fs.readSync(fd, sizeBuf, 0, 8, null) !== 8) throw new Error('Unable to read header size'); const size = pickle.createFromBuffer(sizeBuf).createIterator().readUInt32(); const headerBuf = Buffer.alloc(size); if (fs.readSync(fd, headerBuf, 0, size, null) !== size) throw new Error('Unable to read header'); const header = JSON.parse(pickle.createFromBuffer(headerBuf).createIterator().readString()) as AsarNode; return { header, headerSize: size } },
  readFilesystemSync(archive: string): CachedArchive { if (!this.fdCache[archive]) { const fd = fs.openSync(archive, 'r'); const header = this.readArchiveHeaderSync(fd); const filesystem = new Filesystem(archive); filesystem.header = header.header; filesystem.headerSize = header.headerSize; this.fdCache[archive] = { fd, filesystem } } return this.fdCache[archive]! }
}

export default asar
