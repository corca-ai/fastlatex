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

  /** Send a message to the worker and wait for a response keyed by responseKey. */
  protected postMessageWithResponse(
    msg: any,
    responseKey: string,
    transferables?: Transferable[],
  ): Promise<TMsg> {
    return new Promise<TMsg>((resolve) => {
      this.pendingResponses.set(responseKey, resolve)
      if (transferables?.length) {
        this.worker!.postMessage(msg, transferables)
      } else {
        this.worker!.postMessage(msg)
      }
    })
  }
}

const CLOUDFRONT_BASE = 'https://d1jectpaw0dlvl.cloudfront.net/'

/** Resolve the TexLive server URL from an override, env var, or current origin. */
export function resolveTexliveUrl(
  override: string | null,
  version: TexliveVersion = '2025',
): string {
  if (override) return override.endsWith('/') ? override : `${override}/`

  const envUrl = import.meta.env.VITE_TEXLIVE_URL
  if (envUrl) return envUrl.endsWith('/') ? envUrl : `${envUrl}/`

  // Consistent versioned path: https://.../{version}/
  return `${CLOUDFRONT_BASE}${version}/`
}
