import type { ProjectIndex } from './project-index'

export interface Diagnostic {
  file: string
  line: number
  column: number
  endColumn: number
  message: string
  severity: 'error' | 'warning' | 'info'
  code: string
}

/** Compute static analysis diagnostics from project index */
export function computeDiagnostics(index: ProjectIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  findUndefinedRefs(index, diagnostics)
  findUndefinedCitations(index, diagnostics)
  findDuplicateLabels(index, diagnostics)
  findUnreferencedLabels(index, diagnostics)
  findMissingIncludes(index, diagnostics)
  return diagnostics
}

function findUndefinedRefs(index: ProjectIndex, out: Diagnostic[]): void {
  const definedLabels = new Set(index.getAllLabels().map((l) => l.name))
  const auxLabels = index.getAuxLabels()

  for (const file of index.getFiles()) {
    const symbols = index.getFileSymbols(file)
    if (!symbols) continue
    for (const ref of symbols.labelRefs) {
      if (!definedLabels.has(ref.name) && !auxLabels.has(ref.name)) {
        out.push({
          file,
          line: ref.location.line,
          column: ref.location.column,
          endColumn: ref.location.column + ref.name.length + 5, // \ref{name}
          message: `Undefined reference '${ref.name}'`,
          severity: 'warning',
          code: 'undefined-ref',
        })
      }
    }
  }
}

function findUndefinedCitations(index: ProjectIndex, out: Diagnostic[]): void {
  const auxCitations = index.getAuxCitations()
  const bibKeys = new Set(index.getBibEntries().map((e) => e.key))
  const bibitemKeys = new Set<string>()
  for (const file of index.getFiles()) {
    const symbols = index.getFileSymbols(file)
    if (!symbols) continue
    for (const item of symbols.bibItems) {
      bibitemKeys.add(item.key)
    }
  }

  for (const file of index.getFiles()) {
    const symbols = index.getFileSymbols(file)
    if (!symbols) continue
    for (const cite of symbols.citations) {
      if (!auxCitations.has(cite.key) && !bibKeys.has(cite.key) && !bibitemKeys.has(cite.key)) {
        out.push({
          file,
          line: cite.location.line,
          column: cite.location.column,
          endColumn: cite.location.column + cite.key.length + 6, // \cite{key}
          message: `Undefined citation '${cite.key}'`,
          severity: 'warning',
          code: 'undefined-cite',
        })
      }
    }
  }
}

function findDuplicateLabels(index: ProjectIndex, out: Diagnostic[]): void {
  const allLabels = index.getAllLabels()
  const seen = new Map<string, { file: string; line: number }>()

  for (const label of allLabels) {
    const prev = seen.get(label.name)
    if (prev) {
      out.push({
        file: label.location.file,
        line: label.location.line,
        column: label.location.column,
        endColumn: label.location.column + label.name.length + 7, // \label{name}
        message: `Duplicate label '${label.name}' (first defined at ${prev.file}:${prev.line})`,
        severity: 'warning',
        code: 'duplicate-label',
      })
    } else {
      seen.set(label.name, { file: label.location.file, line: label.location.line })
    }
  }
}

function findUnreferencedLabels(index: ProjectIndex, out: Diagnostic[]): void {
  const refdNames = new Set<string>()
  for (const file of index.getFiles()) {
    const symbols = index.getFileSymbols(file)
    if (!symbols) continue
    for (const ref of symbols.labelRefs) refdNames.add(ref.name)
  }
  for (const label of index.getAllLabels()) {
    if (!refdNames.has(label.name)) {
      out.push({
        file: label.location.file,
        line: label.location.line,
        column: label.location.column,
        endColumn: label.location.column + label.name.length + 7,
        message: `Label '${label.name}' is never referenced`,
        severity: 'info',
        code: 'unreferenced-label',
      })
    }
  }
}

function findMissingIncludes(index: ProjectIndex, out: Diagnostic[]): void {
  for (const file of index.getFiles()) {
    const symbols = index.getFileSymbols(file)
    if (!symbols) continue
    for (const inc of symbols.includes) {
      const target = inc.path.endsWith('.tex') ? inc.path : `${inc.path}.tex`
      if (!index.getFileSymbols(target)) {
        out.push({
          file,
          line: inc.location.line,
          column: inc.location.column,
          endColumn: inc.location.column + inc.path.length + 7,
          message: `Included file '${target}' not found in project`,
          severity: 'warning',
          code: 'missing-include',
        })
      }
    }
  }
}
