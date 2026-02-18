# Developer Guide: Integrating LaTeX Editor

This guide explains how to integrate the `LatexEditor` library into your web applications, including advanced features like BibTeX support and headless mode.

## Installation

Install the library and its peer dependencies:

```bash
npm install monaco-editor pdfjs-dist
# Then install the editor (if published or via local path)
npm install @google/latex-editor 
```

**Important:** `monaco-editor` and `pdfjs-dist` are marked as peer dependencies to keep the bundle size small and avoid version conflicts in your host application.

## Basic Integration

The simplest way to use the editor is to provide a container element and initial files.

```typescript
import { LatexEditor } from 'latex-editor'
import 'latex-editor/style.css'

const container = document.getElementById('editor-container')!
const editor = new LatexEditor(container, {
  files: {
    'main.tex': '\documentclass{article}\begin{document}Hello world!\end{document}'
  }
})

await editor.init()
```

## Advanced Features

### BibTeX Support
The editor automatically handles `.bib` and `.bst` files. If you include a `.bib` file in your project and use `\cite{...}` in your LaTeX source, the editor will:
1. Compile the LaTeX source to generate the `.aux` file.
2. Run the BibTeX engine to generate the `.bbl` file.
3. Re-compile the LaTeX source to include the bibliography.

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

### Headless Mode (Custom UI)
By default, `LatexEditor` renders a full IDE-like interface (sidebar, editor, PDF viewer, logs). If you want to build your own UI, use the `headless: true` option. This will only render the Monaco editor inside your container.

```typescript
const editor = new LatexEditor(container, {
  headless: true,
  files: { 'main.tex': '...' }
})

// Listen for compilation results to update your own PDF viewer
editor.on('compile', ({ result }) => {
  if (result.success && result.pdf) {
    // result.pdf is a Uint8Array
    myCustomViewer.display(result.pdf)
  }
})

// Listen for diagnostics to show in your own error panel
editor.on('diagnostics', ({ diagnostics }) => {
  myErrorPanel.update(diagnostics)
})
```

## API Reference

### Methods

- `init(): Promise<void>`: Initializes the WASM engines and runs the first compilation.
- `loadProject(files: Record<string, string | Uint8Array>): void`: Replaces the entire project with new files.
- `setFile(path: string, content: string | Uint8Array): void`: Adds or updates a single file.
- `deleteFile(path: string): boolean`: Deletes a file from the virtual filesystem.
- `listFiles(): string[]`: Returns a list of all files in the project.
- `compile(): void`: Triggers an immediate compilation (bypassing the auto-compile debounce).
- `getPdf(): Uint8Array | null`: Returns the last successfully generated PDF.
- `revealLine(line: number, file?: string): void`: Navigates the editor to a specific line/file.
- `flushCache(): Promise<void>`: Clears the internal engine cache (useful when switching between unrelated projects).
- `dispose(): void`: Cleans up the editor, workers, and DOM.

### Events

Use `editor.on(eventName, handler)` to listen for changes:

- `compile`: Fired when a compilation cycle completes.
- `status`: Fired when the editor status changes (e.g., `'compiling'`, `'ready'`, `'error'`).
- `filechange`: Fired when the content of a file is modified.
- `filesUpdate`: Fired when files are added or deleted.
- `cursorChange`: Fired when the user moves the cursor in the editor.
- `diagnostics`: Fired when new LaTeX errors or warnings are detected.
- `outlineUpdate`: Fired when the document structure (sections/subsections) changes.

## Performance Tips

- **Asset Base URL**: If you are hosting the WASM files and workers on a different path or CDN, specify `assetBaseUrl` in the options.
- **Service Worker**: The editor uses a service worker to cache TeX packages fetched from the CDN. Ensure your hosting environment allows service workers if you want offline support and faster subsequent loads.
- **Flush Cache**: When switching between completely different projects in the same session, call `editor.flushCache()` to ensure no stale files (like `.aux` or `.log`) from the previous project interfere with the new one.
