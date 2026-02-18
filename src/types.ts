export interface CompileResult {
  success: boolean
  pdf: Uint8Array | null
  log: string
  errors: TexError[]
  /** Time in milliseconds */
  compileTime: number
  /** Raw synctex data (uncompressed or gzipped) from pdfTeX -synctex=1 */
  synctex: Uint8Array | null
  /** Whether a cached preamble format was used for this compilation */
  preambleSnapshot?: boolean
  /** Control sequences from pdfTeX hash table (package + user commands) */
  engineCommands?: string[]
  /** Input .tex files discovered by pdfTeX -recorder (.fls) */
  inputFiles?: string[]
  /** Raw .trace file content from semantic trace hooks */
  semanticTrace?: string
}

export interface TexError {
  line: number
  message: string
  severity: 'error' | 'warning'
  file?: string
}

export interface VirtualFile {
  path: string
  content: string | Uint8Array
  modified: boolean
}

export type EngineStatus = 'unloaded' | 'loading' | 'ready' | 'compiling' | 'error'

export type AppStatus = EngineStatus | 'rendering'

// --- LatexEditor component API ---

export interface LatexEditorOptions {
  /** TexLive server endpoint URL. Defaults to auto-detected from BASE_URL. */
  texliveUrl?: string
  /** Main TeX file name. Defaults to 'main.tex'. */
  mainFile?: string
  /** Initial project files. Keys are file paths, values are content. */
  files?: Record<string, string | Uint8Array>
  /** Register a service worker for texlive package caching. Defaults to true. */
  serviceWorker?: boolean
  /** Base URL for WASM/static assets. Defaults to `import.meta.env.BASE_URL`. */
  assetBaseUrl?: string
  /**
   * If true, only the Monaco editor is rendered in the container.
   * Host is responsible for rendering sidebar, viewer, and logs.
   * Defaults to false for backward compatibility.
   */
  headless?: boolean
}

export interface LatexEditorEventMap {
  /** Triggered when a compilation finishes */
  compile: { result: CompileResult }
  /** Triggered when file content changes */
  filechange: { path: string; content: string | Uint8Array }
  /** Triggered when editor status changes */
  status: { status: AppStatus; detail?: string }
  /** Triggered when the set of files in the project changes (created/deleted) */
  filesUpdate: { files: string[] }
  /** Triggered when the document outline (sections) is updated */
  outlineUpdate: { sections: import('./lsp/types').SectionDef[] }
  /** Triggered when cursor position changes */
  cursorChange: { path: string; line: number; column: number }
  /** Triggered when LSP diagnostics (errors/warnings) are updated */
  diagnostics: { diagnostics: TexError[] }
}
