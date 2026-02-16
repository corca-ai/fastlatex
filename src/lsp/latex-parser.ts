import {
  CITE_CMDS,
  INPUT_CMDS,
  NEWCMD_CMDS,
  REF_CMDS,
  SECTION_CMDS,
  USEPACKAGE_CMDS,
} from './latex-patterns'
import type { CommandDef, FileSymbols, SectionLevel, SourceLocation } from './types'

/** Strip comments: remove everything after unescaped % */
function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
      return line.slice(0, i)
    }
  }
  return line
}

/** Extract content of a balanced brace group starting at `{` */
function extractBraceContent(text: string, startIndex: number): string | null {
  if (text[startIndex] !== '{') return null
  let depth = 0
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(startIndex + 1, i)
    }
  }
  return null
}

const LABEL_RE = /\\label\{/g
const REF_RE = new RegExp(`\\\\(?:${REF_CMDS})\\{`, 'g')
const CITE_RE = new RegExp(`\\\\(?:${CITE_CMDS})(?:\\[.*?\\])?\\{`, 'g')
const SECTION_RE = new RegExp(`\\\\(${SECTION_CMDS})\\*?\\{`, 'g')
const NEWCOMMAND_RE = new RegExp(`\\\\(?:${NEWCMD_CMDS})\\*?\\{\\\\(\\w+)\\}(?:\\[(\\d+)\\])?`, 'g')
const DEF_RE = /\\def\\(\w+)/g
const DECLARE_MATH_RE = /\\DeclareMathOperator\*?\{\\(\w+)\}/g
const BIBITEM_RE = /\\bibitem(?:\[.*?\])?\{/g
const BEGIN_RE = /\\begin\{/g
const INPUT_RE = new RegExp(`\\\\(${INPUT_CMDS})\\{`, 'g')
const USEPACKAGE_RE = new RegExp(`\\\\(?:${USEPACKAGE_CMDS})(?:\\[(.*?)\\])?\\{`, 'g')

function loc(file: string, line: number, column: number): SourceLocation {
  return { file, line, column }
}

function extractLabels(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(LABEL_RE)) {
    const name = extractBraceContent(line, m.index + m[0].length - 1)
    if (name && !name.includes('#')) {
      symbols.labels.push({ name, location: loc(filePath, lineNum, m.index + 1) })
    }
  }
}

function extractRefs(line: string, filePath: string, lineNum: number, symbols: FileSymbols): void {
  for (const m of line.matchAll(REF_RE)) {
    const name = extractBraceContent(line, m.index + m[0].length - 1)
    if (name) {
      symbols.labelRefs.push({ name, location: loc(filePath, lineNum, m.index + 1) })
    }
  }
}

function extractCitations(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(CITE_RE)) {
    const keys = extractBraceContent(line, m.index + m[0].length - 1)
    if (keys) {
      for (const key of keys.split(',')) {
        const trimmed = key.trim()
        if (trimmed) {
          symbols.citations.push({
            key: trimmed,
            location: loc(filePath, lineNum, m.index + 1),
          })
        }
      }
    }
  }
}

function extractSections(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(SECTION_RE)) {
    const title = extractBraceContent(line, m.index + m[0].length - 1)
    if (title) {
      symbols.sections.push({
        level: m[1] as SectionLevel,
        title,
        location: loc(filePath, lineNum, m.index + 1),
      })
    }
  }
}

function extractNewCommands(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(NEWCOMMAND_RE)) {
    const def: CommandDef = {
      name: m[1]!,
      location: loc(filePath, lineNum, m.index + 1),
    }
    if (m[2]) def.argCount = Number.parseInt(m[2], 10)
    symbols.commands.push(def)
  }
}

function extractDefs(line: string, filePath: string, lineNum: number, symbols: FileSymbols): void {
  for (const m of line.matchAll(DEF_RE)) {
    symbols.commands.push({
      name: m[1]!,
      location: loc(filePath, lineNum, m.index + 1),
    })
  }
}

function extractDeclareMath(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(DECLARE_MATH_RE)) {
    symbols.commands.push({
      name: m[1]!,
      location: loc(filePath, lineNum, m.index + 1),
    })
  }
}

function extractBibItems(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(BIBITEM_RE)) {
    const key = extractBraceContent(line, m.index + m[0].length - 1)
    if (key) {
      symbols.bibItems.push({ key, location: loc(filePath, lineNum, m.index + 1) })
    }
  }
}

function extractEnvironments(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(BEGIN_RE)) {
    const name = extractBraceContent(line, m.index + m[0].length - 1)
    if (name) {
      symbols.environments.push({
        name,
        location: loc(filePath, lineNum, m.index + 1),
      })
    }
  }
}

function extractIncludes(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(INPUT_RE)) {
    const braceIdx = line.indexOf('{', m.index + m[1]!.length + 1)
    if (braceIdx >= 0) {
      const path = extractBraceContent(line, braceIdx)
      if (path) {
        symbols.includes.push({
          path,
          location: loc(filePath, lineNum, m.index + 1),
          type: m[1] as 'input' | 'include' | 'subfile',
        })
      }
    }
  }
}

function pushPackageNames(
  names: string,
  options: string,
  location: SourceLocation,
  symbols: FileSymbols,
): void {
  for (const pkg of names.split(',')) {
    const trimmed = pkg.trim()
    if (trimmed) {
      symbols.packages.push({ name: trimmed, options, location })
    }
  }
}

function extractPackages(
  line: string,
  filePath: string,
  lineNum: number,
  symbols: FileSymbols,
): void {
  for (const m of line.matchAll(USEPACKAGE_RE)) {
    const braceIdx = line.indexOf('{', m.index + m[0].length - 1)
    if (braceIdx < 0) continue
    const names = extractBraceContent(line, braceIdx)
    if (names) {
      pushPackageNames(names, m[1] ?? '', loc(filePath, lineNum, m.index + 1), symbols)
    }
  }
}

export function parseLatexFile(content: string, filePath: string): FileSymbols {
  const symbols: FileSymbols = {
    labels: [],
    labelRefs: [],
    citations: [],
    sections: [],
    commands: [],
    environments: [],
    includes: [],
    packages: [],
    bibItems: [],
  }

  const lines = content.split('\n')

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const raw = lines[lineIdx]!
    const line = stripComment(raw)
    const lineNum = lineIdx + 1

    extractLabels(line, filePath, lineNum, symbols)
    extractRefs(line, filePath, lineNum, symbols)
    extractCitations(line, filePath, lineNum, symbols)
    extractSections(line, filePath, lineNum, symbols)
    extractNewCommands(line, filePath, lineNum, symbols)
    extractDefs(line, filePath, lineNum, symbols)
    extractDeclareMath(line, filePath, lineNum, symbols)
    extractBibItems(line, filePath, lineNum, symbols)
    extractEnvironments(line, filePath, lineNum, symbols)
    extractIncludes(line, filePath, lineNum, symbols)
    extractPackages(line, filePath, lineNum, symbols)
  }

  return symbols
}
