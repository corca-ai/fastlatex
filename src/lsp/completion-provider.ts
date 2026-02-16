import * as monaco from 'monaco-editor'
import type { VirtualFS } from '../fs/virtual-fs'
import { COMMON_PACKAGES, LATEX_COMMANDS, LATEX_ENVIRONMENTS } from './latex-commands'
import { CITE_CMDS, INPUT_CMDS, REF_CMDS, USEPACKAGE_CMDS } from './latex-patterns'
import type { ProjectIndex } from './project-index'

const CompletionItemKind = monaco.languages.CompletionItemKind
const CompletionItemInsertTextRule = monaco.languages.CompletionItemInsertTextRule

type CompletionItem = monaco.languages.CompletionItem
type IRange = monaco.IRange

/** Detect what kind of completion context we're in */
function getContext(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): {
  type: 'command' | 'ref' | 'cite' | 'begin' | 'end' | 'usepackage' | 'include'
  prefix: string
} | null {
  const lineContent = model.getLineContent(position.lineNumber)
  const textBefore = lineContent.slice(0, position.column - 1)

  // \ref{..., \eqref{..., etc.
  const refMatch = textBefore.match(new RegExp(`\\\\(?:${REF_CMDS})\\{([^}]*)$`))
  if (refMatch) return { type: 'ref', prefix: refMatch[1]! }

  // \cite{... (also after commas inside cite)
  const citeMatch = textBefore.match(new RegExp(`\\\\(?:${CITE_CMDS})(?:\\[.*?\\])?\\{([^}]*)$`))
  if (citeMatch) {
    const inner = citeMatch[1]!
    const lastComma = inner.lastIndexOf(',')
    return { type: 'cite', prefix: lastComma >= 0 ? inner.slice(lastComma + 1).trim() : inner }
  }

  // \begin{...
  const beginMatch = textBefore.match(/\\begin\{([^}]*)$/)
  if (beginMatch) return { type: 'begin', prefix: beginMatch[1]! }

  // \end{...
  const endMatch = textBefore.match(/\\end\{([^}]*)$/)
  if (endMatch) return { type: 'end', prefix: endMatch[1]! }

  // \usepackage{... or \usepackage[...]{...
  const pkgMatch = textBefore.match(
    new RegExp(`\\\\(?:${USEPACKAGE_CMDS})(?:\\[.*?\\])?\\{([^}]*)$`),
  )
  if (pkgMatch) return { type: 'usepackage', prefix: pkgMatch[1]! }

  // \input{... or \include{...
  const includeMatch = textBefore.match(new RegExp(`\\\\(?:${INPUT_CMDS})\\{([^}]*)$`))
  if (includeMatch) return { type: 'include', prefix: includeMatch[1]! }

  // \command (backslash followed by word chars)
  const cmdMatch = textBefore.match(/\\(\w*)$/)
  if (cmdMatch) return { type: 'command', prefix: cmdMatch[1]! }

  return null
}

function completeCommands(prefix: string, range: IRange, index: ProjectIndex): CompletionItem[] {
  const suggestions: CompletionItem[] = []
  // Static command DB
  for (const cmd of LATEX_COMMANDS) {
    if (!cmd.name.startsWith(prefix)) continue
    const item: CompletionItem = {
      label: `\\${cmd.name}`,
      kind: CompletionItemKind.Function,
      insertText: cmd.snippet.slice(1), // remove leading backslash (already typed)
      insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
      range,
      sortText: `0_${cmd.name}`, // static commands first
    }
    if (cmd.detail) item.detail = cmd.detail
    if (cmd.documentation) {
      item.documentation = {
        value: cmd.documentation + (cmd.package ? `\n\nPackage: \`${cmd.package}\`` : ''),
      }
    } else if (cmd.package) {
      item.documentation = { value: `Package: \`${cmd.package}\`` }
    }
    suggestions.push(item)
  }
  // User-defined commands from project index
  for (const cmd of index.getCommandDefs()) {
    if (!cmd.name.startsWith(prefix)) continue
    suggestions.push({
      label: `\\${cmd.name}`,
      kind: CompletionItemKind.Variable,
      insertText: cmd.name,
      detail: `User command (${cmd.location.file}:${cmd.location.line})`,
      range,
      sortText: `1_${cmd.name}`,
    })
  }
  appendEngineCommands(suggestions, prefix, range, index)
  return suggestions
}

/** Tier 3: Engine-traced commands (from pdfTeX hash table scan) */
function appendEngineCommands(
  suggestions: CompletionItem[],
  prefix: string,
  range: IRange,
  index: ProjectIndex,
): void {
  const seen = new Set(suggestions.map((s) => (s.label as string).slice(1)))
  for (const name of index.getEngineCommands()) {
    if (!name.startsWith(prefix) || seen.has(name)) continue
    suggestions.push({
      label: `\\${name}`,
      kind: CompletionItemKind.Text,
      insertText: name,
      detail: 'Package command',
      range,
      sortText: `2_${name}`,
    })
  }
}

function completeRefs(prefix: string, range: IRange, index: ProjectIndex): CompletionItem[] {
  const suggestions: CompletionItem[] = []
  for (const label of index.getAllLabels()) {
    if (!label.name.startsWith(prefix)) continue
    const resolved = index.resolveLabel(label.name)
    suggestions.push({
      label: label.name,
      kind: CompletionItemKind.Reference,
      insertText: label.name,
      detail: resolved
        ? `[${resolved}] ${label.location.file}:${label.location.line}`
        : `${label.location.file}:${label.location.line}`,
      range,
    })
  }
  return suggestions
}

function completeCites(prefix: string, range: IRange, index: ProjectIndex): CompletionItem[] {
  const suggestions: CompletionItem[] = []
  // From .aux data
  const seenKeys = new Set<string>()
  for (const key of index.getAuxCitations()) {
    if (!key.startsWith(prefix)) continue
    seenKeys.add(key)
    suggestions.push({
      label: key,
      kind: CompletionItemKind.Reference,
      insertText: key,
      detail: 'Citation',
      range,
    })
  }
  // From bib entries
  for (const entry of index.getBibEntries()) {
    if (seenKeys.has(entry.key) || !entry.key.startsWith(prefix)) continue
    suggestions.push({
      label: entry.key,
      kind: CompletionItemKind.Reference,
      insertText: entry.key,
      detail: entry.title ?? entry.type,
      range,
    })
  }
  return suggestions
}

function completeEnvironments(
  prefix: string,
  range: IRange,
  index: ProjectIndex,
  isBegin: boolean,
): CompletionItem[] {
  const suggestions: CompletionItem[] = []
  // Static environments
  for (const env of LATEX_ENVIRONMENTS) {
    if (!env.name.startsWith(prefix)) continue
    const item: CompletionItem = {
      label: env.name,
      kind: CompletionItemKind.Module,
      insertText: env.name,
      range,
    }
    if (env.detail) item.detail = env.detail
    if (isBegin) item.sortText = `0_${env.name}`
    suggestions.push(item)
  }
  // Environments from project
  for (const name of index.getAllEnvironments()) {
    if (!name.startsWith(prefix)) continue
    suggestions.push({
      label: name,
      kind: CompletionItemKind.Module,
      insertText: name,
      detail: 'Used in project',
      range,
      sortText: `1_${name}`,
    })
  }
  return suggestions
}

function completePackages(prefix: string, range: IRange): CompletionItem[] {
  const suggestions: CompletionItem[] = []
  for (const pkg of COMMON_PACKAGES) {
    if (!pkg.startsWith(prefix)) continue
    suggestions.push({
      label: pkg,
      kind: CompletionItemKind.Module,
      insertText: pkg,
      range,
    })
  }
  return suggestions
}

function completeIncludes(prefix: string, range: IRange, fs: VirtualFS): CompletionItem[] {
  const suggestions: CompletionItem[] = []
  for (const path of fs.listFiles()) {
    if (!path.startsWith(prefix)) continue
    suggestions.push({
      label: path,
      kind: CompletionItemKind.File,
      insertText: path,
      range,
    })
  }
  return suggestions
}

export function createCompletionProvider(
  index: ProjectIndex,
  fs: VirtualFS,
): monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: ['\\', '{'],

    provideCompletionItems(
      model: monaco.editor.ITextModel,
      position: monaco.Position,
    ): monaco.languages.CompletionList {
      const ctx = getContext(model, position)
      if (!ctx) return { suggestions: [] }

      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - ctx.prefix.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      }

      switch (ctx.type) {
        case 'command':
          return { suggestions: completeCommands(ctx.prefix, range, index) }
        case 'ref':
          return { suggestions: completeRefs(ctx.prefix, range, index) }
        case 'cite':
          return { suggestions: completeCites(ctx.prefix, range, index) }
        case 'begin':
        case 'end':
          return {
            suggestions: completeEnvironments(ctx.prefix, range, index, ctx.type === 'begin'),
          }
        case 'usepackage':
          return { suggestions: completePackages(ctx.prefix, range) }
        case 'include':
          return { suggestions: completeIncludes(ctx.prefix, range, fs) }
      }
    },
  }
}
