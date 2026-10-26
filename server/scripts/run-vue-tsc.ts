import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import path from 'node:path'
import type * as TypeScript from 'typescript'
import type * as VueLanguageCore from '@vue/language-core'

const require = createRequire(import.meta.url)
const typescript = require('typescript') as typeof TypeScript
const vueLanguageCore = require('@vue/language-core') as typeof VueLanguageCore
const runTscPath = require.resolve('@volar/typescript/lib/quickstart/runTsc')
const proxyCreateProgramPath = require.resolve('@volar/typescript/lib/node/proxyCreateProgram')
const tscPath = require.resolve('typescript/lib/_tsc.js')

const runTsc = require(runTscPath) as {
  getLanguagePlugins: (typescript: typeof TypeScript, options: TypeScript.CreateProgramOptions) => unknown
  transformTscContent: (
    source: string,
    proxyCreateProgramPath: string,
    extraSupportedExtensions: string[],
    extraExtensionsToRemove: string[],
    getLanguagePluginsFile: string
  ) => string
}

runTsc.getLanguagePlugins = (typescript, options) => {
  const configFilePath = options.options.configFilePath
  if (typeof configFilePath !== 'string') throw new Error('Vue typechecking requires a TypeScript project config')
  const vueOptions = vueLanguageCore.createParsedCommandLine(typescript, typescript.sys, configFilePath).vueOptions

  return {
    languagePlugins: [vueLanguageCore.createVueLanguagePlugin(typescript, options.options, vueOptions, id => id as string)]
  }
}

const commandLine = typescript.parseCommandLine(process.argv.slice(2))
const project = commandLine.options.project
const selectedPath = project
  ? path.resolve(project)
  : typescript.findConfigFile(process.cwd(), typescript.sys.fileExists)
if (!selectedPath) throw new Error('Vue typechecking requires a TypeScript project config')
const configFilePath = fs.statSync(selectedPath).isDirectory() ? path.join(selectedPath, 'tsconfig.json') : selectedPath
const selectedConfig = vueLanguageCore.createParsedCommandLine(typescript, typescript.sys, configFilePath)
const extensions = vueLanguageCore.getAllExtensions(selectedConfig.vueOptions)
const transformedTsc = runTsc.transformTscContent(
  fs.readFileSync(tscPath, 'utf8'),
  proxyCreateProgramPath,
  extensions,
  [],
  runTscPath
)

type CompilableModule = Module & { _compile: (source: string, filename: string) => void }
const tscModule = new Module(tscPath) as CompilableModule
tscModule.filename = tscPath
tscModule.paths = require.resolve.paths(tscPath) ?? []
tscModule._compile(transformedTsc, tscPath)
