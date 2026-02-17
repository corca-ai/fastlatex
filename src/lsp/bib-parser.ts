import type { BibEntry } from './types'

export function parseBibFile(content: string): BibEntry[] {
  const entries: BibEntry[] = []
  const entryRegex = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g

  for (let match = entryRegex.exec(content); match !== null; match = entryRegex.exec(content)) {
    const type = match[1]!.toLowerCase()
    const key = match[2]!.trim()

    // Skip non-entry types
    if (type === 'string' || type === 'preamble' || type === 'comment') continue

    // Extract fields from the entry body
    const startIdx = match.index + match[0].length
    const fields = extractFields(content, startIdx)

    const entry: BibEntry = { key, type }
    const title = fields.get('title')
    const author = fields.get('author')
    if (title) entry.title = title
    if (author) entry.author = author
    entries.push(entry)
  }

  return entries
}

function extractFields(content: string, startIdx: number): Map<string, string> {
  const fields = new Map<string, string>()

  // Find the matching closing brace (track nesting depth)
  let depth = 1
  let idx = startIdx
  while (idx < content.length && depth > 0) {
    const ch = content[idx]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    idx++
  }

  const body = content.slice(startIdx, idx - 1)
  const fieldRegex = /(\w+)\s*=\s*(?:\{([^}]*)\}|"([^"]*)"|(\d+))/g

  for (
    let fieldMatch = fieldRegex.exec(body);
    fieldMatch !== null;
    fieldMatch = fieldRegex.exec(body)
  ) {
    const fieldName = fieldMatch[1]!.toLowerCase()
    const value = fieldMatch[2] ?? fieldMatch[3] ?? fieldMatch[4] ?? ''
    fields.set(fieldName, value)
  }

  return fields
}
