import { parseAuxFile } from './aux-parser'
import { parseLatexFile } from './latex-parser'
import type {
  AuxData,
  BibEntry,
  CitationRef,
  CommandDef,
  FileSymbols,
  LabelDef,
  LabelRef,
  SectionDef,
} from './types'

export class ProjectIndex {
  private files = new Map<string, FileSymbols>()
  private auxData: AuxData = { labels: new Map(), citations: new Set() }
  private bibEntries: BibEntry[] = []
  private engineCommands = new Set<string>()

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

  // --- Queries ---

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
    this.engineCommands = new Set(commands)
  }

  getEngineCommands(): ReadonlySet<string> {
    return this.engineCommands
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
