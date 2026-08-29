import { mock, setSystemTime, vi as bunVi } from 'bun:test'
import { fileURLToPath } from 'node:url'


export * from 'bun:test'

const stubbedGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>()
type ModuleMockFactory = () => object | Promise<object>

const resolveModuleMock = (specifier: string, parentUrl: string): string =>
  specifier.startsWith('.') ? new URL(specifier, parentUrl).href : specifier

const registerModuleMock = (specifier: string, parentUrl: string, factory: ModuleMockFactory): void => {
  mock.module(resolveModuleMock(specifier, parentUrl), factory)
}

const removeModuleMock = (_specifier: string, _parentUrl: string): undefined => undefined



const stubGlobal = (name: PropertyKey, value: unknown): void => {
  if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

const unstubAllGlobals = (): void => {
  for (const [name, descriptor] of stubbedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  stubbedGlobals.clear()
}

const waitFor = async <Result,>(assertion: () => Result | Promise<Result>, options: { timeout?: number; interval?: number } = {}): Promise<Result> => {
  const timeout = options.timeout ?? 1_000
  const interval = options.interval ?? 20
  const deadline = performance.now() + timeout
  let lastError: unknown
  do {
    try {
      return await assertion()
    } catch (error: unknown) {
      lastError = error
      await Bun.sleep(interval)
    }
  } while (performance.now() < deadline)
  throw lastError
}
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const transportTypesModule = fileURLToPath(new URL('../controllers/_types.ts', import.meta.url))

const evictLocalModules = (): void => {
  for (const filename of Object.keys(require.cache)) {
    if (
      filename.startsWith(repositoryRoot) &&
      !filename.includes('/node_modules/') &&
      !filename.includes('/server/test/') &&
      filename !== transportTypesModule
    ) delete require.cache[filename]
  }
}

const importFresh = async <Module,>(specifier: string, parentUrl: string): Promise<Module> => {
  const url = new URL(specifier, parentUrl)
  evictLocalModules()
  return await import(url.href) as Module
}


export const vi = Object.assign(bunVi, {
  advanceTimersByTimeAsync: async function (this: typeof bunVi, milliseconds: number): Promise<void> {
    this.advanceTimersByTime(milliseconds)
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  },
  mockModule: registerModuleMock,
  unmockModule: removeModuleMock,
  hoisted: <Result,>(factory: () => Result): Result => factory(),
  mocked: <Value,>(value: Value): Value => value,
  importFresh,
  resetModules: (): undefined => undefined,
  setSystemTime,
  stubGlobal,
  unstubAllGlobals,
  waitFor
})
