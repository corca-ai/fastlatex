import { describe, expect, it } from 'vitest'
import { ProjectIndex } from '../project-index'
import { createReferenceProvider } from '../reference-provider'
import { type MockModel, mockModel } from './test-helpers'

describe('createReferenceProvider', () => {
  // biome-ignore lint/suspicious/noExplicitAny: Monaco types too complex to fully mock
  function refs(provider: any, model: MockModel, line: number, col: number): any[] {
    return provider.provideReferences(model as any, { lineNumber: line, column: col } as any)
  }

  it('finds all refs for a \\label definition', () => {
    const index = new ProjectIndex()
    const provider = createReferenceProvider(index)

    index.updateFile('main.tex', '\\label{fig:a}\n\\ref{fig:a}')
    index.updateFile('other.tex', '\\ref{fig:a}')

    const model = mockModel(['\\label{fig:a}', '\\ref{fig:a}'])
    const result = refs(provider, model, 1, 9)

    // \label{fig:a} -> finds all \ref{fig:a} usages
    expect(result.length).toBe(2)
  })

  it('finds definition + all refs for a \\ref command', () => {
    const index = new ProjectIndex()
    const provider = createReferenceProvider(index)

    index.updateFile('main.tex', '\\label{sec:1}\n\\ref{sec:1}')
    index.updateFile('other.tex', '\\ref{sec:1}')

    const model = mockModel(['\\label{sec:1}', '\\ref{sec:1}'])
    const result = refs(provider, model, 2, 7)

    // \ref{sec:1} -> label def + all refs
    expect(result.length).toBe(3)
  })

  it('returns empty for plain text', () => {
    const index = new ProjectIndex()
    const provider = createReferenceProvider(index)

    index.updateFile('main.tex', 'Hello world')

    const model = mockModel(['Hello world'])
    const result = refs(provider, model, 1, 3)

    expect(result).toEqual([])
  })

  it('returns empty for \\newcommand definition', () => {
    const index = new ProjectIndex()
    const provider = createReferenceProvider(index)

    index.updateFile('main.tex', '\\newcommand{\\myfunc}{body}')

    const model = mockModel(['\\newcommand{\\myfunc}{body}'])
    const result = refs(provider, model, 1, 15)

    expect(result).toEqual([])
  })

  it('handles \\eqref as a ref command', () => {
    const index = new ProjectIndex()
    const provider = createReferenceProvider(index)

    index.updateFile('main.tex', '\\label{eq:1}\n\\eqref{eq:1}')

    const model = mockModel(['\\label{eq:1}', '\\eqref{eq:1}'])
    const result = refs(provider, model, 2, 10)

    // eqref -> label def + this eqref ref
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('returns refs from multiple files', () => {
    const index = new ProjectIndex()
    const provider = createReferenceProvider(index)

    index.updateFile('a.tex', '\\label{tbl:1}')
    index.updateFile('b.tex', '\\ref{tbl:1}')
    index.updateFile('c.tex', '\\ref{tbl:1}')

    const model = mockModel(['\\label{tbl:1}'], 'a.tex')
    const result = refs(provider, model, 1, 9)

    expect(result.length).toBe(2)
    // biome-ignore lint/suspicious/noExplicitAny: test helper
    const files = result.map((r: any) => r.uri.path)
    expect(files).toContain('/b.tex')
    expect(files).toContain('/c.tex')
  })
})
