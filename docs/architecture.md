# Architecture

`LatexEditor` is designed as a **headless-first SDK**. The core logic is decoupled from the UI, allowing it to run as a full IDE or a background compilation service.

## High-Level Overview

```
[ Host Application ]
      ↓
[ LatexEditor SDK ] (src/latex-editor.ts)
      ├── [ VirtualFS ] (src/fs/virtual-fs.ts) - In-memory file management
      ├── [ LSP Engine ] (src/lsp/) - Completion, Hover, Diagnostics, Rename
      ├── [ Worker Orchestrator ] (src/engine/)
      │     ├── pdfTeX Worker (WASM) - Core compilation + CDN fetching
      │     └── BibTeX Worker (WASM) - Bibliography generation
      └── [ UI Components ] (src/ui/, src/viewer/) - Optional (hidden in headless mode)
```

- **SDK Core**: Managed by `LatexEditor` class. Orchestrates VFS, LSP, and Engines.
- **Workers**: WASM engines run in Web Workers to keep the main thread responsive.
- **Communication**: Asynchronous via `postMessage`. A request-response protocol is implemented using unique message IDs.
- **SyncTeX**: A binary parser (`src/synctex/`) processes `.synctex` files for bidirectional PDF ↔ Source navigation.

## Project Structure

```
src/
├── engine/           # WASM engine wrappers, compile scheduler, error parsing
├── editor/           # Monaco editor setup & LaTeX/BibTeX language definitions
├── viewer/           # PDF.js based viewer and SyncTeX highlighting
├── synctex/          # SyncTeX binary parser & text-mapper fallback
├── lsp/              # Language Service Providers (Rename, Refs, Hover, etc.)
├── fs/               # Virtual filesystem (VirtualFS)
├── ui/               # IDE UI components (FileTree, Outline, ErrorLog)
├── perf/             # Performance tracking & debug overlay
├── index.ts          # SDK Entry point (barrel export)
├── latex-editor.ts   # SDK Main class (orchestrator)
└── main.ts           # Standalone IDE entry point (index.html)

wasm-build/           # C/C++ source and Docker pipeline for pdfTeX WASM
scripts/              # Build and setup scripts
e2e/                  # Playwright integration tests
```

## Tech Stack

- **Frontend**: Vanilla TypeScript + Vite (No framework).
- **Editor**: Monaco Editor with custom LSP implementation.
- **Engine**: pdfTeX 1.40.22 and BibTeX (WASM).
- **Viewer**: PDF.js.
- **Build/Lint**: Vite, Biome.
- **Testing**: Vitest, Playwright.

## LSP Implementation Details

### Project Index
`ProjectIndex` maintains a global state of symbols (labels, citations, commands) across all files in the `VirtualFS`. It is updated on every keystroke (debounced).

### Rename (F2)
Rename functionality uses `ProjectIndex.findAllOccurrences()` to find symbols in both `.tex` and `.bib` files. It handles:
- `\label` ↔ `ef`
- `@article{key}` in `.bib` ↔ `\cite{key}` in `.tex`
- `
ewcommand{\cmd}` ↔ `\cmd` usages

### Diagnostics
Diagnostics are computed by `DiagnosticProvider` by cross-referencing the `ProjectIndex`. For example, it flags `ef{key}` if `key` does not exist in any loaded file.
