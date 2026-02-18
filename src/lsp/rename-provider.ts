import type * as Monaco from 'monaco-editor'
import type { ProjectIndex } from './project-index'

export function createRenameProvider(projectIndex: ProjectIndex): Monaco.languages.RenameProvider {
  return {
    provideRenameEdits: (model, position, newName) => {
      const filePath = model.uri.path.substring(1) // Remove leading slash
      const symbol = projectIndex.findSymbolAt(filePath, position.lineNumber, position.column)

      if (!symbol) return undefined

      const occurrences = projectIndex.findAllOccurrences(symbol.name, symbol.type)
      const edits: Monaco.languages.IWorkspaceTextEdit[] = occurrences.map((occ) => ({
        resource: model.uri.with({ path: `/${occ.filePath}` }),
        versionId: undefined,
        textEdit: {
          range: {
            startLineNumber: occ.line,
            startColumn: occ.column,
            endLineNumber: occ.line,
            endColumn: occ.column + occ.length,
          },
          text: newName,
        },
      }))

      return { edits }
    },
    resolveRenameLocation: (model, position) => {
      const filePath = model.uri.path.substring(1)
      const symbol = projectIndex.findSymbolAt(filePath, position.lineNumber, position.column)

      if (!symbol) {
        return Promise.reject('You cannot rename this element.')
      }

      // Find the exact occurrence to get its column
      const occurrences = projectIndex.findAllOccurrences(symbol.name, symbol.type)
      const thisOcc = occurrences.find(
        (o) =>
          o.filePath === filePath &&
          o.line === position.lineNumber &&
          position.column >= o.column &&
          position.column <= o.column + o.length,
      )

      return {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: thisOcc ? thisOcc.column : position.column,
          endLineNumber: position.lineNumber,
          endColumn: thisOcc ? thisOcc.column + thisOcc.length : position.column,
        },
        text: symbol.name,
      }
    },
  }
}
