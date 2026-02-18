import type { EngineStatus } from '../types'

/** Shared base for WASM worker engines (pdfTeX, BibTeX). */
export abstract class BaseWorkerEngine<TMsg = unknown> {
  protected worker: Worker | null = null
  protected status: EngineStatus = 'unloaded'
  protected enginePath: string
  protected texliveUrl: string | null
  protected pendingResponses = new Map<string, (data: TMsg) => void>()

  public onProgress?: (progress: number) => void

  constructor(enginePath: string, texliveUrl: string | null) {
    this.enginePath = enginePath
    this.texliveUrl = texliveUrl
  }

  getStatus(): EngineStatus {
    return this.status
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
      this.status = 'unloaded'
      this.pendingResponses.clear()
    }
  }
}

/** Resolve the TexLive server URL from an override, env var, or current origin. */
export function resolveTexliveUrl(override: string | null): string {
  return (
    override ??
    import.meta.env.VITE_TEXLIVE_URL ??
    `${location.origin}${import.meta.env.BASE_URL}texlive/`
  )
}
