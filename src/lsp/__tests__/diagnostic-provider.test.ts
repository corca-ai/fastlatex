import { describe, expect, it } from 'vitest'
import { computeDiagnostics } from '../diagnostic-provider'
import { ProjectIndex } from '../project-index'

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
    expect(diags).toHaveLength(1)
    expect(diags[0]!.code).toBe('duplicate-label')
    expect(diags[0]!.message).toContain('dup')
    expect(diags[0]!.file).toBe('b.tex')
  })

  it('detects multiple issues together', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\ref{missing}\n\\cite{noexist}\n\\label{a}\n\\label{a}')
    const diags = computeDiagnostics(index)
    const codes = diags.map((d) => d.code).sort()
    expect(codes).toEqual(['duplicate-label', 'undefined-cite', 'undefined-ref'])
  })
})
