export interface PreambleSplit {
  /** Everything before \begin{document} */
  preamble: string
  /** Everything from \begin{document} onwards (inclusive) */
  body: string
  /** Number of lines in the preamble portion */
  preambleLineCount: number
}

/**
 * Split TeX source into preamble and body at the \begin{document} boundary.
 * Returns null if \begin{document} is not found or is inside a comment.
 */
export function extractPreamble(texSource: string): PreambleSplit | null {
  const marker = '\\begin{document}'
  let searchFrom = 0

  while (true) {
    const idx = texSource.indexOf(marker, searchFrom)
    if (idx === -1) return null

    // Skip if \begin{document} is inside a comment
    const lineStart = texSource.lastIndexOf('\n', idx - 1) + 1
    if (texSource.substring(lineStart, idx).includes('%')) {
      searchFrom = idx + marker.length
      continue
    }

    return {
      preamble: texSource.substring(0, idx),
      body: texSource.substring(idx),
      preambleLineCount: texSource.substring(0, idx).split('\n').length,
    }
  }
}

/**
 * Simple string hash (djb2 variant). Returns a base-36 string.
 * Used to detect preamble changes without comparing full text.
 */
export function simpleHash(str: string): string {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0
  }
  return h.toString(36)
}
