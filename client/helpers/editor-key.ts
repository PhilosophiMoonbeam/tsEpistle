import _ from 'lodash'

export function getEditorComponentName (editorKey: string): string {
  return `editor${_.upperFirst(_.camelCase(editorKey))}`
}
