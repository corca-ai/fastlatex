# LaTeX Editor

Browser-based LaTeX editor with real-time PDF preview. Monaco editor + pdfTeX WASM engine + PDF.js — no server-side compilation required for basic documents.

**[Live Demo](https://akcorca.github.io/latex-editor/)**

## Mission

To provide a high-performance, **embeddable LaTeX component** that outperforms existing solutions. Designed specifically for integration into host applications (academic platforms, CMS, collaboration tools), it focuses on four pillars:
- **(A) Immediate Response**: 100–200ms keystroke-to-screen feedback.
- **(B) Authority Engine**: Accurate compilation using native pdfTeX via WASM.
- **(C) Seamless Mapping**: Bidirectional source-to-view synchronization (SyncTeX).
- **(D) Cloud Package System**: On-demand access to the full TeX Live distribution.

## Features

- **Real-time PDF Preview**: Live LaTeX editing with syntax highlighting (Monaco) and PDF.js viewer.
- **Bidirectional SyncTeX**: Click PDF to jump to source, or navigate source to highlight PDF positions.
- **Client-Side TeX Engine**: pdfTeX 1.40.22 running entirely in the browser via WebAssembly.
- **On-Demand Packages**: LaTeX packages fetched from CloudFront CDN and cached via Service Worker.
- **LSP Support**: Intelligent completion, diagnostics, and project-wide renaming (F2).
- **Embeddable SDK**: Designed as a single-class API for integration into any web application.

## Documentation

- **[Integration Guide (docs/howto.md)](docs/howto.md)**: Learn how to install and embed the editor into your application, use Headless mode, and reference the full API.
- **[Contributor Guide (docs/develop.md)](docs/develop.md)**: Details on internal architecture, building the WASM engine, and setting up the development environment.

## Architecture

```
Browser
├── LatexEditor              — component API, orchestrates everything
│   ├── Monaco Editor        — code editing, LaTeX syntax
│   ├── LSP Engine           — completion, diagnostics, rename (F2)
│   ├── PDF.js               — PDF rendering, zoom, page navigation
│   ├── SyncTeX              — bidirectional PDF ↔ source mapping
│   └── pdfTeX WASM Worker   — compilation in Web Worker
│         └── fetches packages on demand from CloudFront CDN
└── VirtualFS                — in-memory file system (no IndexedDB)
```

Vanilla TypeScript + Vite. No framework. Designed as an embeddable component — the host application owns authentication, storage, and collaboration.

## Roadmap

- **TeX Live 2025 Upgrade**: Update WASM engines and S3 assets to the latest TeX Live.
- **WebGPU LiveView**: Immediate preview using a custom PDL output driver and WebGPU renderer (bypassing PDF generation for sub-50ms latency).
- **Large Document Optimization**: Partial compilation and incremental rendering for 100+ page documents.
- **Server Fallback**: Automatic handover to server-side engines for documents exceeding WASM memory/time limits.
- **Collaborative Core**: Hooks for CRDT/OT integration to support real-time multi-user editing.

## Tech Stack

- **TypeScript** + **Vite** — Build and dev server.
- **Monaco Editor** — Code editing and language services.
- **PDF.js** — High-performance PDF rendering.
- **pdfTeX 1.40.22** — Native TeX engine compiled to WASM.
- **Vitest** + **Playwright** — Comprehensive testing suite.
- **Biome** — Linting and formatting.

## License

[MIT](LICENSE)

This project includes third-party components under their own licenses — see [LICENSE](LICENSE) for details. Notably, the pdfTeX WASM binary is compiled from [TeX Live](https://tug.org/texlive/) (GPL v2+) and the WASM build pipeline uses [Texlive-Ondemand](https://github.com/SwiftLaTeX/Texlive-Ondemand) (AGPL-3.0).
