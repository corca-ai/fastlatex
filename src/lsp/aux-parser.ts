import type { AuxData } from './types'

const NEWLABEL_RE = /\\newlabel\{(.+?)\}\{\{(.+?)\}\{(.+?)\}/g
const BIBCITE_RE = /\\bibcite\{(.+?)\}\{(.+?)\}/g
const INPUT_RE = /\\@input\{(.+?)\}/g

export function parseAuxFile(content: string): AuxData {
  const labels = new Map<string, string>()
  const citations = new Set<string>()
  const includes: string[] = []

  for (const m of content.matchAll(NEWLABEL_RE)) {
    const name = m[1]!
    const displayNum = m[2]!
    labels.set(name, displayNum)
  }

  for (const m of content.matchAll(BIBCITE_RE)) {
    citations.add(m[1]!)
  }

  for (const m of content.matchAll(INPUT_RE)) {
    includes.push(m[1]!)
  }

  return { labels, citations, includes }
}
