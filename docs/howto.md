# Integration Guide

This guide explains how to integrate the `FastLatex` library into your web applications.

## Installation

```bash
# npm
npm install monaco-editor pdfjs-dist
npm install github:corca-ai/fastlatex#main

# bun
bun add monaco-editor pdfjs-dist
bun add github:corca-ai/fastlatex#main
```

**Note:** `monaco-editor` and `pdfjs-dist` are peer dependencies and must be installed separately.

## What's Included

TeX Live packages are served from a **public CDN** — no setup or hosting required. The library fetches packages on demand during compilation and caches them via a Service Worker for offline use.

## Worker Setup (Required)

FastLaTeX depends on **Monaco Editor** and **pdfjs-dist** web workers. Because these are peer dependencies (not bundled into the library), **your bundler** must resolve and bundle the worker files from your own `node_modules`.

Add the following setup code **before** creating a `FastLatex` instance:

```typescript
import * as pdfjsLib from 'pdfjs-dist'

// Monaco workers — required for the code editor
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        { type: 'module' },
      )
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    )
  },
}

// pdfjs worker — required for PDF preview
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()
```

> **Why is this needed?** The `new URL(…, import.meta.url)` pattern must appear in **your** source code so that your bundler (Vite, webpack, etc.) can locate the worker files in `node_modules` and emit them as separate chunks. The library cannot do this on your behalf because the worker URLs would be resolved relative to the pre-built library bundle, not your project.

## Basic Usage

```typescript
import * as pdfjsLib from 'pdfjs-dist'
import { FastLatex } from 'fastlatex'
import 'fastlatex/style.css'

// 1. Worker setup (see section above)
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        { type: 'module' },
      )
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    )
  },
}
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

// 2. Create editor
const editor = new FastLatex('#editor-container', '#preview-container', {
  files: {
    'main.tex': '\\documentclass{article}\\begin{document}Hello world!\\end{document}'
  }
})

await editor.init()
```

`FastLatex` exposes a dedicated stylesheet entrypoint (`fastlatex/style.css`) and does not auto-import it from the JS entry.
Import it if you want the default built-in layout and viewer styles.

## Advanced Features

### BibTeX Support
The editor automatically handles `.bib` and `.bst` files.

```typescript
editor.loadProject({
  'main.tex': `
\documentclass{article}
\begin{document}
As shown in \cite{knuth1984}, TeX is great.
\bibliographystyle{plain}
\bibliography{references}
\end{document}`,
  'references.bib': `
@article{knuth1984,
  author = {Knuth, Donald E.},
  title = {Literate Programming},
  journal = {The Computer Journal},
  year = {1984},
}`
})
```

### Split-container mode (Editor + PDF only)
Build a minimal layout by giving both editor and preview nodes.

```typescript
const editor = new FastLatex('#editor-container', '#preview-container', {
  files: { 'main.tex': '...' }
})

editor.on('compile', ({ result }) => {
  if (result.success && result.pdf) {
    myCustomViewer.display(result.pdf)
  }
})
```

### Using an Existing Monaco Editor

If your application already manages a Monaco editor, pass it via the `editor` option. FastLaTeX will attach its LSP features (autocompletion, hover, go-to-definition, diagnostics) and compilation pipeline to your editor without creating a duplicate instance.

#### Setup

You are responsible for:
1. **Worker configuration** — set up Monaco and pdfjs workers as described in [Worker Setup](#worker-setup-required).
2. **Editor creation and disposal** — FastLaTeX will **not** dispose your editor when `latex.dispose()` is called.

FastLaTeX handles:
- Registering `latex` and `bibtex` languages (via `ensureLanguagesRegistered`)
- Switching the editor's model when the active file changes
- All LSP providers and compilation

#### Example

```typescript
import * as monaco from 'monaco-editor'
import * as pdfjsLib from 'pdfjs-dist'
import { FastLatex, ensureLanguagesRegistered } from 'fastlatex'
import 'fastlatex/style.css'

// 1. Configure workers (see Worker Setup section)
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') {
      return new Worker(
        new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
        { type: 'module' },
      )
    }
    return new Worker(
      new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
      { type: 'module' },
    )
  },
}
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString()

// 2. Register LaTeX/BibTeX languages before creating the editor
//    so that syntax highlighting is available from the start.
ensureLanguagesRegistered()

// 3. Create your own Monaco editor
const source = '\\documentclass{article}\n\\begin{document}\nHello!\n\\end{document}'

const myEditor = monaco.editor.create(document.getElementById('editor')!, {
  language: 'latex',
  value: source,
  automaticLayout: true,
})

// 4. Pass it to FastLaTeX
const latex = new FastLatex('#editor', '#preview', {
  editor: myEditor,
  files: { 'main.tex': source },
})

await latex.init()
```

#### Disposal

```typescript
// FastLaTeX cleans up its own resources (engines, LSP, models)
// but leaves your editor instance alive.
latex.dispose()

// myEditor is still usable — dispose it on your own terms.
myEditor.dispose()
```

### Intelligent Rename (F2)
Press **F2** on a symbol to rename it across the project. Supports Labels, Citations, and custom Commands.

## References

- **[Full API Reference](api.md)**: Detailed list of methods and events.
- **[Engine Configuration](engine.md)**: How to configure WASM assets and CDN.
