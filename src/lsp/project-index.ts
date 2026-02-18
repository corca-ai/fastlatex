import { parseAuxFile } from './aux-parser'
import { parseLatexFile } from './latex-parser'
import type { SemanticTrace } from './trace-parser'
import type {
  AuxData,
  BibEntry,
  BibitemDef,
  CommandDef,
  EnvironmentUse,
  FileSymbols,
  LabelDef,
  LabelRef,
} from './types'

export interface EngineCommandInfo {
  name: string
  eqType: number // -1 = unknown (old WASM), 0+ = pdfTeX eq_type
  argCount: number // -1 = unknown/not-macro, 0-9 = argument count
  category: 'macro' | 'primitive' | 'unknown'
}

/** Suffixes that match `end<X>` but are NOT real environments */
const ENV_BLOCKLIST = new Set(['csname', 'group', 'input', 'linechar', 'write'])

/** LaTeX3 (expl3) internal markers — `_` and `:` are only catcode-11
 *  inside expl3 code. No user-facing command contains them. */
const L3_INTERNAL_RE = /[_:]/

function classifyEqType(eqType: number): EngineCommandInfo['category'] {
  if (eqType >= 111 && eqType <= 118) return 'macro'
  if (eqType > 0) return 'primitive'
  return 'unknown'
}

function parseEngineEntry(entry: string): EngineCommandInfo {
  const tab = entry.indexOf('\t')
  if (tab < 0) return { name: entry, eqType: -1, argCount: -1, category: 'unknown' }
  const name = entry.slice(0, tab)
  const rest = entry.slice(tab + 1)
  const tab2 = rest.indexOf('\t')
  if (tab2 < 0) {
    // 2-column: name\teqType (backward compat with old WASM)
    const eqType = parseInt(rest, 10)
    if (Number.isNaN(eqType)) return { name, eqType: -1, argCount: -1, category: 'unknown' }
    return { name, eqType, argCount: -1, category: classifyEqType(eqType) }
  }
  // 3-column: name\teqType\targCount
  const eqType = parseInt(rest.slice(0, tab2), 10)
  const argCount = parseInt(rest.slice(tab2 + 1), 10)
  if (Number.isNaN(eqType)) return { name, eqType: -1, argCount: -1, category: 'unknown' }
  return {
    name,
    eqType,
    argCount: Number.isNaN(argCount) ? -1 : argCount,
    category: classifyEqType(eqType),
  }
}

function detectEnvironments(names: Set<string>): Set<string> {
  const envs = new Set<string>()
  for (const name of names) {
    if (name.length > 3 && name.startsWith('end')) {
      const base = name.slice(3)
      if (!ENV_BLOCKLIST.has(base) && names.has(base)) {
        envs.add(base)
      }
    }
  }
  return envs
}

export class ProjectIndex {
  private files = new Map<string, FileSymbols>()
  private auxData: AuxData = { labels: new Map(), citations: new Set(), includes: [] }
  private bibEntries: BibEntry[] = []
  private engineCommands = new Map<string, EngineCommandInfo>()
  private engineEnvironments = new Set<string>()
  private semanticTrace: SemanticTrace | null = null

  updateFile(filePath: string, content: string): void {
    this.files.set(filePath, parseLatexFile(content, filePath))
  }

  removeFile(filePath: string): void {
    this.files.delete(filePath)
  }

  updateAux(content: string): void {
    this.auxData = parseAuxFile(content)
  }

  updateBib(entries: BibEntry[]): void {
    this.bibEntries = entries
  }

  updateAuxData(data: AuxData): void {
    this.auxData = data
  }

  // --- Queries ---

  getFiles(): string[] {
    return [...this.files.keys()]
  }

  hasFile(filePath: string): boolean {
    return this.files.has(filePath)
  }

  getAllLabels(): LabelDef[] {
    return [...this.files.values()].flatMap((s) => s.labels)
  }

  getAllLabelRefs(name: string): LabelRef[] {
    return [...this.files.values()].flatMap((s) => s.labelRefs.filter((r) => r.name === name))
  }

  getFileSymbols(filePath: string): FileSymbols | undefined {
    return this.files.get(filePath)
  }

  getCommandDefs(): CommandDef[] {
    return [...this.files.values()].flatMap((s) => s.commands)
  }

  getAllEnvironments(): string[] {
    const names = new Set<string>()
    for (const symbols of this.files.values()) {
      for (const env of symbols.environments) {
        names.add(env.name)
      }
    }
    return [...names]
  }

  getBibEntries(): BibEntry[] {
    return this.bibEntries
  }

  getAuxLabels(): Map<string, string> {
    return this.auxData.labels
  }

  getAuxCitations(): Set<string> {
    return this.auxData.citations
  }

  resolveLabel(name: string): string | undefined {
    return this.auxData.labels.get(name)
  }

  /** Find the LabelDef for a given label name */
  findLabelDef(name: string): LabelDef | undefined {
    for (const symbols of this.files.values()) {
      for (const label of symbols.labels) {
        if (label.name === name) return label
      }
    }
    return undefined
  }

  updateEngineCommands(commands: string[]): void {
    this.engineCommands = new Map()
    const names = new Set<string>()
    for (const entry of commands) {
      const info = parseEngineEntry(entry)
      if (L3_INTERNAL_RE.test(info.name)) continue
      this.engineCommands.set(info.name, info)
      names.add(info.name)
    }
    // LaTeX's \DeclareRobustCommand creates a 0-arg wrapper "\foo" that
    // calls an inner "\foo " (trailing space) which has the real args.
    // Merge arg counts from "name " entries into "name" entries.
    for (const [name, info] of this.engineCommands) {
      if (!name.endsWith(' ') || info.argCount <= 0) continue
      const baseName = name.trimEnd()
      const baseInfo = this.engineCommands.get(baseName)
      if (baseInfo && baseInfo.argCount <= 0) {
        baseInfo.argCount = info.argCount
      }
    }
    this.engineEnvironments = detectEnvironments(names)
  }

  getEngineCommands(): ReadonlyMap<string, EngineCommandInfo> {
    return this.engineCommands
  }

  getEngineEnvironments(): ReadonlySet<string> {
    return this.engineEnvironments
  }

  updateSemanticTrace(trace: SemanticTrace): void {
    this.semanticTrace = trace
  }

  getSemanticTrace(): SemanticTrace | null {
    return this.semanticTrace
  }

  /** Find the BibitemDef for a given citation key */
  findBibitemDef(key: string): BibitemDef | undefined {
    for (const symbols of this.files.values()) {
      for (const item of symbols.bibItems) {
        if (item.key === key) return item
      }
    }
    return undefined
  }

  /** Find the BibEntry for a given citation key in .bib files */
  findBibEntry(key: string): BibEntry | undefined {
    return this.bibEntries.find((e) => e.key === key)
  }

  /** Find the CommandDef for a given command name */
  findCommandDef(name: string): CommandDef | undefined {
    for (const symbols of this.files.values()) {
      for (const cmd of symbols.commands) {
        if (cmd.name === name) return cmd
      }
    }
    return undefined
  }

  /** Find the Environment definition for a given environment name */
  findEnvironmentDef(name: string): EnvironmentUse | undefined {
    for (const symbols of this.files.values()) {
      for (const env of symbols.environmentDefs) {
        if (env.name === name) return env
      }
    }
    return undefined
  }

  /** Find the symbol at a given position and its usage locations */
  findSymbolAt(
    filePath: string,
    line: number,
    column: number,
  ): { name: string; type: 'label' | 'citation' | 'command' } | undefined {
    const symbols = this.files.get(filePath)
    if (!symbols) return undefined

    return (
      this.findLabelAt(symbols, line, column) ||
      this.findCitationAt(symbols, line, column) ||
      this.findCommandAt(symbols, line, column)
    )
  }

  private findLabelAt(symbols: FileSymbols, line: number, column: number) {
    for (const label of symbols.labels) {
      if (
        label.location.line === line &&
        column >= label.location.column &&
        column <= label.location.column + label.name.length
      ) {
        return { name: label.name, type: 'label' as const }
      }
    }
    for (const ref of symbols.labelRefs) {
      if (
        ref.location.line === line &&
        column >= ref.location.column &&
        column <= ref.location.column + ref.name.length
      ) {
        return { name: ref.name, type: 'label' as const }
      }
    }
    return undefined
  }

  private findCitationAt(symbols: FileSymbols, line: number, column: number) {
    for (const ref of symbols.citations) {
      if (
        ref.location.line === line &&
        column >= ref.location.column &&
        column <= ref.location.column + ref.key.length
      ) {
        return { name: ref.key, type: 'citation' as const }
      }
    }
    for (const item of symbols.bibItems) {
      if (
        item.location.line === line &&
        column >= item.location.column &&
        column <= item.location.column + item.key.length
      ) {
        return { name: item.key, type: 'citation' as const }
      }
    }
    return undefined
  }

  private findCommandAt(symbols: FileSymbols, line: number, column: number) {
    for (const cmd of symbols.commands) {
      if (
        cmd.location.line === line &&
        column >= cmd.location.column &&
        column <= cmd.location.column + cmd.name.length
      ) {
        return { name: cmd.name, type: 'command' as const }
      }
    }
    return undefined
  }

  /** Find all occurrences of a symbol across the project */
  findAllOccurrences(
    name: string,
    type: 'label' | 'citation' | 'command',
  ): { filePath: string; line: number; column: number; length: number }[] {
    const occurrences: { filePath: string; line: number; column: number; length: number }[] = []

    for (const [path, symbols] of this.files.entries()) {
      if (type === 'label') {
        this.collectLabelOccurrences(symbols, path, name, occurrences)
      } else if (type === 'citation') {
        this.collectCitationOccurrences(symbols, path, name, occurrences)
      } else if (type === 'command') {
        this.collectCommandOccurrences(symbols, path, name, occurrences)
      }
    }

    // Also check .bib files for citations
    if (type === 'citation') {
      for (const entry of this.bibEntries) {
        if (entry.key === name) {
          occurrences.push({
            filePath: entry.location.file,
            line: entry.location.line,
            column: entry.location.column,
            length: name.length,
          })
        }
      }
    }

    return occurrences
  }

  private collectLabelOccurrences(
    symbols: FileSymbols,
    path: string,
    name: string,
    out: { filePath: string; line: number; column: number; length: number }[],
  ) {
    for (const label of symbols.labels) {
      if (label.name === name) {
        out.push({
          filePath: path,
          line: label.location.line,
          column: label.location.column,
          length: name.length,
        })
      }
    }
    for (const ref of symbols.labelRefs) {
      if (ref.name === name) {
        out.push({
          filePath: path,
          line: ref.location.line,
          column: ref.location.column,
          length: name.length,
        })
      }
    }
  }

  private collectCitationOccurrences(
    symbols: FileSymbols,
    path: string,
    name: string,
    out: { filePath: string; line: number; column: number; length: number }[],
  ) {
    for (const ref of symbols.citations) {
      if (ref.key === name) {
        out.push({
          filePath: path,
          line: ref.location.line,
          column: ref.location.column,
          length: name.length,
        })
      }
    }
    for (const item of symbols.bibItems) {
      if (item.key === name) {
        out.push({
          filePath: path,
          line: item.location.line,
          column: item.location.column,
          length: name.length,
        })
      }
    }
  }

  private collectCommandOccurrences(
    symbols: FileSymbols,
    path: string,
    name: string,
    out: { filePath: string; line: number; column: number; length: number }[],
  ) {
    for (const cmd of symbols.commands) {
      if (cmd.name === name) {
        out.push({
          filePath: path,
          line: cmd.location.line,
          column: cmd.location.column,
          length: name.length,
        })
      }
    }
  }
}
