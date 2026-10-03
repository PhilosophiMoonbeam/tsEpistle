import { camelCase, upperFirst } from 'lodash-es'

export function getEditorComponentName (editorKey: string): string {
  return `editor${upperFirst(camelCase(editorKey))}`
}
