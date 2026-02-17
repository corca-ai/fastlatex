# Development Guide

## Quick Start

```bash
npm run download-engine   # first time only
npm run dev
# App: http://localhost:5173
```

TeX packages are fetched on demand from CloudFront CDN via Vite proxy (configured in `.env`, override with `.env.local`).

## Prerequisites

- Node.js (v24+)
- WASM engine files in `public/swiftlatex/` (`npm run download-engine`)

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite dev server (hot reload, port 5173) |
| `npm run build` | Type check (`tsgo`) + production build |
| `npm run build:lib` | Library build (ES module) |
| `npm run preview` | Preview production build |
| `npm run check` | TypeScript type check only (`tsgo --noEmit`) |
| `npm run test` | Unit tests (vitest, single run) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run lint` | Lint check (Biome) |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run format` | Format code (Biome) |
| `npm run download-engine` | Download/setup WASM engine |

## Architecture

```
Browser
├── Monaco Editor (code editing)
├── PDF.js (PDF rendering)
├── SwiftLaTeX WASM Worker (pdfTeX 1.40.22)
│     └── fetches packages on demand from CloudFront CDN
└── BibTeX WASM Worker (separate binary)
      └── runs bibtex chain: pdflatex → bibtex → pdflatex
```

- **No framework** — vanilla TypeScript + Vite
- WASM engine runs in a Web Worker, communicates via `postMessage`
- SyncTeX provides bidirectional PDF ↔ source navigation
- All TeX Live packages (~120k files) served from S3/CloudFront on demand

## Project Structure

```
src/
├── engine/           # WASM engine wrapper, compile scheduler
├── editor/           # Monaco editor setup
├── viewer/           # PDF.js viewer, page renderer
├── synctex/          # SyncTeX parser + text-based fallback mapper
├── lsp/              # LaTeX language services (completion, hover, diagnostics, etc.)
├── fs/               # Virtual filesystem
├── ui/               # File tree, error log, layout, error markers
├── perf/             # Performance metrics + debug overlay
├── index.ts          # Library entry point
├── latex-editor.ts   # Component API (LatexEditor class)
├── main.ts           # Standalone app entry point
└── types.ts          # Shared types

public/swiftlatex/    # WASM engine files (not in git)
wasm-build/           # pdfTeX WASM build pipeline (Docker)
scripts/              # sync-texlive-s3.sh, download-engine.sh, etc.
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
# BibTeX WASM (also built automatically if Phase 1 includes --enable-bibtex):
cp dist/swiftlatexbibtex.js dist/swiftlatexbibtex.wasm ../public/swiftlatex/
```

<details><summary>Build time expectations</summary>

Two-phase build, **extremely slow** on ARM Macs (QEMU x86_64 emulation).

| Phase | ARM Mac (QEMU) | x86_64 Linux |
|-------|---------------|--------------|
| Phase 1: Native compile | ~40–75 min | ~7–12 min |
| Phase 2: WASM compile | ~30–55 min | ~7–12 min |
| **Total** | **~1.5–2.5 hours** | **~15–30 min** |

Recommendation: run on x86_64 Linux or CI.

</details>

## TexLive Package Serving

The WASM worker fetches LaTeX packages on demand during compilation via synchronous XHR.

All packages are served from S3 via CloudFront:

| Resource | Value |
|----------|-------|
| S3 bucket | `akcorca-texlive` (ap-northeast-2) |
| CloudFront | `dwrg2en9emzif.cloudfront.net` |
| Files | ~120,000 files, ~1.7 GB |

### URL resolution

The engine resolves the texlive URL in this order:

1. `texliveUrl` option passed to `SwiftLatexEngine` / `LatexEditor`
2. `VITE_TEXLIVE_URL` env var (baked into client at build time)
3. `${location.origin}${BASE_URL}texlive/` (Vite proxy → `TEXLIVE_URL` from `.env`)

### URL structure

The worker requests files as `{texliveUrl}pdftex/{format}/{filename}`:

| Format | Content | Example |
|--------|---------|---------|
| 3 | TFM font metrics | `pdftex/3/cmr10` |
| 6 | BibTeX support files (.bib) | `pdftex/6/xampl.bib` |
| 7 | BibTeX style files (.bst) | `pdftex/7/plain` |
| 10 | Format files | `pdftex/10/swiftlatexpdftex.fmt` |
| 11 | Font maps | `pdftex/11/pdftex.map` |
| 26 | TeX sources (.sty, .cls, .def) | `pdftex/26/geometry.sty` |
| 32 | PostScript fonts (.pfb) | `pdftex/32/cmr10.pfb` |
| 33 | Virtual fonts | `pdftex/33/cmr10` |
| 44 | Encoding files (.enc) | `pdftex/44/cm-super-ts1.enc` |

Missing files must return 404 (not 403). The worker caches both hits and misses in memory.

### Rebuilding the S3 content

```bash
./scripts/sync-texlive-s3.sh            # extract only
./scripts/sync-texlive-s3.sh --upload   # extract + upload to S3
```

Downloads the TeX Live 2020 texmf tarball from CTAN, extracts into flat structure, uploads to S3. Caches tarball in `/tmp/texlive-s3/`.

### Version constraint

The WASM binary is pdfTeX **1.40.22**. Format files (`.fmt`) must match this exact version — Ubuntu 20.04's system `pdflatex.fmt` (built by 1.40.20) will not work.

## Tests

### Unit tests

```bash
npm run test          # single run
npm run test:watch    # watch mode
```

Test files live next to source: `src/**/*.test.ts`

### E2E tests

```bash
npm run test:e2e
```

E2E tests use Playwright and live in `e2e/`.

## Troubleshooting

### WASM worker caches 404s

If a file was temporarily missing and the worker cached the 404, hard refresh (Cmd+Shift+R) to clear the worker's `texlive404_cache`.

### l3backend errors

Newer `l3backend` packages (2023+) require `\__kernel_dependency_version_check:nn` which doesn't exist in the pdfTeX 1.40.22 format. The S3 deployment ships TeX Live 2020's `l3backend-pdfmode.def` which has no version check.
