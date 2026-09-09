export const IMPORT_MAX_ENTRIES = 10_000
export const IMPORT_MAX_BYTES = 256 * 1024 * 1024
export const IMPORT_MAX_ASSET_BYTES = 64 * 1024 * 1024

const assertSafeLimit = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`)
}

export class ImportBudget {
  readonly maxEntries: number
  readonly maxBytes: number
  #entries = 0
  #bytes = 0

  constructor (maxEntries = IMPORT_MAX_ENTRIES, maxBytes = IMPORT_MAX_BYTES) {
    assertSafeLimit(maxEntries, 'Import entry limit')
    assertSafeLimit(maxBytes, 'Import byte limit')
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
  }

  get entries (): number {
    return this.#entries
  }

  get bytes (): number {
    return this.#bytes
  }

  reserve (bytes = 0): void {
    assertSafeLimit(bytes, 'Import entry size')
    if (this.#entries >= this.maxEntries) {
      throw new RangeError(`Import exceeds the ${this.maxEntries}-entry limit`)
    }
    if (bytes > this.maxBytes - this.#bytes) {
      throw new RangeError(`Import exceeds the ${this.maxBytes}-byte limit`)
    }
    this.#entries += 1
    this.#bytes += bytes
  }
}

export const validateUploadLimit = (configuredLimit: unknown): number => {
  if (typeof configuredLimit !== 'number' || !Number.isSafeInteger(configuredLimit) || configuredLimit <= 0) {
    throw new RangeError('Workspace upload limit must be a positive safe integer')
  }
  return configuredLimit
}

export const boundedImportAssetLimit = (configuredLimit: unknown): number =>
  Math.min(validateUploadLimit(configuredLimit), IMPORT_MAX_ASSET_BYTES)
