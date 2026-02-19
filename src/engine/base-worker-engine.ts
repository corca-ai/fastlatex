import type { EngineStatus, TexliveVersion } from '../types'

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

const CLOUDFRONT_2025 = 'https://dwrg2en9emzif.cloudfront.net/2025/'

/** Resolve the TexLive server URL from an override, env var, or current origin. */
export function resolveTexliveUrl(
  override: string | null,
  version: TexliveVersion = '2025',
): string {
  if (override) return override.endsWith('/') ? override : `${override}/`

  const envUrl = import.meta.env.VITE_TEXLIVE_URL
  if (envUrl) return envUrl.endsWith('/') ? envUrl : `${envUrl}/`

  // Default behaviors based on version
  if (version === '2025') {
    return CLOUDFRONT_2025
  }

  // Legacy 2020 fallback
  return `${location.origin}${import.meta.env.BASE_URL}texlive/`
}
