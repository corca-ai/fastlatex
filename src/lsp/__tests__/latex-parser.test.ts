import { describe, expect, it } from 'vitest'
import { parseLatexFile } from '../latex-parser'

describe('parseLatexFile', () => {
  // --- Labels ---
  describe('labels', () => {
    it('extracts \\label{...}', () => {
      const result = parseLatexFile('\\label{fig:test}', 'main.tex')
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0]!.name).toBe('fig:test')
      expect(result.labels[0]!.location).toEqual({ file: 'main.tex', line: 1, column: 1 })
    })

    it('extracts multiple labels on different lines', () => {
      const result = parseLatexFile('\\label{a}\n\\label{b}', 'test.tex')
      expect(result.labels).toHaveLength(2)
      expect(result.labels[0]!.name).toBe('a')
      expect(result.labels[1]!.name).toBe('b')
      expect(result.labels[1]!.location.line).toBe(2)
    })

    it('extracts label after other content on same line', () => {
      const result = parseLatexFile('Some text \\label{eq:main} more', 'test.tex')
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0]!.name).toBe('eq:main')
    })
  })

  // --- Label refs ---
  describe('label refs', () => {
    it('extracts \\ref{...}', () => {
      const result = parseLatexFile('See \\ref{fig:test}', 'main.tex')
      expect(result.labelRefs).toHaveLength(1)
      expect(result.labelRefs[0]!.name).toBe('fig:test')
    })

    it('extracts \\eqref{...}', () => {
      const result = parseLatexFile('Equation \\eqref{eq:1}', 'main.tex')
      expect(result.labelRefs).toHaveLength(1)
      expect(result.labelRefs[0]!.name).toBe('eq:1')
    })

    it('extracts \\pageref{...}', () => {
      const result = parseLatexFile('Page \\pageref{ch:intro}', 'main.tex')
      expect(result.labelRefs).toHaveLength(1)
      expect(result.labelRefs[0]!.name).toBe('ch:intro')
    })

    it('extracts \\autoref{...}', () => {
      const result = parseLatexFile('\\autoref{tab:data}', 'main.tex')
      expect(result.labelRefs).toHaveLength(1)
      expect(result.labelRefs[0]!.name).toBe('tab:data')
    })

    it('extracts \\cref{...}', () => {
      const result = parseLatexFile('\\cref{sec:intro}', 'main.tex')
      expect(result.labelRefs).toHaveLength(1)
      expect(result.labelRefs[0]!.name).toBe('sec:intro')
    })

    it('extracts \\nameref{...}', () => {
      const result = parseLatexFile('\\nameref{sec:intro}', 'main.tex')
      expect(result.labelRefs).toHaveLength(1)
      expect(result.labelRefs[0]!.name).toBe('sec:intro')
    })
  })

  // --- Citations ---
  describe('citations', () => {
    it('extracts \\cite{key}', () => {
      const result = parseLatexFile('\\cite{knuth84}', 'main.tex')
      expect(result.citations).toHaveLength(1)
      expect(result.citations[0]!.key).toBe('knuth84')
    })

    it('extracts comma-separated keys', () => {
      const result = parseLatexFile('\\cite{a,b,c}', 'main.tex')
      expect(result.citations).toHaveLength(3)
      expect(result.citations.map((c) => c.key)).toEqual(['a', 'b', 'c'])
    })

    it('handles spaces in comma-separated keys', () => {
      const result = parseLatexFile('\\cite{a, b , c}', 'main.tex')
      expect(result.citations.map((c) => c.key)).toEqual(['a', 'b', 'c'])
    })

    it('extracts \\citep{key}', () => {
      const result = parseLatexFile('\\citep{smith2020}', 'main.tex')
      expect(result.citations).toHaveLength(1)
      expect(result.citations[0]!.key).toBe('smith2020')
    })

    it('extracts \\citet{key}', () => {
      const result = parseLatexFile('\\citet{jones99}', 'main.tex')
      expect(result.citations).toHaveLength(1)
      expect(result.citations[0]!.key).toBe('jones99')
    })

    it('extracts \\parencite{key}', () => {
      const result = parseLatexFile('\\parencite{doe2021}', 'main.tex')
      expect(result.citations).toHaveLength(1)
    })

    it('extracts \\textcite{key}', () => {
      const result = parseLatexFile('\\textcite{doe2021}', 'main.tex')
      expect(result.citations).toHaveLength(1)
    })

    it('handles \\cite with optional argument', () => {
      const result = parseLatexFile('\\cite[p.~42]{knuth84}', 'main.tex')
      expect(result.citations).toHaveLength(1)
      expect(result.citations[0]!.key).toBe('knuth84')
    })
  })

  // --- Sections ---
  describe('sections', () => {
    it('extracts \\section{...}', () => {
      const result = parseLatexFile('\\section{Introduction}', 'main.tex')
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0]!.level).toBe('section')
      expect(result.sections[0]!.title).toBe('Introduction')
    })

    it('extracts all section levels', () => {
      const input = [
        '\\part{Part 1}',
        '\\chapter{Chapter 1}',
        '\\section{Section 1}',
        '\\subsection{Sub 1}',
        '\\subsubsection{Subsub 1}',
        '\\paragraph{Para 1}',
      ].join('\n')
      const result = parseLatexFile(input, 'main.tex')
      expect(result.sections).toHaveLength(6)
      expect(result.sections.map((s) => s.level)).toEqual([
        'part',
        'chapter',
        'section',
        'subsection',
        'subsubsection',
        'paragraph',
      ])
    })

    it('handles starred sections', () => {
      const result = parseLatexFile('\\section*{Unnumbered}', 'main.tex')
      expect(result.sections).toHaveLength(1)
      expect(result.sections[0]!.title).toBe('Unnumbered')
    })
  })

  // --- Commands ---
  describe('commands', () => {
    it('extracts \\newcommand', () => {
      const result = parseLatexFile('\\newcommand{\\foo}{bar}', 'main.tex')
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]!.name).toBe('foo')
    })

    it('extracts \\newcommand with arg count', () => {
      const result = parseLatexFile('\\newcommand{\\foo}[2]{#1 and #2}', 'main.tex')
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]!.name).toBe('foo')
      expect(result.commands[0]!.argCount).toBe(2)
    })

    it('extracts \\renewcommand', () => {
      const result = parseLatexFile('\\renewcommand{\\bar}{baz}', 'main.tex')
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]!.name).toBe('bar')
    })

    it('extracts \\def', () => {
      const result = parseLatexFile('\\def\\mymacro{stuff}', 'main.tex')
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]!.name).toBe('mymacro')
    })

    it('extracts \\DeclareMathOperator', () => {
      const result = parseLatexFile('\\DeclareMathOperator{\\argmax}{arg\\,max}', 'main.tex')
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]!.name).toBe('argmax')
    })

    it('extracts \\DeclareMathOperator*', () => {
      const result = parseLatexFile('\\DeclareMathOperator*{\\argmin}{arg\\,min}', 'main.tex')
      expect(result.commands).toHaveLength(1)
      expect(result.commands[0]!.name).toBe('argmin')
    })
  })

  // --- Environments ---
  describe('environments', () => {
    it('extracts \\begin{env}', () => {
      const result = parseLatexFile('\\begin{equation}', 'main.tex')
      expect(result.environments).toHaveLength(1)
      expect(result.environments[0]!.name).toBe('equation')
    })

    it('extracts multiple environments', () => {
      const input = '\\begin{figure}\n\\begin{center}\n\\end{center}\n\\end{figure}'
      const result = parseLatexFile(input, 'main.tex')
      expect(result.environments).toHaveLength(2)
      expect(result.environments.map((e) => e.name)).toEqual(['figure', 'center'])
    })
  })

  // --- Includes ---
  describe('includes', () => {
    it('extracts \\input{file}', () => {
      const result = parseLatexFile('\\input{chapters/intro}', 'main.tex')
      expect(result.includes).toHaveLength(1)
      expect(result.includes[0]!.path).toBe('chapters/intro')
      expect(result.includes[0]!.type).toBe('input')
    })

    it('extracts \\include{file}', () => {
      const result = parseLatexFile('\\include{appendix}', 'main.tex')
      expect(result.includes).toHaveLength(1)
      expect(result.includes[0]!.path).toBe('appendix')
      expect(result.includes[0]!.type).toBe('include')
    })

    it('extracts \\subfile{file}', () => {
      const result = parseLatexFile('\\subfile{sections/methods}', 'main.tex')
      expect(result.includes).toHaveLength(1)
      expect(result.includes[0]!.type).toBe('subfile')
    })
  })

  // --- Packages ---
  describe('packages', () => {
    it('extracts \\usepackage{name}', () => {
      const result = parseLatexFile('\\usepackage{amsmath}', 'main.tex')
      expect(result.packages).toHaveLength(1)
      expect(result.packages[0]!.name).toBe('amsmath')
      expect(result.packages[0]!.options).toBe('')
    })

    it('extracts \\usepackage with options', () => {
      const result = parseLatexFile('\\usepackage[utf8]{inputenc}', 'main.tex')
      expect(result.packages).toHaveLength(1)
      expect(result.packages[0]!.name).toBe('inputenc')
      expect(result.packages[0]!.options).toBe('utf8')
    })

    it('extracts comma-separated packages', () => {
      const result = parseLatexFile('\\usepackage{amsmath,amssymb,amsthm}', 'main.tex')
      expect(result.packages).toHaveLength(3)
      expect(result.packages.map((p) => p.name)).toEqual(['amsmath', 'amssymb', 'amsthm'])
    })

    it('extracts \\RequirePackage', () => {
      const result = parseLatexFile('\\RequirePackage{etoolbox}', 'main.tex')
      expect(result.packages).toHaveLength(1)
      expect(result.packages[0]!.name).toBe('etoolbox')
    })
  })

  // --- Comments ---
  describe('comment handling', () => {
    it('ignores content after %', () => {
      const result = parseLatexFile('% \\label{commented}', 'main.tex')
      expect(result.labels).toHaveLength(0)
    })

    it('ignores mid-line comment', () => {
      const result = parseLatexFile('text % \\ref{commented}', 'main.tex')
      expect(result.labelRefs).toHaveLength(0)
    })

    it('does not treat escaped percent as comment', () => {
      const result = parseLatexFile('50\\% \\label{valid}', 'main.tex')
      expect(result.labels).toHaveLength(1)
      expect(result.labels[0]!.name).toBe('valid')
    })
  })

  // --- Bib items ---
  describe('bib items', () => {
    it('extracts \\bibitem{key}', () => {
      const result = parseLatexFile('\\bibitem{knuth84} Donald Knuth.', 'refs.tex')
      expect(result.bibItems).toHaveLength(1)
      expect(result.bibItems[0]!.key).toBe('knuth84')
      expect(result.bibItems[0]!.location).toEqual({ file: 'refs.tex', line: 1, column: 1 })
    })

    it('extracts \\bibitem with optional arg', () => {
      const result = parseLatexFile('\\bibitem[Knuth, 1984]{knuth84} The TeXbook.', 'refs.tex')
      expect(result.bibItems).toHaveLength(1)
      expect(result.bibItems[0]!.key).toBe('knuth84')
    })

    it('extracts multiple bibitems', () => {
      const result = parseLatexFile('\\bibitem{a} A.\n\\bibitem{b} B.', 'refs.tex')
      expect(result.bibItems).toHaveLength(2)
      expect(result.bibItems[0]!.key).toBe('a')
      expect(result.bibItems[1]!.key).toBe('b')
    })
  })

  // --- Edge cases ---
  describe('edge cases', () => {
    it('handles empty content', () => {
      const result = parseLatexFile('', 'main.tex')
      expect(result.labels).toHaveLength(0)
      expect(result.sections).toHaveLength(0)
    })

    it('handles unclosed braces gracefully', () => {
      const result = parseLatexFile('\\label{unclosed', 'main.tex')
      expect(result.labels).toHaveLength(0) // can't extract without closing brace
    })

    it('handles complex document', () => {
      const doc = `
\\documentclass{article}
\\usepackage{amsmath,graphicx}
\\newcommand{\\R}{\\mathbb{R}}
\\begin{document}
\\section{Introduction}
\\label{sec:intro}
See \\ref{sec:methods} and \\cite{knuth84,lamport94}.
\\section{Methods}
\\label{sec:methods}
\\begin{equation}
  E = mc^2 \\label{eq:einstein}
\\end{equation}
\\end{document}
`
      const result = parseLatexFile(doc, 'main.tex')
      expect(result.packages.length).toBeGreaterThanOrEqual(2)
      expect(result.commands).toHaveLength(1)
      expect(result.sections).toHaveLength(2)
      expect(result.labels).toHaveLength(3)
      expect(result.labelRefs).toHaveLength(1)
      expect(result.citations).toHaveLength(2)
      expect(result.environments.length).toBeGreaterThanOrEqual(2) // document + equation
    })
  })
})
