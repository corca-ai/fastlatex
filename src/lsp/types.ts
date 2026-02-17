export interface SourceLocation {
  file: string
  line: number
  column: number
}

export interface LabelDef {
  name: string
  location: SourceLocation
}

export interface LabelRef {
  name: string
  location: SourceLocation
}

export interface CitationRef {
  key: string
  location: SourceLocation
}

export type SectionLevel =
  | 'part'
  | 'chapter'
  | 'section'
  | 'subsection'
  | 'subsubsection'
  | 'paragraph'

export interface SectionDef {
  level: SectionLevel
  title: string
  location: SourceLocation
}

export interface CommandDef {
  name: string
  location: SourceLocation
  argCount?: number
}

export interface EnvironmentUse {
  name: string
  location: SourceLocation
}

export interface IncludeDef {
  path: string
  location: SourceLocation
  type: 'input' | 'include' | 'subfile'
}

export interface PackageRef {
  name: string
  options: string
  location: SourceLocation
}

export interface FileSymbols {
  labels: LabelDef[]
  labelRefs: LabelRef[]
  citations: CitationRef[]
  sections: SectionDef[]
  commands: CommandDef[]
  environments: EnvironmentUse[]
  environmentDefs: EnvironmentUse[] // Reuse EnvironmentUse for definitions
  includes: IncludeDef[]
  packages: PackageRef[]
  bibItems: BibitemDef[]
}

export interface AuxData {
  labels: Map<string, string>
  citations: Set<string>
  includes: string[]
}

export interface BibitemDef {
  key: string
  location: SourceLocation
}

export interface BibEntry {
  key: string
  type: string
  location: SourceLocation
  title?: string
  author?: string
}
