import type { TexError } from '../types'

/** Search up to 5 lines ahead for "l.42 ..." pattern */
function findLineNumber(lines: string[], start: number): number {
  const end = Math.min(start + 5, lines.length)
  for (let j = start; j < end; j++) {
    const m = lines[j]!.match(/^l\.(\d+)\s/)
    if (m) return parseInt(m[1]!, 10)
  }
  return 0
}

/** Extract line number from "at lines? N" on current or next line */
function findBoxLineNumber(line: string, nextLine: string): number {
  const m = line.match(/at lines? (\d+)/) ?? nextLine.match(/at lines? (\d+)/)
  return m ? parseInt(m[1]!, 10) : 0
}

/** Extract "on input line N" from a log line, or 0 */
function extractInputLine(line: string): number {
  const m = line.match(/on input line (\d+)/)
  return m ? parseInt(m[1]!, 10) : 0
}

function tryTexError(line: string, lines: string[], i: number, out: TexError[]): boolean {
  const m = line.match(/^! (.+)/)
  if (!m) return false
  out.push({ line: findLineNumber(lines, i + 1), message: m[1]!, severity: 'error' })
  return true
}

function tryLatexWarning(line: string, out: TexError[]): boolean {
  const m = line.match(/LaTeX Warning:\s*(.+)/)
  if (!m) return false
  out.push({ line: extractInputLine(line), message: m[1]!, severity: 'warning' })
  return true
}

function tryPackageError(line: string, lines: string[], i: number, out: TexError[]): boolean {
  const m = line.match(/^Package (\S+) Error:\s*(.+)/)
  if (!m) return false
  const lineNum = extractInputLine(line) || findLineNumber(lines, i + 1)
  out.push({ line: lineNum, message: `[${m[1]}] ${m[2]}`, severity: 'error' })
  return true
}

function tryPackageWarning(line: string, out: TexError[]): boolean {
  const m = line.match(/^Package (\S+) Warning:\s*(.+)/)
  if (!m) return false
  out.push({ line: extractInputLine(line), message: `[${m[1]}] ${m[2]}`, severity: 'warning' })
  return true
}

function tryBoxWarning(line: string, nextLine: string, out: TexError[]): boolean {
  if (!/^Overfull \\[hv]box .+/.test(line)) return false
  out.push({ line: findBoxLineNumber(line, nextLine), message: line, severity: 'warning' })
  return true
}

export function parseTexErrors(log: string): TexError[] {
  const errors: TexError[] = []
  const lines = log.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (tryTexError(line, lines, i, errors)) continue
    if (tryLatexWarning(line, errors)) continue
    if (tryPackageError(line, lines, i, errors)) continue
    if (tryPackageWarning(line, errors)) continue
    tryBoxWarning(line, lines[i + 1] ?? '', errors)
  }

  return errors
}
