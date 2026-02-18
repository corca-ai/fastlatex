# WASM Engine & TeX Live

This document details the LaTeX/BibTeX engine internals and the on-demand package system.

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

## Asset Resolution (WASM & Workers)

The editor requires several heavy assets to function:
- `swiftlatexpdftex.wasm` / `swiftlatexpdftex.js`
- `swiftlatexbibtex.wasm` / `swiftlatexbibtex.js`
- `sw.js` (Service Worker)

**Automatic Resolution (Recommended)**:
By default, the editor automatically attempts to find these assets. It checks:
1. Your build tool's base URL (e.g., Vite's `import.meta.env.BASE_URL`).
2. The location where the library script itself is hosted (`import.meta.url`).

In most modern setups (Vite, Webpack 5), **you don't need to set `assetBaseUrl` manually** as long as the assets are in your public directory.

**Manual Configuration**:
If you host assets on a specific CDN or a non-standard path, provide the `assetBaseUrl`:
```typescript
const editor = new LatexEditor(container, {
  assetBaseUrl: 'https://cdn.example.com/assets/latex-editor/'
})
```

## Service Worker
The editor uses a service worker to cache TeX packages fetched from the CDN. 
- If `assetBaseUrl` is automatically resolved, it will look for `sw.js` at that same base path.
- Ensure your hosting environment allows service workers (served over HTTPS or localhost).
- To disable: set `serviceWorker: false` in options.
