# Integration Guide

This guide explains how to integrate the `LatexEditor` library into your web applications.

## Installation

```bash
npm install monaco-editor pdfjs-dist
# Then install the editor
npm install github:akcorca/latex-editor#main
```

**Note:** `monaco-editor` and `pdfjs-dist` are peer dependencies.

## Basic Usage

```typescript
import { LatexEditor } from 'latex-editor'

const editor = new LatexEditor('#editor-container', '#preview-container', {
  files: {
    'main.tex': '\\documentclass{article}\\begin{document}Hello world!\\end{document}'
  }
})

await editor.init()
```

`LatexEditor` bundles the base viewer/editor styles by default; import `latex-editor/style.css` only if you need to host styles separately.

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
const editor = new LatexEditor('#editor-container', '#preview-container', {
  files: { 'main.tex': '...' }
})

editor.on('compile', ({ result }) => {
  if (result.success && result.pdf) {
    myCustomViewer.display(result.pdf)
  }
})
```

### Intelligent Rename (F2)
Press **F2** on a symbol to rename it across the project. Supports Labels, Citations, and custom Commands.

## References

- **[Full API Reference](api.md)**: Detailed list of methods and events.
- **[Engine Configuration](engine.md)**: How to configure WASM assets and CDN.
