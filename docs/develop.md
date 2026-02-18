# Development Guide

This guide is for developers contributing to the `latex-editor` codebase.

## Quick Start

```bash
npm install
npm run download-engine   # Download WASM engine (first time only)
npm run dev               # Start dev server
# App: http://localhost:5173
```

## Prerequisites

- **Node.js**: v24+ recommended.
- **WASM Assets**: Must be present in `public/swiftlatex/` (see [docs/engine.md](engine.md)).

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (port 5173) |
| `npm run build` | Production build (SDK + standalone app) |
| `npm run build:lib` | SDK-only build (ES module + CSS) |
| `npm run check` | TypeScript type check |
| `npm run test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright) |
| `npm run lint` | Lint check (Biome) |
| `npm run format` | Format code (Biome) |
| `npm run download-engine` | Download and patch pre-built WASM engines |

## Architecture & Internals

- See **[docs/architecture.md](architecture.md)** for a deep dive into the SDK structure and LSP implementation.
- See **[docs/engine.md](engine.md)** for details on the WASM compilation engine and TeX Live CDN.

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
