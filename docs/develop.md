# Development Guide

## Quick Start

```bash
# Full stack (recommended) — editor + texlive server
docker compose up
# App: http://localhost:5555
# TexLive server: http://localhost:5001

# Frontend only (no LaTeX package support)
npm run dev
```

## Prerequisites

- Node.js (see `.nvmrc`)
- Docker & Docker Compose
- WASM engine files in `public/swiftlatex/` (see Engine Setup below)

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (hot reload) |
| `npm run build` | Type check + production build |
| `npm run check` | TypeScript type check only |
| `npm run test` | Unit tests (vitest, single run) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run lint` | Lint check (Biome) |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Format code (Biome) |
| `npm run download-engine` | Download/setup WASM engine |
| `docker compose up` | Full stack with texlive |
| `docker compose build texlive` | Rebuild texlive image |

## Architecture

```
Browser
├── Monaco Editor (code editing)
├── PDF.js (PDF rendering)
└── SwiftLaTeX WASM Worker (pdfTeX 1.40.21)
      └── fetches packages from TexLive server

TexLive Server (Docker, port 5001)
└── Flask app serving .tfm, .sty, .cls, .fmt files
```

- **No framework** — vanilla TypeScript + Vite
- WASM engine runs in a Web Worker, communicates via `postMessage`
- SyncTeX provides bidirectional PDF ↔ source navigation

## Project Structure

```
src/
├── engine/           # WASM engine wrapper, compile scheduler
├── editor/           # Monaco editor setup
├── viewer/           # PDF.js viewer, click handling
├── synctex/          # SyncTeX parser + text-based fallback mapper
├── fs/               # Virtual filesystem
├── main.ts           # App entry point
└── types.ts          # Shared types

public/swiftlatex/    # WASM engine files (not in git)
texlive-server/       # Flask server for TeX packages
wasm-build/           # pdfTeX WASM build pipeline (Docker)
scripts/              # Helper scripts
e2e/                  # Playwright E2E tests
docs/                 # Documentation
```

## Engine Setup

The WASM engine files (`swiftlatexpdftex.js`, `.wasm`) must be in `public/swiftlatex/`.

### Option A: Download pre-built (fast)

```bash
npm run download-engine
```

Downloads from SwiftLaTeX GitHub releases. Does **not** include SyncTeX support.

### Option B: Build from source with SyncTeX (slow)

```bash
cd wasm-build
docker build --platform linux/amd64 -t pdftex-wasm .
docker run --platform linux/amd64 -v "$(pwd)/dist:/dist" pdftex-wasm
cp dist/swiftlatexpdftex.js dist/swiftlatexpdftex.wasm ../public/swiftlatex/
```

#### Build time expectations

The WASM build is a two-phase process and is **extremely slow** on ARM Macs (Apple Silicon) because it runs x86_64 emulation via QEMU/Rosetta.

| Phase | ARM Mac (QEMU) | x86_64 Linux |
|-------|---------------|--------------|
| Docker image build | ~15 min (first), ~1 min (cached) | ~5 min (first) |
| Phase 1: Native configure | ~10–15 min | ~2 min |
| Phase 1: Native compile (libs + web2c) | ~30–60 min | ~5–10 min |
| Phase 2: WASM configure (emconfigure) | ~10–15 min | ~2 min |
| Phase 2: WASM compile (emmake + emcc) | ~20–40 min | ~5–10 min |
| **Total** | **~1.5–2.5 hours** | **~15–30 min** |

The bottleneck is `libs/icu/` (ICU C++ library, ~200 source files) and `texk/web2c/` (pdfTeX C generation via tangle). On ARM Mac the Docker container runs under QEMU emulation for x86_64 which makes everything ~5–10x slower.

**Recommendation**: If possible, run the WASM build on an x86_64 Linux machine or CI server.

#### Build phases explained

1. **Phase 1 — Native build**: Compiles TeX Live natively to generate pdfTeX C source files (`pdftex0.c`, `pdftexini.c`, etc.) using the `tangle` tool. These tools can only run natively, not under Emscripten.

2. **Phase 2 — WASM build**: Configures TeX Live through `emconfigure`, copies the natively-generated C files, then compiles everything with `emcc` to produce the `.wasm` + `.js` output.

The full build may show errors for luajittex (missing `hb.h`) — this is expected and ignored. Only pdfTeX is needed.

## TexLive Server

```bash
# Build the image (~5GB, includes texlive-full)
docker compose build texlive

# Run standalone
docker compose up texlive
```

The server provides `.tfm`, `.sty`, `.cls`, `.fmt` and other TeX resources to the WASM engine at runtime.

### Version constraint

The WASM binary is pdfTeX **1.40.21**. Format files (`.fmt`) must be built by this exact version. The texlive server uses pre-built format files from the Texlive-Ondemand repo — do **not** attempt to rebuild them with the server's pdfTeX (1.40.20), as it will produce incompatible format files ("Fatal format file error; I'm stymied").

## Tests

### Unit tests

```bash
npm run test          # single run
npm run test:watch    # watch mode
```

Test files live next to source: `src/**/*.test.ts`

### E2E tests

```bash
# Requires the full stack running
docker compose up -d
npm run test:e2e
```

E2E tests use Playwright and live in `e2e/`.

## Troubleshooting

### WASM worker caches 404s

If the texlive server was down and the worker cached 404 responses, the cache persists across recompiles. Fix: hard refresh the browser (Cmd+Shift+R) to clear the worker's `texlive404_cache`.

### "Fatal format file error; I'm stymied"

The format file version doesn't match the WASM pdfTeX version (1.40.21). Use the pre-built format file from the texlive server — do not rebuild it locally.

### l3backend errors

Newer `l3backend` packages (2023+) require `\__kernel_dependency_version_check:nn` which doesn't exist in the pdfTeX 1.40.21 format. The texlive server ships Ubuntu 20.04's `l3backend-pdfmode.def` (2020-02-03) which has no version check and works fine.
