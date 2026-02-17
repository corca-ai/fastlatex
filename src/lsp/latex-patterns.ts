import * as monaco from 'monaco-editor'
import type { SourceLocation } from './types'

// Command name alternation strings — single source of truth
export const REF_CMDS = 'ref|eqref|pageref|autoref|cref|Cref|nameref'
export const CITE_CMDS = 'cite|citep|citet|parencite|textcite|autocite|nocite'
export const INPUT_CMDS = 'input|include|subfile'
export const SECTION_CMDS = 'part|chapter|section|subsection|subsubsection|paragraph'
export const NEWCMD_CMDS = 'newcommand|renewcommand|providecommand'
export const USEPACKAGE_CMDS = 'usepackage|RequirePackage'
export const ENV_CMDS = 'begin|end'

/** Find the first regex match in line that contains the given column */
export function findMatchAtCol(line: string, re: RegExp, col: number): RegExpMatchArray | null {
  for (const m of line.matchAll(re)) {
    if (col >= m.index && col < m.index + m[0].length) return m
  }
  return null
}

/** Convert a SourceLocation to a Monaco Location (uri + range) */
export function sourceLocationToMonaco(loc: SourceLocation): monaco.languages.Location {
  const path = loc.file.startsWith('/') ? loc.file : `/${loc.file}`
  const uri = monaco.Uri.file(path)
  return {
    uri,
    range: new monaco.Range(loc.line, loc.column, loc.line, loc.column),
  }
}
