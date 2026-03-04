import { describe, expect, it } from 'vitest'
import { createDefinitionProvider } from '../definition-provider'
import { ProjectIndex } from '../project-index'
import { type MockModel, mockModel } from './test-helpers'

describe('createDefinitionProvider', () => {
  const index = new ProjectIndex()
  const provider = createDefinitionProvider(index)

  // biome-ignore lint/suspicious/noExplicitAny: Monaco types too complex to fully mock
  function define(model: MockModel, line: number, col: number): any {
    return provider.provideDefinition(
      model as any,
      { lineNumber: line, column: col } as any,
      undefined as any,
    )
  }

  it('provides definition for \\input with .tex extension', () => {
    index.updateFile('sub.tex', 'content')
    const model = mockModel(['\\input{sub.tex}'])
    const result = define(model, 1, 8)
    expect(result).toBeDefined()
    expect(result.uri.path).toBe('/sub.tex')
  })

  it('provides definition for \\input without .tex extension', () => {
    index.updateFile('sub.tex', 'content')
    const model = mockModel(['\\input{sub}'])
    const result = define(model, 1, 8)
    expect(result).toBeDefined()
    expect(result.uri.path).toBe('/sub.tex')
  })

  it('resolves relative paths for \\input', () => {
    index.updateFile('chapters/intro.tex', 'content')
    const model = mockModel(['\\input{intro.tex}'], 'chapters/main.tex')
    const result = define(model, 1, 8)
    expect(result).toBeDefined()
    expect(result.uri.path).toBe('/chapters/intro.tex')
  })

  it('provides definition when cursor is on the command itself', () => {
    index.updateFile('sub.tex', 'content')
    const model = mockModel(['\\input{sub.tex}'])
    const result = define(model, 1, 3)
    expect(result).toBeDefined()
    expect(result.uri.path).toBe('/sub.tex')
  })

  it('returns fallback if file not in index', () => {
    const model = mockModel(['\\input{missing.tex}'])
    const result = define(model, 1, 8)
    expect(result).toBeDefined()
    expect(result.uri.path).toBe('/missing.tex')
  })
})
