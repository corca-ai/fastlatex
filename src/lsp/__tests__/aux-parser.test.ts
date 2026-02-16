import { describe, expect, it } from 'vitest'
import { parseAuxFile } from '../aux-parser'

describe('parseAuxFile', () => {
  it('parses \\newlabel entries', () => {
    const aux = `\\relax
\\newlabel{sec:intro}{{1}{1}}
\\newlabel{eq:main}{{2.1}{3}}
\\newlabel{fig:arch}{{1}{5}}
`
    const result = parseAuxFile(aux)
    expect(result.labels.size).toBe(3)
    expect(result.labels.get('sec:intro')).toBe('1')
    expect(result.labels.get('eq:main')).toBe('2.1')
    expect(result.labels.get('fig:arch')).toBe('1')
  })

  it('parses \\bibcite entries', () => {
    const aux = `\\bibcite{knuth84}{1}
\\bibcite{lamport94}{2}
`
    const result = parseAuxFile(aux)
    expect(result.citations.size).toBe(2)
    expect(result.citations.has('knuth84')).toBe(true)
    expect(result.citations.has('lamport94')).toBe(true)
  })

  it('handles mixed content', () => {
    const aux = `\\relax
\\providecommand\\hyper@newdestlabel[2]{}
\\newlabel{sec:intro}{{1}{1}{Introduction}{}{}}
\\newlabel{eq:euler}{{1}{2}{}{}{}}
\\bibcite{euler1748}{1}
\\@writefile{toc}{\\contentsline{section}{\\numberline{1}Introduction}{1}}
`
    const result = parseAuxFile(aux)
    expect(result.labels.size).toBe(2)
    expect(result.labels.get('sec:intro')).toBe('1')
    expect(result.labels.get('eq:euler')).toBe('1')
    expect(result.citations.size).toBe(1)
    expect(result.citations.has('euler1748')).toBe(true)
  })

  it('handles empty .aux file', () => {
    const result = parseAuxFile('\\relax\n')
    expect(result.labels.size).toBe(0)
    expect(result.citations.size).toBe(0)
  })

  it('handles hyperref extended format', () => {
    const aux = `\\newlabel{thm:main}{{3.2}{7}{Main Theorem}{theorem.3.2}{}}
`
    const result = parseAuxFile(aux)
    expect(result.labels.size).toBe(1)
    expect(result.labels.get('thm:main')).toBe('3.2')
  })

  it('parses \\@input entries', () => {
    const aux = `\\relax
\\@input{chapter1.aux}
\\@input{chapter2.aux}
`
    const result = parseAuxFile(aux)
    expect(result.includes).toEqual(['chapter1.aux', 'chapter2.aux'])
  })

  it('parses mixed content with \\@input + \\newlabel + \\bibcite', () => {
    const aux = `\\relax
\\newlabel{sec:intro}{{1}{1}}
\\@input{ch1.aux}
\\bibcite{knuth84}{1}
\\@input{ch2.aux}
`
    const result = parseAuxFile(aux)
    expect(result.labels.size).toBe(1)
    expect(result.citations.size).toBe(1)
    expect(result.includes).toEqual(['ch1.aux', 'ch2.aux'])
  })

  it('returns empty includes when no \\@input', () => {
    const aux = `\\relax
\\newlabel{sec:intro}{{1}{1}}
`
    const result = parseAuxFile(aux)
    expect(result.includes).toEqual([])
  })
})
