export interface SemanticTrace {
  labels: Set<string> // engine-processed \label keys
  refs: Set<string> // engine-processed \ref keys
}

export function parseTraceFile(content: string): SemanticTrace {
  const labels = new Set<string>()
  const refs = new Set<string>()
  for (const line of content.split('\n')) {
    if (line.startsWith('L:')) labels.add(line.slice(2))
    else if (line.startsWith('R:')) refs.add(line.slice(2))
  }
  return { labels, refs }
}
