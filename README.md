# LaTeX Editor

Browser-based LaTeX editor with real-time PDF preview. Monaco editor + pdfTeX WASM engine + PDF.js — no server-side compilation required for basic documents.

**[Live Demo](https://akcorca.github.io/latex-editor/)**

## Features

- Live LaTeX editing with syntax highlighting (Monaco)
- Real-time PDF preview (PDF.js)
- Bidirectional SyncTeX navigation — click PDF to jump to source, cursor movement highlights PDF location
- pdfTeX 1.40.22 running entirely in the browser via WebAssembly
- LaTeX package support via TexLive-Ondemand server (lazy fetch + service worker cache)
- Virtual filesystem for multi-file projects
- Inline error markers and error log panel
- Embeddable component API — `new LatexEditor(container)` one-liner

## Quick Start

```bash
# Full stack (editor + texlive package server)
docker compose up
# → http://localhost:5555

# Frontend only (no LaTeX package support)
npm install
npm run dev
```

Basic documents compile without the texlive server. The server is only needed for LaTeX packages (`\usepackage{...}`) beyond the base format.

## Embedding

`LatexEditor` is a single-class API designed for embedding into host applications.

```typescript
import { LatexEditor } from 'latex-editor'
import 'latex-editor/style.css'

const editor = new LatexEditor(document.getElementById('container')!, {
  files: {
    'main.tex': '\\documentclass{article}\n\\begin{document}\nHello!\n\\end{document}\n',
  },
})

await editor.init()
```

### Options

```typescript
new LatexEditor(container, {
  texliveUrl?: string,        // TexLive server endpoint (default: auto-detect)
  mainFile?: string,           // Main TeX file name (default: 'main.tex')
  files?: Record<string, string | Uint8Array>,  // Initial project files
  serviceWorker?: boolean,     // Cache texlive packages via SW (default: true)
  assetBaseUrl?: string,       // Base URL for WASM assets
})
```

### API

```typescript
// Lifecycle
await editor.init()          // Load WASM engine and run initial compile
editor.dispose()             // Tear down everything

// File management
editor.loadProject({ 'main.tex': '...', 'refs.bib': '...' })
editor.saveProject()         // → Record<string, string | Uint8Array>
editor.setFile('main.tex', content)
editor.getFile('main.tex')   // → string | Uint8Array | null
editor.deleteFile('ch1.tex')
editor.listFiles()           // → string[]

// Compilation
editor.compile()             // Manual compile trigger
editor.getPdf()              // Last compiled PDF as Uint8Array

// Events
editor.on('compile', (e) => { /* e.result: CompileResult */ })
editor.on('filechange', (e) => { /* e.path, e.content */ })
editor.on('status', (e) => { /* e.status: AppStatus */ })
editor.off('compile', handler)

// Escape hatches
editor.getMonacoEditor()     // Monaco IStandaloneCodeEditor
editor.getViewer()           // PdfViewer instance
```

### Library Build

```bash
npm run build:lib
```

Produces `dist/latex-editor.js` and `dist/latex-editor.css`. See [`examples/embed.html`](examples/embed.html) for a minimal integration example.

## Architecture

```
Browser
├── LatexEditor              — component API, orchestrates everything
│   ├── Monaco Editor        — code editing, LaTeX syntax
│   ├── PDF.js               — PDF rendering, zoom, page navigation
│   ├── SyncTeX              — bidirectional PDF ↔ source mapping
│   └── pdfTeX WASM Worker   — compilation in Web Worker
│         └── fetches packages from TexLive server on demand
└── VirtualFS                — in-memory file system (no IndexedDB)

TexLive Server (Docker, port 5001)
└── Flask app serving .tfm, .sty, .cls, .fmt files
```

Vanilla TypeScript + Vite. No framework. Designed as an embeddable component — the host application owns authentication, storage, and collaboration.

## Development

See [docs/develop.md](docs/develop.md) for the full development guide, including:

- WASM engine setup (download or build from source with SyncTeX)
- TexLive server configuration and version constraints
- Testing (unit + E2E)
- Troubleshooting

### Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server |
| `npm run build` | Type check + production build |
| `npm run build:lib` | Library build (ES module + CSS) |
| `npm run test` | Unit tests (Vitest) |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run check` | Type check only (tsgo) |
| `npm run lint` | Lint (Biome) |
| `docker compose up` | Full stack with texlive server |

### Key Files

| Path | Description |
|------|-------------|
| `src/latex-editor.ts` | Main component class |
| `src/index.ts` | Library entry point (barrel export) |
| `src/engine/swiftlatex-engine.ts` | WASM engine wrapper |
| `src/fs/virtual-fs.ts` | In-memory virtual filesystem |
| `src/viewer/pdf-viewer.ts` | PDF rendering + SyncTeX navigation |
| `src/synctex/synctex-parser.ts` | SyncTeX binary parser |
| `src/editor/setup.ts` | Monaco editor setup + LaTeX language |
| `scripts/sync-texlive-s3.sh` | Extract TeX Live files for S3 upload (no Docker) |

## Tech Stack

- **TypeScript** + **Vite** — build and dev server
- **Monaco Editor** — code editing
- **PDF.js** — PDF rendering
- **pdfTeX 1.40.22** — TeX engine compiled to WASM (Emscripten)
- **Vitest** + **Playwright** — unit and E2E testing
- **Biome** — linting and formatting

## License

[MIT](LICENSE)

This project includes third-party components under their own licenses — see [LICENSE](LICENSE) for details. Notably, the pdfTeX WASM binary is compiled from [TeX Live](https://tug.org/texlive/) (GPL v2+) and the texlive server build uses [Texlive-Ondemand](https://github.com/SwiftLaTeX/Texlive-Ondemand) (AGPL-3.0).
