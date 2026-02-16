import { describe, expect, it } from 'vitest'
import { ProjectIndex } from '../project-index'

describe('ProjectIndex', () => {
  it('indexes a file and retrieves labels', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{sec:intro}\n\\label{eq:1}')
    expect(index.getAllLabels()).toHaveLength(2)
    expect(index.getAllLabels().map((l) => l.name)).toEqual(['sec:intro', 'eq:1'])
  })

  it('retrieves file symbols', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\section{Hello}\n\\label{sec:hello}')
    const symbols = index.getFileSymbols('main.tex')
    expect(symbols).toBeDefined()
    expect(symbols!.sections).toHaveLength(1)
    expect(symbols!.labels).toHaveLength(1)
  })

  it('returns undefined for unknown file', () => {
    const index = new ProjectIndex()
    expect(index.getFileSymbols('nope.tex')).toBeUndefined()
  })

  it('removes a file', () => {
    const index = new ProjectIndex()
    index.updateFile('a.tex', '\\label{a}')
    index.removeFile('a.tex')
    expect(index.getAllLabels()).toHaveLength(0)
    expect(index.getFileSymbols('a.tex')).toBeUndefined()
  })

  it('updates a file (re-parse)', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\label{old}')
    expect(index.getAllLabels()[0]!.name).toBe('old')

    index.updateFile('main.tex', '\\label{new}')
    expect(index.getAllLabels()).toHaveLength(1)
    expect(index.getAllLabels()[0]!.name).toBe('new')
  })

  it('aggregates labels across files', () => {
    const index = new ProjectIndex()
    index.updateFile('a.tex', '\\label{a}')
    index.updateFile('b.tex', '\\label{b}')
    expect(index.getAllLabels()).toHaveLength(2)
  })

  it('finds label refs for a given name', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\ref{foo}\n\\ref{bar}\n\\ref{foo}')
    const refs = index.getAllLabelRefs('foo')
    expect(refs).toHaveLength(2)
  })

  it('aggregates citations', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\cite{a,b}\n\\cite{c}')
    expect(index.getAllCitations()).toHaveLength(3)
  })

  it('aggregates sections', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\section{Intro}\n\\subsection{Detail}')
    expect(index.getAllSections()).toHaveLength(2)
  })

  it('aggregates command defs', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\newcommand{\\foo}{bar}')
    index.updateFile('macros.tex', '\\def\\baz{qux}')
    expect(index.getCommandDefs()).toHaveLength(2)
  })

  it('gets all unique environment names', () => {
    const index = new ProjectIndex()
    index.updateFile('main.tex', '\\begin{equation}\n\\end{equation}\n\\begin{equation}')
    expect(index.getAllEnvironments()).toEqual(['equation'])
  })

  // --- .aux integration ---
  it('updates aux data and resolves labels', () => {
    const index = new ProjectIndex()
    index.updateAux('\\newlabel{sec:intro}{{1}{1}}\n\\newlabel{eq:1}{{2.3}{5}}')
    expect(index.resolveLabel('sec:intro')).toBe('1')
    expect(index.resolveLabel('eq:1')).toBe('2.3')
    expect(index.resolveLabel('unknown')).toBeUndefined()
  })

  it('gets aux citations', () => {
    const index = new ProjectIndex()
    index.updateAux('\\bibcite{knuth84}{1}\n\\bibcite{lamport94}{2}')
    expect(index.getAuxCitations().size).toBe(2)
  })

  // --- find helpers ---
  it('findLabelDef returns the definition', () => {
    const index = new ProjectIndex()
    index.updateFile('ch1.tex', '\\label{sec:one}')
    const def = index.findLabelDef('sec:one')
    expect(def).toBeDefined()
    expect(def!.location.file).toBe('ch1.tex')
  })

  it('findLabelDef returns undefined for missing label', () => {
    const index = new ProjectIndex()
    expect(index.findLabelDef('nope')).toBeUndefined()
  })

  it('findCommandDef returns the definition', () => {
    const index = new ProjectIndex()
    index.updateFile('defs.tex', '\\newcommand{\\hello}[1]{Hi #1}')
    const def = index.findCommandDef('hello')
    expect(def).toBeDefined()
    expect(def!.location.file).toBe('defs.tex')
    expect(def!.argCount).toBe(1)
  })

  it('findBibitemDef returns the definition', () => {
    const index = new ProjectIndex()
    index.updateFile('refs.tex', '\\bibitem{knuth84} The TeXbook.')
    const def = index.findBibitemDef('knuth84')
    expect(def).toBeDefined()
    expect(def!.location.file).toBe('refs.tex')
  })

  it('findBibitemDef returns undefined for missing key', () => {
    const index = new ProjectIndex()
    expect(index.findBibitemDef('nope')).toBeUndefined()
  })

  it('bib entries can be set and retrieved', () => {
    const index = new ProjectIndex()
    index.updateBib([{ key: 'knuth84', type: 'book', title: 'TeXbook', author: 'Knuth' }])
    expect(index.getBibEntries()).toHaveLength(1)
    expect(index.getBibEntries()[0]!.key).toBe('knuth84')
  })

  // --- Engine commands (Phase 2: tab-separated, env detection, categorization) ---

  it('parses bare names (backward compat with old WASM)', () => {
    const index = new ProjectIndex()
    index.updateEngineCommands(['align', 'gather', 'hbox'])
    const cmds = index.getEngineCommands()
    expect(cmds.size).toBe(3)
    expect(cmds.get('align')!.eqType).toBe(-1)
    expect(cmds.get('align')!.category).toBe('unknown')
  })

  it('parses tab-separated name\\teqType format', () => {
    const index = new ProjectIndex()
    index.updateEngineCommands(['align\t113', 'hbox\t21'])
    expect(index.getEngineCommands().get('align')!.eqType).toBe(113)
    expect(index.getEngineCommands().get('align')!.category).toBe('macro')
    expect(index.getEngineCommands().get('hbox')!.eqType).toBe(21)
    expect(index.getEngineCommands().get('hbox')!.category).toBe('primitive')
  })

  it('detects environments from endXXX pattern', () => {
    const index = new ProjectIndex()
    index.updateEngineCommands(['align', 'endalign', 'gather', 'endgather', 'endcsname'])
    const envs = index.getEngineEnvironments()
    expect(envs.has('align')).toBe(true)
    expect(envs.has('gather')).toBe(true)
    // csname is blocklisted
    expect(envs.has('csname')).toBe(false)
  })

  it('does not detect env if base name is missing', () => {
    const index = new ProjectIndex()
    index.updateEngineCommands(['endalign'])
    expect(index.getEngineEnvironments().has('align')).toBe(false)
  })

  it('filters LaTeX3 internal names containing _ or :', () => {
    const index = new ProjectIndex()
    index.updateEngineCommands([
      'intertext\t113',
      '__fp_sqrt:w\t114',
      'prop_if_in:NnTF\t114',
      'hbox\t21',
      'token_if_space:NTF\t114',
    ])
    const cmds = index.getEngineCommands()
    expect(cmds.has('intertext')).toBe(true)
    expect(cmds.has('hbox')).toBe(true)
    expect(cmds.has('__fp_sqrt:w')).toBe(false)
    expect(cmds.has('prop_if_in:NnTF')).toBe(false)
    expect(cmds.has('token_if_space:NTF')).toBe(false)
    expect(cmds.size).toBe(2)
  })

  it('parses package info from log', () => {
    const index = new ProjectIndex()
    index.updateLogData(
      'Package: amsmath 2020/09/23 v2.17i AMS math features\n' +
        'Package: graphicx 2019/11/30 v1.2a Enhanced LaTeX Graphics\n',
    )
    expect(index.getLoadedPackages().get('amsmath')).toBe('v2.17i')
    expect(index.getLoadedPackages().get('graphicx')).toBe('v1.2a')
  })

  it('handles log with no package lines', () => {
    const index = new ProjectIndex()
    index.updateLogData('This is pdfTeX, Version 3.14159265\nNo packages here.')
    expect(index.getLoadedPackages().size).toBe(0)
  })
})
