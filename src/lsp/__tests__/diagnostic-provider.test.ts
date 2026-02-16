import { describe, expect, it } from 'vitest'
import { computeDiagnostics } from '../diagnostic-provider'
import { ProjectIndex } from '../project-index'
import { parseTraceFile } from '../trace-parser'

describe('computeDiagnostics', () => {
  it('returns empty for clean project', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\section{Hello}')
    expect(computeDiagnostics(index)).toEqual([])
  })

  it('detects undefined ref', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', 'See \\ref{missing}')
    const diags = computeDiagnostics(index)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.code).toBe('undefined-ref')
    expect(diags[0]!.message).toContain('missing')
    expect(diags[0]!.severity).toBe('warning')
  })

  it('does not flag ref when label exists', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{sec:one}\n\\ref{sec:one}')
    expect(computeDiagnostics(index)).toEqual([])
  })

  it('does not flag ref resolved via aux', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\ref{sec:aux}')
    index.updateAux('\\newlabel{sec:aux}{{1}{1}}')
    expect(computeDiagnostics(index)).toEqual([])
  })

  it('detects undefined citation', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\cite{noexist}')
    const diags = computeDiagnostics(index)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.code).toBe('undefined-cite')
    expect(diags[0]!.message).toContain('noexist')
  })

  it('does not flag cite resolved via aux', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\cite{knuth84}')
    index.updateAux('\\bibcite{knuth84}{1}')
    expect(computeDiagnostics(index)).toEqual([])
  })

  it('does not flag cite resolved via bibitem', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\cite{knuth84}')
    index.updateFile('refs.tex', '\\bibitem{knuth84} TeXbook.')
    expect(computeDiagnostics(index)).toEqual([])
  })

  it('does not flag cite resolved via bib entries', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\cite{knuth84}')
    index.updateBib([{ key: 'knuth84', type: 'book' }])
    expect(computeDiagnostics(index)).toEqual([])
  })

  it('detects duplicate labels', () => {
    const index = new ProjectIndex()
    index.updateFile('a.tex', '\\label{dup}')
    index.updateFile('b.tex', '\\label{dup}')
    const diags = computeDiagnostics(index)
    const dupDiags = diags.filter((d) => d.code === 'duplicate-label')
    expect(dupDiags).toHaveLength(1)
    expect(dupDiags[0]!.message).toContain('dup')
    expect(dupDiags[0]!.file).toBe('b.tex')
  })

  it('detects multiple issues together', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\ref{missing}\n\\cite{noexist}\n\\label{a}\n\\label{a}')
    const diags = computeDiagnostics(index)
    const codes = new Set(diags.map((d) => d.code))
    expect(codes).toContain('duplicate-label')
    expect(codes).toContain('undefined-cite')
    expect(codes).toContain('undefined-ref')
    expect(codes).toContain('unreferenced-label')
  })

  // --- Unreferenced labels ---

  it('detects unreferenced label', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{unused}')
    const diags = computeDiagnostics(index)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.code).toBe('unreferenced-label')
    expect(diags[0]!.severity).toBe('info')
    expect(diags[0]!.message).toContain('unused')
  })

  it('does not flag label that has a ref', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{used}\n\\ref{used}')
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'unreferenced-label')).toHaveLength(0)
  })

  it('detects unreferenced label across files', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{sec:intro}')
    index.updateFile('ch1.tex', '\\ref{sec:intro}')
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'unreferenced-label')).toHaveLength(0)
  })

  // --- Missing includes ---

  it('detects missing include file', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\input{missing}')
    const diags = computeDiagnostics(index)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.code).toBe('missing-include')
    expect(diags[0]!.severity).toBe('warning')
    expect(diags[0]!.message).toContain('missing.tex')
  })

  it('does not flag include when file is indexed', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\input{chapter1}')
    index.updateFile('chapter1.tex', '\\section{Chapter 1}')
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'missing-include')).toHaveLength(0)
  })

  it('handles include with .tex extension', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\input{chapter1.tex}')
    index.updateFile('chapter1.tex', '\\section{Chapter 1}')
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'missing-include')).toHaveLength(0)
  })

  // --- Semantic trace integration ---

  it('suppresses undefined-ref when trace has the label', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\ref{macro-label}')
    // No static \label{macro-label} anywhere → normally would be undefined-ref
    index.updateSemanticTrace(parseTraceFile('L:macro-label'))
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'undefined-ref')).toHaveLength(0)
  })

  it('suppresses unreferenced-label when trace has the ref', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{lonely}')
    // No static \ref{lonely} → normally would be unreferenced-label
    index.updateSemanticTrace(parseTraceFile('R:lonely'))
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'unreferenced-label')).toHaveLength(0)
  })

  it('generates engine-only-label info diagnostic', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\section{Hello}')
    // Trace has a label not in static parse or aux
    index.updateSemanticTrace(parseTraceFile('L:generated-key'))
    const diags = computeDiagnostics(index)
    const eol = diags.filter((d) => d.code === 'engine-only-label')
    expect(eol).toHaveLength(1)
    expect(eol[0]!.severity).toBe('info')
    expect(eol[0]!.message).toContain('generated-key')
    expect(eol[0]!.message).toContain('macro expansion')
  })

  it('suppresses engine-only-label when label is referenced', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\ref{gen-key}')
    index.updateSemanticTrace(parseTraceFile('L:gen-key'))
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'engine-only-label')).toHaveLength(0)
  })

  it('does not generate engine-only-label for statically known labels', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{known}')
    index.updateSemanticTrace(parseTraceFile('L:known'))
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'engine-only-label')).toHaveLength(0)
  })

  it('does not generate engine-only-label for aux labels', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\section{Hi}')
    index.updateAux('\\newlabel{aux-label}{{1}{1}}')
    index.updateSemanticTrace(parseTraceFile('L:aux-label'))
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'engine-only-label')).toHaveLength(0)
  })

  it('no trace → no engine-only-label diagnostics', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{normal}')
    const diags = computeDiagnostics(index)
    expect(diags.filter((d) => d.code === 'engine-only-label')).toHaveLength(0)
  })
})
