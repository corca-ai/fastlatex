import * as monaco from 'monaco-editor'
import { INPUT_CMDS, REF_CMDS, sourceLocationToMonaco } from './latex-patterns'
import type { ProjectIndex } from './project-index'

type Token = { command: string; arg: string } | { command: string }

/** Walk backwards from col to find the index of the opening `{` at depth 0 */
function findOpenBrace(line: string, col: number): number {
  let depth = 0
  for (let i = col - 1; i >= 0; i--) {
    if (line[i] === '}') depth++
    else if (line[i] === '{') {
      if (depth === 0) return i
      depth--
    }
  }
  return -1
}

/** Find the index of the closing `}` that matches the `{` at braceStart */
function findCloseBrace(line: string, braceStart: number): number {
  let depth = 0
  for (let i = braceStart; i < line.length; i++) {
    if (line[i] === '{') depth++
    else if (line[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return braceStart
}

/** Try to find a \cmd{arg} token where the cursor is inside the braces */
function getTokenInBraces(line: string, col: number): { command: string; arg: string } | null {
  const braceStart = findOpenBrace(line, col)
  if (braceStart < 0) return null

  const before = line.slice(0, braceStart)
  const cmdMatch = before.match(/\\(\w+)(?:\[.*?\])?\s*$/)
  if (!cmdMatch) return null

  const braceEnd = findCloseBrace(line, braceStart)
  return { command: cmdMatch[1]!, arg: line.slice(braceStart + 1, braceEnd) }
}

const CITE_CMD_RE = /^(?:cite|citep|citet|parencite|textcite|autocite|nocite)$/
const ARG_CMD_RE = new RegExp(
  `^(?:${REF_CMDS}|cite|citep|citet|parencite|textcite|autocite|nocite|${INPUT_CMDS})$`,
)

/** Try to find a \command token where the cursor is on the command word */
function getTokenOnCommand(line: string, col: number): Token | null {
  const wordMatch = line.slice(0, col + 20).match(/\\(\w+)/)
  if (!wordMatch || wordMatch.index === undefined) return null
  const start = wordMatch.index
  const end = start + wordMatch[0].length
  if (col < start || col > end) return null

  const command = wordMatch[1]!
  // For ref/cite/input commands, also grab the brace argument that follows
  if (ARG_CMD_RE.test(command)) {
    const after = line.slice(end)
    const braceMatch = after.match(/^(?:\[.*?\])?\{([^}]*)\}/)
    if (braceMatch) return { command, arg: braceMatch[1]! }
  }
  return { command }
}

/** Extract the token at the cursor position: returns { command, arg } or null */
function getTokenAtPosition(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Token | null {
  const line = model.getLineContent(position.lineNumber)
  const col = position.column - 1
  return getTokenInBraces(line, col) ?? getTokenOnCommand(line, col)
}

const REF_CMD_RE = new RegExp(`^(?:${REF_CMDS})$`)
const INPUT_CMD_RE = new RegExp(`^(?:${INPUT_CMDS})$`)

function handleArgToken(
  command: string,
  arg: string,
  index: ProjectIndex,
): monaco.languages.Definition | null {
  // \ref{name} or \eqref{name} -> jump to \label{name}
  if (REF_CMD_RE.test(command)) {
    const label = index.findLabelDef(arg)
    if (label) return sourceLocationToMonaco(label.location)
    return null
  }

  // \cite{key} -> jump to \bibitem{key}
  if (CITE_CMD_RE.test(command)) {
    const bibitem = index.findBibitemDef(arg)
    if (bibitem) return sourceLocationToMonaco(bibitem.location)
    return null
  }

  // \input{file} or \include{file} -> jump to file line 1
  if (INPUT_CMD_RE.test(command)) {
    let filePath = arg
    if (!filePath.includes('.')) filePath += '.tex'
    return {
      uri: monaco.Uri.file(filePath),
      range: new monaco.Range(1, 1, 1, 1),
    }
  }

  return null
}

function handleCommandToken(
  command: string,
  index: ProjectIndex,
): monaco.languages.Definition | null {
  const cmdDef = index.findCommandDef(command)
  if (cmdDef) return sourceLocationToMonaco(cmdDef.location)
  return null
}

export function createDefinitionProvider(index: ProjectIndex): monaco.languages.DefinitionProvider {
  return {
    provideDefinition(
      model: monaco.editor.ITextModel,
      position: monaco.Position,
    ): monaco.languages.Definition | null {
      const token = getTokenAtPosition(model, position)
      if (!token) return null

      if ('arg' in token) {
        return handleArgToken(token.command, token.arg, index)
      }
      return handleCommandToken(token.command, index)
    },
  }
}
