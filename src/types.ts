export interface CompileResult {
  success: boolean
  pdf: Uint8Array | null
  log: string
  errors: TexError[]
  /** Time in milliseconds */
  compileTime: number
  /** Raw synctex data (uncompressed or gzipped) from pdfTeX -synctex=1 */
  synctex: Uint8Array | null
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
