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

export function parseTexErrors(log: string): TexError[] {
  const errors: TexError[] = []
  const lines = log.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // Match "! Error message" pattern
    const errorMatch = line.match(/^! (.+)/)
    if (errorMatch) {
      errors.push({
        line: findLineNumber(lines, i + 1),
        message: errorMatch[1]!,
        severity: 'error',
      })
      continue
    }

    // Match "LaTeX Warning:" pattern
    const warnMatch = line.match(/LaTeX Warning:\s*(.+)/)
    if (warnMatch) {
      const m = line.match(/on input line (\d+)/)
      errors.push({
        line: m ? parseInt(m[1]!, 10) : 0,
        message: warnMatch[1]!,
        severity: 'warning',
      })
      continue
    }

    // Match "Overfull \hbox ..." warnings (skip Underfull — rarely actionable)
    if (/^Overfull \\[hv]box .+/.test(line)) {
      errors.push({
        line: findBoxLineNumber(line, lines[i + 1] ?? ''),
        message: line,
        severity: 'warning',
      })
    }
  }

  return errors
}
