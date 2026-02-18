# Development Guide

This guide is for developers contributing to the `latex-editor` codebase. If you just want to use the library, see [docs/howto.md](howto.md).

## Quick Start

```bash
npm run download-engine   # Download WASM engine (first time only)
npm run dev               # Start dev server
# App: http://localhost:5173
```

TeX packages are fetched on demand from a CloudFront CDN. In development, requests to `/texlive/` are proxied to the CDN (configured via `.env`).

## Prerequisites

- **Node.js**: v24+ recommended.
- **WASM Assets**: Must be present in `public/swiftlatex/`.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | Production build (SDK + standalone app) |
| `npm run build:lib` | SDK-only build (ES module + CSS) |
| `npm run check` | TypeScript type check (`tsgo --noEmit`) |
| `npm run test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run lint` | Lint check (Biome) |
| `npm run format` | Format code (Biome) |
| `npm run download-engine` | Download and patch pre-built WASM engines |

## Architecture

`LatexEditor` is designed as a **headless-first SDK**. The core logic is decoupled from the UI, allowing it to run as a full IDE or a background compilation service.

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

## Engine Setup

The editor requires `swiftlatexpdftex.wasm/js` and `swiftlatexbibtex.wasm/js`.

### Option A: Download (Recommended)
```bash
npm run download-engine
```
This script downloads pre-built binaries from the SwiftLaTeX project and **automatically applies patches** to support `readfile` commands and SyncTeX data extraction.

### Option B: Build from Source
If you need to modify the underlying pdfTeX or BibTeX engine:
1. Navigate to `wasm-build/`.
2. Follow the `README.md` inside (requires Docker).
3. Copy the resulting `dist/*` files to `public/swiftlatex/`.

## TexLive & CDN

Packages are fetched via synchronous XHR inside the WASM worker.

- **CDN**: Served via CloudFront (`dwrg2en9emzif.cloudfront.net`).
- **Structure**: Files are organized by TeX Live format IDs (e.g., `pdftex/26/` for `.sty` files).
- **Caching**: A Service Worker (`public/sw.js`) caches these files locally to enable offline compilation and speed up subsequent runs.

### URL Resolution Order
The `texliveUrl` is determined as follows:
1. `options.texliveUrl` passed to the constructor.
2. `VITE_TEXLIVE_URL` environment variable.
3. `${location.origin}${BASE_URL}texlive/` (default).

## Testing

### Unit Tests
We use **Vitest**. Tests are located in `*.test.ts` files alongside the source code.
```bash
npm run test
```

### E2E Tests
We use **Playwright**. These verify the full compilation loop, SyncTeX, and BibTeX integration.
```bash
# Requires dev server running at port 5173
npm run test:e2e
```

## LSP Implementation Details

### Project Index
`ProjectIndex` maintains a global state of symbols (labels, citations, commands) across all files in the `VirtualFS`. It is updated on every keystroke (debounced).

### Rename (F2)
Rename functionality uses `ProjectIndex.findAllOccurrences()` to find symbols in both `.tex` and `.bib` files. It handles:
- `\label` ↔ `\ref`
- `@article{key}` in `.bib` ↔ `\cite{key}` in `.tex`
- `\newcommand{\cmd}` ↔ `\cmd` usages

### Diagnostics
Diagnostics are computed by `DiagnosticProvider` by cross-referencing the `ProjectIndex`. For example, it flags `\ref{key}` if `key` does not exist in any loaded file.
