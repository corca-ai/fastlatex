import { parseAuxFile } from './aux-parser'
import { parseLatexFile } from './latex-parser'
import type {
  AuxData,
  BibEntry,
  BibitemDef,
  CitationRef,
  CommandDef,
  FileSymbols,
  LabelDef,
  LabelRef,
  SectionDef,
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
  private inputFiles: string[] = []
  private engineCommands = new Map<string, EngineCommandInfo>()
  private engineEnvironments = new Set<string>()
  private loadedPackages = new Map<string, string>()

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

  updateInputFiles(files: string[]): void {
    this.inputFiles = files
  }

  getInputFiles(): readonly string[] {
    return this.inputFiles
  }

  // --- Queries ---

  getFiles(): string[] {
    return [...this.files.keys()]
  }

  getAllLabels(): LabelDef[] {
    return [...this.files.values()].flatMap((s) => s.labels)
  }

  getAllLabelRefs(name: string): LabelRef[] {
    return [...this.files.values()].flatMap((s) => s.labelRefs.filter((r) => r.name === name))
  }

  getAllCitations(): CitationRef[] {
    return [...this.files.values()].flatMap((s) => s.citations)
  }

  getAllSections(): SectionDef[] {
    return [...this.files.values()].flatMap((s) => s.sections)
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

  updateLogData(log: string): void {
    this.loadedPackages = new Map()
    const re = /^Package:\s+(\S+)\s+\d{4}\/\d{2}\/\d{2}\s+(v?\S+)/gm
    for (const m of log.matchAll(re)) {
      this.loadedPackages.set(m[1]!, m[2]!)
    }
  }

  getLoadedPackages(): ReadonlyMap<string, string> {
    return this.loadedPackages
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

  /** Find the CommandDef for a given command name */
  findCommandDef(name: string): CommandDef | undefined {
    for (const symbols of this.files.values()) {
      for (const cmd of symbols.commands) {
        if (cmd.name === name) return cmd
      }
    }
    return undefined
  }
}
