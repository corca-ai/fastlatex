import type { TexliveVersion } from '../types'
import { BaseWorkerEngine, resolveTexliveUrl } from './base-worker-engine'

interface WorkerMessage {
  result?: string
  cmd?: string
  log?: string
  data?: string
}

export class BibtexEngine extends BaseWorkerEngine<WorkerMessage> {
  private version: TexliveVersion

  constructor(options?: {
    assetBaseUrl?: string
    texliveUrl?: string
    texliveVersion?: TexliveVersion
  }) {
    const base = options?.assetBaseUrl ?? import.meta.env.BASE_URL
    const version = options?.texliveVersion ?? '2025'
    super(`${base}swiftlatex/${version}/swiftlatexbibtex.js`, options?.texliveUrl ?? null)
    this.version = version
  }

  async init(): Promise<void> {
    if (this.worker) return
    this.status = 'loading'

    await new Promise<void>((resolve, reject) => {
      this.worker = new Worker(this.enginePath)
      this.worker.onmessage = (ev) => {
        const data: WorkerMessage = ev.data
        // Init message (no cmd)
        if (!data.cmd) {
          if (data.result === 'ok') {
            this.status = 'ready'
            resolve()
          } else {
            this.status = 'error'
            reject(new Error('BibTeX engine failed to initialize'))
          }
          return
        }
        // Dispatch by cmd
        const key = `cmd:${data.cmd}`
        const cb = this.pendingResponses.get(key)
        if (cb) {
          this.pendingResponses.delete(key)
          cb(data)
        }
      }
      this.worker.onerror = (err) => {
        this.status = 'error'
        reject(err)
      }
    })

    this.worker!.postMessage({
      cmd: 'settexliveurl',
      url: resolveTexliveUrl(this.texliveUrl, this.version),
    })
  }

  writeFile(path: string, content: string | Uint8Array): void {
    if (!this.worker) return
    this.worker.postMessage({ cmd: 'writefile', url: path, src: content })
  }

  mkdir(path: string): void {
    if (!this.worker) return
    this.worker.postMessage({ cmd: 'mkdir', url: path })
  }

  async compile(auxBaseName: string): Promise<{ success: boolean; log: string }> {
    if (this.status !== 'ready' || !this.worker) {
      return { success: false, log: 'BibTeX engine not ready' }
    }
    this.status = 'compiling'

    const data = await new Promise<WorkerMessage>((resolve) => {
      this.pendingResponses.set('cmd:compile', resolve)
      this.worker!.postMessage({ cmd: 'compilebibtex', url: auxBaseName })
    })

    this.status = 'ready'
    return {
      success: data.result === 'ok',
      log: data.log || '',
    }
  }

  async readFile(path: string): Promise<string | null> {
    if (!this.worker) return null

    const data = await new Promise<WorkerMessage>((resolve) => {
      this.pendingResponses.set('cmd:readfile', resolve)
      this.worker!.postMessage({ cmd: 'readfile', url: path })
    })

    return data.result === 'ok' ? (data.data ?? null) : null
  }
}
