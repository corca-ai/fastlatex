import type * as pdfjsLib from 'pdfjs-dist'

export interface SourceLocation {
  file: string
  line: number
}

interface TextBlock {
  text: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Maps PDF text positions back to source lines using text content matching.
 * Approximate — works for plain text, not for math/tables/figures.
 */
export class TextMapper {
  private pageBlocks: Map<number, TextBlock[]> = new Map()
  private sourceLines: Map<string, string[]> = new Map()

  /** Register source file content for matching */
  setSource(file: string, content: string): void {
    this.sourceLines.set(file, content.split('\n'))
  }

  /** Extract text blocks from a PDF page */
  async indexPage(page: pdfjsLib.PDFPageProxy, pageNum: number): Promise<void> {
    const textContent = await page.getTextContent()
    const viewport = page.getViewport({ scale: 1.0 })
    const blocks: TextBlock[] = []

    for (const item of textContent.items) {
      if (!('str' in item) || !item.str.trim()) continue

      // transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const tx = item.transform
      if (!tx) continue

      blocks.push({
        text: item.str,
        x: tx[4]!,
        // PDF coordinates: origin at bottom-left, Y up → flip to top-left origin
        y: viewport.height - tx[5]!,
        width: item.width ?? 0,
        height: item.height ?? Math.abs(tx[3]!),
      })
    }

    this.pageBlocks.set(pageNum, blocks)
  }

  /** Find the source line for a click at (x, y) on the given page */
  lookup(pageNum: number, x: number, y: number): SourceLocation | null {
    const blocks = this.pageBlocks.get(pageNum)
    if (!blocks || blocks.length === 0) return null

    // Find closest text block to click position
    const block = this.findClosestBlock(blocks, x, y)
    if (!block) return null

    // Match block text against source lines
    return this.matchTextToSource(block.text)
  }

  /** Clear all indexed data */
  clear(): void {
    this.pageBlocks.clear()
  }

  private findClosestBlock(blocks: TextBlock[], x: number, y: number): TextBlock | null {
    let best: TextBlock | null = null
    let bestDist = Infinity

    for (const block of blocks) {
      // Distance from click to block center
      const cx = block.x + block.width / 2
      const cy = block.y - block.height / 2
      const dist = Math.hypot(x - cx, y - cy)

      if (dist < bestDist) {
        bestDist = dist
        best = block
      }
    }

    return best
  }

  private matchTextToSource(text: string): SourceLocation | null {
    const needle = text.trim()
    if (!needle) return null

    // Exact match
    const exact = this.findInSources(needle)
    if (exact) return exact

    // Partial match (first 10+ chars)
    if (needle.length >= 10) {
      return this.findInSources(needle.slice(0, 10))
    }

    return null
  }

  private findInSources(needle: string): SourceLocation | null {
    for (const [file, lines] of this.sourceLines) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes(needle)) {
          return { file, line: i + 1 }
        }
      }
    }
    return null
  }
}
