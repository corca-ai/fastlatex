import type { TexError } from '../types'

export function parseTexErrors(log: string): TexError[] {
  const errors: TexError[] = []
  const lines = log.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // Match "! Error message" pattern
    const errorMatch = line.match(/^! (.+)/)
    if (errorMatch) {
      // Look for line number in nearby lines: "l.42 ..."
      let lineNum = 0
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const lineMatch = lines[j]!.match(/^l\.(\d+)\s/)
        if (lineMatch) {
          lineNum = parseInt(lineMatch[1]!, 10)
          break
        }
      }
      errors.push({ line: lineNum, message: errorMatch[1]!, severity: 'error' })
    }

    // Match "LaTeX Warning:" pattern
    const warnMatch = line.match(/LaTeX Warning:\s*(.+)/)
    if (warnMatch) {
      const warnLineMatch = line.match(/on input line (\d+)/)
      const lineNum = warnLineMatch ? parseInt(warnLineMatch[1]!, 10) : 0
      errors.push({ line: lineNum, message: warnMatch[1]!, severity: 'warning' })
    }
  }

  return errors
}
