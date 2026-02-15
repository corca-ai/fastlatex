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

## Architecture

```
Browser
├── Monaco Editor        — code editing, LaTeX syntax
├── PDF.js               — PDF rendering, zoom, page navigation
├── SyncTeX              — bidirectional PDF ↔ source mapping
└── pdfTeX WASM Worker   — compilation in Web Worker
      └── fetches packages from TexLive server on demand

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
| `npm run test` | Unit tests (Vitest) |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run lint` | Lint (Biome) |
| `docker compose up` | Full stack with texlive server |

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
