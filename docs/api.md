# API Reference

Full reference for the `LatexEditor` SDK.

## Constructor

```typescript
new LatexEditor(container: HTMLElement, options?: LatexEditorOptions)
new LatexEditor(editorContainer: HTMLElement, previewContainer: HTMLElement, options?: LatexEditorOptions)
```

### Split-container mode

Pass both an editor container and a preview container to render only the two core UI panels:
editor (Monaco) and PDF viewer. This mode lets your app control panel placement and
page layout.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `texliveUrl` | `string` | `auto` | TexLive server endpoint |
| `mainFile` | `string` | `'main.tex'` | Main TeX file name |
| `files` | `Record` | `{}` | Initial project files (path -> content) |
| `serviceWorker`| `boolean`| `true` | Cache texlive packages via SW |
| `assetBaseUrl` | `string` | `auto` | Base URL for WASM/Worker assets |
| `headless` | `boolean`| `false` | Only affects legacy single-container mode; in split-container mode it is ignored |

## Methods

- `init(): Promise<void>`: Initializes the WASM engines and runs the first compilation.
- `loadProject(files: Record<string, string | Uint8Array>): void`: Replaces the entire project with new files.
- `setFile(path: string, content: string | Uint8Array): void`: Adds or updates a single file.
- `deleteFile(path: string): boolean`: Deletes a file from the virtual filesystem.
- `listFiles(): string[]`: Returns a list of all files in the project.
- `compile(): void`: Triggers an immediate compilation (bypassing the auto-compile debounce).
- `getPdf(): Uint8Array | null`: Returns the last successfully generated PDF.
- `revealLine(line: number, file?: string): void`: Navigates the editor to a specific line/file.
- `flushCache(): Promise<void>`: Clears the internal engine cache.
- `dispose(): void`: Cleans up the editor, workers, and DOM.

## Events

Use `editor.on(eventName, handler)` to listen for changes:

- `compile`: Fired when a compilation cycle completes.
    - Detail: `{ result: CompileResult }`
- `status`: Fired when the editor status changes (e.g., `'compiling'`, `'ready'`, `'error'`).
    - During `'loading'`, the `detail` field provides download progress (e.g., `'45%'`).
- `filechange`: Fired when the content of a file is modified.
- `filesUpdate`: Fired when files are added or deleted.
- `cursorChange`: Fired when the user moves the cursor in the editor.
- `diagnostics`: Fired when new LaTeX errors or warnings are detected.
- `outlineUpdate`: Fired when the document structure (sections/subsections) changes.
