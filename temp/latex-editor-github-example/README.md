# latex-editor GitHub Install Example

Minimal project that installs `latex-editor` from GitHub directly via `npm install`.

## Run

```bash
cd temp/latex-editor-github-example
npm install
npm run dev
```

Then open `http://localhost:5173`.

If you want to install from GitHub explicitly:

```bash
npm install github:akcorca/latex-editor
```

Note:
- This example uses local static assets copied under `temp/latex-editor-github-example/public` so the editor can load worker and engine files from a plain Vite dev server:
  - `public/assets/*` (`editor.worker-*.js`, `json.worker-*.js`)
  - `public/swiftlatex/2025/*` (pdfTeX/BibTeX WASM + js)
  - `public/sw.js`
  - A duplicate copy is also placed under `public/public/*` to match environments that resolve worker URLs with a `/public/...` prefix.
- `serviceWorker: false` is set in `src/main.js` to avoid SW registration noise in a tiny example.
- `src/latex-editor.css` is copied from the built package for immediate styling in this environment. If you upgrade the editor version, refresh it if needed.
- The example uses the new two-container constructor:
  `new LatexEditor(editorContainer, previewContainer, options)` to keep only editor + PDF viewer.
