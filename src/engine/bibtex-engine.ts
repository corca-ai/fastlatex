import type { EngineStatus } from '../types'

interface WorkerMessage {
  result?: string
  cmd?: string
  log?: string
  data?: string
}

export class BibtexEngine {
  private worker: Worker | null = null
  private status: EngineStatus = 'unloaded'
  private enginePath: string
  private texliveUrl: string | null
  private pendingResponses = new Map<string, (data: WorkerMessage) => void>()

  constructor(options?: { assetBaseUrl?: string; texliveUrl?: string }) {
    const base = options?.assetBaseUrl ?? import.meta.env.BASE_URL
    this.enginePath = `${base}swiftlatex/swiftlatexbibtex.js`
    this.texliveUrl = options?.texliveUrl ?? null
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

    const texliveUrl =
      this.texliveUrl ??
      import.meta.env.VITE_TEXLIVE_URL ??
      `${location.origin}${import.meta.env.BASE_URL}texlive/`
    this.worker!.postMessage({ cmd: 'settexliveurl', url: texliveUrl })
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
