/**
 * SyncTeX file parser for PDF↔source bidirectional navigation.
 *
 * Parses the text-based .synctex format (or gzip-compressed .synctex.gz)
 * produced by pdfTeX with `-synctex=1`. Provides inverse search (PDF click →
 * source line) and forward search (source line → PDF region).
 *
 * Coordinate system: SyncTeX stores positions in TeX scaled points (sp).
 * We convert to PDF points (bp, 1/72 inch) for use with PDF.js viewports.
 *   pdf_pt = sp * unit * magnification / 1000 / 65536 * 72 / 72.27
 */

// Re-export SourceLocation so consumers can import from either module
export type { PdfLocation, SourceLocation } from './text-mapper'

import type { PdfLocation, SourceLocation } from './text-mapper'

export interface SynctexNode {
  type: 'hbox' | 'vbox' | 'kern' | 'glue' | 'math' | 'void_vbox' | 'void_hbox'
  input: number
  line: number
  column: number
  page: number
  /** Horizontal position in PDF points from left edge */
  h: number
  /** Vertical position in PDF points from top edge (downward positive) */
  v: number
  /** Width in PDF points */
  width: number
  /** Height in PDF points (above baseline) */
  height: number
  /** Depth in PDF points (below baseline) */
  depth: number
}

export interface SynctexData {
  inputs: Map<number, string>
  pages: Map<number, SynctexNode[]>
  magnification: number
  unit: number
  xOffset: number
  yOffset: number
}

/** Conversion factor: TeX points to PDF points (big points) */
const TEX_TO_PDF = 72 / 72.27

/**
 * Convert a raw synctex coordinate value to PDF points.
 * Formula: value * unit * (magnification/1000) / 65536 * (72/72.27)
 */
function spToPdfPt(value: number, unit: number, mag: number): number {
  return ((value * unit * mag) / (1000 * 65536)) * TEX_TO_PDF
}

/**
 * Decompress gzipped data using the browser's DecompressionStream API.
 * Falls back to returning the input unchanged if not gzipped.
 */
async function maybeDecompress(data: Uint8Array): Promise<Uint8Array> {
  // Check gzip magic number: 0x1f 0x8b
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream not available — cannot decompress synctex.gz')
    }
    const ds = new DecompressionStream('gzip')
    const writer = ds.writable.getWriter()
    const reader = ds.readable.getReader()

    writer.write(data as unknown as BufferSource)
    writer.close()

    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
  return data
}

/**
 * Parse a tag,line[,column] prefix that appears in synctex node records.
 * Returns [tag, line, column, restOfLine].
 */
function parseTagLineColumn(s: string): [number, number, number, string] {
  // Format: "tag,line:..." or "tag,line,column:..."
  const colonIdx = s.indexOf(':')
  if (colonIdx === -1) return [0, 0, 0, '']

  const prefix = s.slice(0, colonIdx)
  const rest = s.slice(colonIdx + 1)
  const parts = prefix.split(',')

  const tag = parseInt(parts[0] ?? '0', 10)
  const line = parseInt(parts[1] ?? '0', 10)
  const column = parts.length > 2 ? parseInt(parts[2] ?? '0', 10) : 0

  return [tag, line, column, rest]
}

/**
 * Parse the coordinate portion "h,v:W,H,D" or "h,v" from a synctex record.
 * Returns [h, v, W, H, D] (W/H/D default to 0 if absent).
 */
function parseCoords(s: string): [number, number, number, number, number] {
  // Full format: "h,v:W,H,D"
  // Short format: "h,v" (for kern/glue/math without dimensions)
  const colonIdx = s.indexOf(':')
  let hvPart: string
  let whdPart: string | null

  if (colonIdx === -1) {
    hvPart = s
    whdPart = null
  } else {
    hvPart = s.slice(0, colonIdx)
    whdPart = s.slice(colonIdx + 1)
  }

  const hvParts = hvPart.split(',')
  const h = parseInt(hvParts[0] ?? '0', 10)
  const v = parseInt(hvParts[1] ?? '0', 10)

  if (!whdPart) return [h, v, 0, 0, 0]

  const whdParts = whdPart.split(',')
  const W = parseInt(whdParts[0] ?? '0', 10)
  const H = parseInt(whdParts[1] ?? '0', 10)
  const D = parseInt(whdParts[2] ?? '0', 10)

  return [h, v, W, H, D]
}

type NodeType = SynctexNode['type']

/** Node type prefix → type name mapping */
const NODE_PREFIXES: Record<string, NodeType> = {
  '[': 'vbox',
  '(': 'hbox',
  v: 'void_vbox',
  h: 'void_hbox',
  x: 'kern',
  k: 'kern',
  g: 'glue',
  $: 'math',
}

export class SynctexParser {
  /**
   * Parse raw synctex data (possibly gzip-compressed) into structured data.
   */
  async parse(data: Uint8Array): Promise<SynctexData> {
    const bytes = await maybeDecompress(data)
    const text = new TextDecoder().decode(bytes)
    return this.parseText(text)
  }

  /**
   * Parse synctex text content directly (for testing without gzip).
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: parser inherently complex, tree rewrite planned
  parseText(text: string): SynctexData {
    const result: SynctexData = {
      inputs: new Map(),
      pages: new Map(),
      magnification: 1000,
      unit: 1,
      xOffset: 0,
      yOffset: 0,
    }

    const lines = text.split('\n')
    let currentPage = 0
    let inContent = false

    for (const line of lines) {
      if (!line) continue

      // Preamble section
      if (!inContent) {
        if (line === 'Content:') {
          inContent = true
          continue
        }
        if (line.startsWith('Input:')) {
          const firstColon = line.indexOf(':')
          const secondColon = line.indexOf(':', firstColon + 1)
          if (secondColon !== -1) {
            const tag = parseInt(line.slice(firstColon + 1, secondColon), 10)
            let name = line.slice(secondColon + 1)
            // Normalize: strip leading "./"
            if (name.startsWith('./')) name = name.slice(2)
            result.inputs.set(tag, name)
          }
        } else if (line.startsWith('Magnification:')) {
          result.magnification = parseInt(line.slice('Magnification:'.length), 10)
        } else if (line.startsWith('Unit:')) {
          result.unit = parseInt(line.slice('Unit:'.length), 10)
        } else if (line.startsWith('X Offset:')) {
          result.xOffset = parseInt(line.slice('X Offset:'.length), 10)
        } else if (line.startsWith('Y Offset:')) {
          result.yOffset = parseInt(line.slice('Y Offset:'.length), 10)
        }
        continue
      }

      // Postamble — stop parsing
      if (line.startsWith('Postamble:') || line === 'Postamble:') break

      // Content section
      const firstChar = line[0]!

      // Page boundaries
      if (firstChar === '{') {
        currentPage = parseInt(line.slice(1), 10)
        if (!result.pages.has(currentPage)) {
          result.pages.set(currentPage, [])
        }
        continue
      }
      if (firstChar === '}') continue

      // Close brackets — no data to extract
      if (firstChar === ']' || firstChar === ')') continue

      // Anchor lines
      if (firstChar === '!') continue

      // Node records
      const nodeType = NODE_PREFIXES[firstChar]
      if (!nodeType || currentPage === 0) continue

      const content =
        firstChar === '[' || firstChar === '(' || firstChar === '$' ? line.slice(1) : line.slice(1)

      const [tag, sourceLine, column, coordStr] = parseTagLineColumn(content)
      if (!coordStr && sourceLine === 0) continue

      const [h, v, W, H, D] = parseCoords(coordStr)

      const unit = result.unit
      const mag = result.magnification

      const node: SynctexNode = {
        type: nodeType,
        input: tag,
        line: sourceLine,
        column,
        page: currentPage,
        h: spToPdfPt(h + result.xOffset, unit, mag),
        v: spToPdfPt(v + result.yOffset, unit, mag),
        width: spToPdfPt(Math.abs(W), unit, mag),
        height: spToPdfPt(Math.abs(H), unit, mag),
        depth: spToPdfPt(Math.abs(D), unit, mag),
      }

      result.pages.get(currentPage)!.push(node)
    }

    return result
  }

  /**
   * Inverse search: given a click position on a PDF page, find the source location.
   *
   * @param data - Parsed synctex data
   * @param page - 1-based page number
   * @param x - X position in PDF points (from left edge)
   * @param y - Y position in PDF points (from top edge, downward)
   * @returns Source location or null if no match found
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: search heuristic, tree rewrite planned
  inverseLookup(data: SynctexData, page: number, x: number, y: number): SourceLocation | null {
    const nodes = data.pages.get(page)
    if (!nodes || nodes.length === 0) return null

    // First try to find an hbox/void_hbox that contains the click point
    let bestContaining: SynctexNode | null = null
    let bestContainingArea = Infinity

    for (const node of nodes) {
      if (node.type !== 'hbox' && node.type !== 'void_hbox') continue
      if (node.width === 0 || node.height + node.depth === 0) continue

      const totalHeight = node.height + node.depth
      const top = node.v - node.height
      if (x >= node.h && x <= node.h + node.width && y >= top && y <= top + totalHeight) {
        const area = node.width * totalHeight
        if (area < bestContainingArea) {
          bestContaining = node
          bestContainingArea = area
        }
      }
    }

    if (bestContaining) {
      const filename = data.inputs.get(bestContaining.input) ?? ''
      return { file: filename, line: bestContaining.line }
    }

    // Fallback: find the nearest node by distance
    let bestNode: SynctexNode | null = null
    let bestDist = Infinity

    for (const node of nodes) {
      // Skip nodes without source line info
      if (node.line === 0) continue

      const centerX = node.h + node.width / 2
      const centerY = node.v - node.height / 2 + node.depth / 2
      const dist = Math.hypot(x - centerX, y - centerY)

      if (dist < bestDist) {
        bestDist = dist
        bestNode = node
      }
    }

    if (!bestNode) return null

    const filename = data.inputs.get(bestNode.input) ?? ''
    return { file: filename, line: bestNode.line }
  }

  /**
   * Forward search: given a source file and line, find the corresponding PDF region.
   *
   * @param data - Parsed synctex data
   * @param file - Source filename (e.g., "main.tex")
   * @param line - 1-based source line number
   * @returns PDF location or null if no match found
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: search heuristic, tree rewrite planned
  forwardLookup(data: SynctexData, file: string, line: number): PdfLocation | null {
    // Find the input tag for this file
    let inputTag = -1
    for (const [tag, name] of data.inputs) {
      if (name === file || name.endsWith(`/${file}`)) {
        inputTag = tag
        break
      }
    }
    if (inputTag === -1) return null

    // Collect matching nodes, preferring hbox nodes (actual text lines)
    // over vbox/kern/glue which can span large areas or have zero dimensions
    const hboxNodes: SynctexNode[] = []
    const otherNodes: SynctexNode[] = []
    let bestPage = 0

    for (const [page, nodes] of data.pages) {
      for (const node of nodes) {
        if (node.input !== inputTag || node.line !== line) continue
        if (!bestPage) bestPage = page
        if (page !== bestPage) continue

        if (node.type === 'hbox' || node.type === 'void_hbox') {
          hboxNodes.push(node)
        } else {
          otherNodes.push(node)
        }
      }
      if (bestPage) break
    }

    // Log all matching nodes for diagnostics
    console.log(`[synctex-fwd] line=${line}: ${hboxNodes.length} hbox, ${otherNodes.length} other`)
    for (const n of hboxNodes) {
      console.log(
        `  [${n.type}] h=${n.h.toFixed(1)} v=${n.v.toFixed(1)} w=${n.width.toFixed(1)} H=${n.height.toFixed(1)} D=${n.depth.toFixed(1)}`,
      )
    }
    for (const n of otherNodes) {
      console.log(
        `  [${n.type}] h=${n.h.toFixed(1)} v=${n.v.toFixed(1)} w=${n.width.toFixed(1)} H=${n.height.toFixed(1)} D=${n.depth.toFixed(1)}`,
      )
    }

    // When only kern/glue/math nodes found (no hbox), they are zero-dimension
    // markers inside a parent hbox tagged with a different line (from paragraph
    // breaking). Find the smallest enclosing hbox at the same baseline.
    if (hboxNodes.length === 0 && otherNodes.length > 0) {
      const targetV = otherNodes[0]!.v
      const nodeHs = otherNodes.map((n) => n.h)
      const minNodeH = Math.min(...nodeHs)
      const maxNodeH = Math.max(...nodeHs)
      const allPageNodes = data.pages.get(bestPage) ?? []

      let enclosing: SynctexNode | null = null
      let enclosingArea = Infinity

      for (const node of allPageNodes) {
        if (node.type !== 'hbox' || node.width <= 0) continue
        // Baseline must match (within 1pt for float rounding)
        if (Math.abs(node.v - targetV) > 1) continue
        // Must horizontally contain all kern/glue positions
        if (node.h > minNodeH || node.h + node.width < maxNodeH) continue

        const area = node.width * Math.max(node.height + node.depth, 1)
        if (area < enclosingArea) {
          enclosing = node
          enclosingArea = area
        }
      }

      if (enclosing) {
        console.log(
          `  enclosing hbox: h=${enclosing.h.toFixed(1)} v=${enclosing.v.toFixed(1)} w=${enclosing.width.toFixed(1)} H=${enclosing.height.toFixed(1)} D=${enclosing.depth.toFixed(1)}`,
        )
        const top = enclosing.v - enclosing.height
        const height = Math.max(enclosing.height + enclosing.depth, 10)
        return {
          page: bestPage,
          x: enclosing.h,
          y: top,
          width: enclosing.width,
          height,
        }
      }
    }

    // Use hbox nodes if available, otherwise fall back to all nodes
    let candidates = hboxNodes.length > 0 ? hboxNodes : otherNodes
    if (candidates.length === 0) return null

    // If multiple hbox nodes, use gap-based clustering to split truly distant
    // groups (e.g. same line number appearing far apart) while keeping wrapped
    // paragraph lines together (consecutive lines with small v gaps).
    if (candidates.length > 1) {
      candidates.sort((a, b) => a.v - b.v)
      const refHeight = candidates.find((n) => n.height > 0)?.height ?? 10
      // Allow gaps up to 3x line height (covers baselineskip for wrapped lines)
      const maxAllowedGap = refHeight * 3

      const clusters: SynctexNode[][] = [[candidates[0]!]]
      for (let i = 1; i < candidates.length; i++) {
        const gap = candidates[i]!.v - candidates[i - 1]!.v
        if (gap > maxAllowedGap) {
          clusters.push([candidates[i]!])
        } else {
          clusters[clusters.length - 1]!.push(candidates[i]!)
        }
      }

      if (clusters.length > 1) {
        candidates = clusters.reduce((best, c) => (c.length > best.length ? c : best))
        console.log(
          `  split into ${clusters.length} clusters, using largest (${candidates.length} nodes)`,
        )
      } else {
        console.log(
          `  all ${candidates.length} nodes in one cluster (maxGap < ${maxAllowedGap.toFixed(1)})`,
        )
      }
    }

    // Compute bounding box from the selected candidates
    let minH = Infinity
    let maxH = -Infinity
    let minV = Infinity
    let maxVBottom = -Infinity

    for (const node of candidates) {
      const top = node.v - node.height
      const bottom = node.v + node.depth

      if (node.h < minH) minH = node.h
      if (node.h + node.width > maxH) maxH = node.h + node.width
      if (top < minV) minV = top
      if (bottom > maxVBottom) maxVBottom = bottom
    }

    // If height collapsed (all zero-dimension nodes), estimate from baseline
    if (maxVBottom - minV < 2) {
      const defaultLineHeight = 12
      minV = candidates[0]!.v - defaultLineHeight
      maxVBottom = candidates[0]!.v + 3
    }

    const width = Math.max(maxH - minH, 10)
    const height = Math.max(maxVBottom - minV, 10)

    console.log(
      `  bbox: x=${minH.toFixed(1)} y=${minV.toFixed(1)} w=${width.toFixed(1)} h=${height.toFixed(1)}`,
    )

    return {
      page: bestPage,
      x: minH,
      y: minV,
      width,
      height,
    }
  }
}
