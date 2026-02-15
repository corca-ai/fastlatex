import type { CompileResult, EngineStatus } from '../types'
import { parseTexErrors } from './parse-errors'
import type { TexEngine } from './tex-engine'

const ENGINE_PATH = `${import.meta.env.BASE_URL}swiftlatex/swiftlatexpdftex.js`
const FORMAT_PATH = `${import.meta.env.BASE_URL}swiftlatex/swiftlatexpdftex.fmt`

export class SwiftLatexEngine implements TexEngine {
  private worker: Worker | null = null
  private status: EngineStatus = 'unloaded'
  private texliveUrl: string | null = null

  /** Set a custom TexLive endpoint before init(). Default is baked into the worker. */
  setTexliveUrl(url: string): void {
    this.texliveUrl = url
  }

  async init(): Promise<void> {
    if (this.worker) {
      throw new Error('Engine already initialized')
    }

    this.status = 'loading'

    await new Promise<void>((resolve, reject) => {
      this.worker = new Worker(ENGINE_PATH)

      this.worker.onmessage = (ev) => {
        const data = ev.data
        if (data.result === 'ok') {
          this.status = 'ready'
          resolve()
        } else {
          this.status = 'error'
          reject(new Error('Engine failed to initialize'))
        }
      }

      this.worker.onerror = (err) => {
        this.status = 'error'
        reject(err)
      }
    })

    // Clear handlers after init
    this.worker!.onmessage = () => {}
    this.worker!.onerror = () => {}

    // Set TexLive endpoint — proxied through Vite dev server (/texlive/ → texlive:5001)
    // Note: do NOT use PdfTeXEngine's setTexliveEndpoint() — it has a bug
    // that nullifies the worker reference after posting the message
    const texliveUrl = this.texliveUrl ?? `${location.origin}${import.meta.env.BASE_URL}texlive/`
    this.worker!.postMessage({ cmd: 'settexliveurl', url: texliveUrl })

    // Pre-load the format file so the worker doesn't need to build one.
    // Without a texlive server (e.g. gh-pages), the worker can't fetch
    // pdflatex.ini to build a format from scratch.
    await this.preloadFormat()
  }

  private async preloadFormat(): Promise<void> {
    try {
      const resp = await fetch(FORMAT_PATH)
      if (!resp.ok) return
      const buf = await resp.arrayBuffer()
      await new Promise<void>((resolve) => {
        this.worker!.onmessage = (ev) => {
          if (ev.data.cmd === 'loadformat') {
            this.worker!.onmessage = () => {}
            resolve()
          }
        }
        this.worker!.postMessage({ cmd: 'loadformat', data: buf }, [buf])
      })
    } catch {
      // Format not available — worker will try building one at compile time
    }
  }

  writeFile(path: string, content: string | Uint8Array): void {
    this.checkInitialized()
    this.worker!.postMessage({ cmd: 'writefile', url: path, src: content })
  }

  mkdir(path: string): void {
    this.checkInitialized()
    if (!path || path === '/') return
    this.worker!.postMessage({ cmd: 'mkdir', url: path })
  }

  setMainFile(path: string): void {
    this.checkInitialized()
    this.worker!.postMessage({ cmd: 'setmainfile', url: path })
  }

  async compile(): Promise<CompileResult> {
    this.checkReady()
    this.status = 'compiling'

    const start = performance.now()

    const result = await new Promise<CompileResult>((resolve) => {
      this.worker!.onmessage = (ev) => {
        const data = ev.data
        if (data.cmd !== 'compile') return

        this.status = 'ready'
        const compileTime = performance.now() - start
        const log: string = data.log || ''
        const success = data.result === 'ok'
        const pdf = success ? new Uint8Array(data.pdf) : null
        const synctex = success && data.synctex ? new Uint8Array(data.synctex) : null
        const errors = parseTexErrors(log)

        resolve({ success, pdf, log, errors, compileTime, synctex })
      }

      this.worker!.postMessage({ cmd: 'compilelatex' })
    })

    this.worker!.onmessage = () => {}
    return result
  }

  async readFile(path: string): Promise<string | null> {
    this.checkInitialized()

    return new Promise<string | null>((resolve) => {
      this.worker!.onmessage = (ev) => {
        const data = ev.data
        if (data.cmd !== 'readfile') return

        this.worker!.onmessage = () => {}
        resolve(data.result === 'ok' ? data.data : null)
      }

      this.worker!.postMessage({ cmd: 'readfile', url: path })
    })
  }

  isReady(): boolean {
    return this.status === 'ready'
  }

  getStatus(): EngineStatus {
    return this.status
  }

  flushCache(): void {
    this.checkInitialized()
    this.worker!.postMessage({ cmd: 'flushcache' })
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
      this.status = 'unloaded'
    }
  }

  /** Guard for compile() — must be 'ready' (not already compiling) */
  private checkReady(): void {
    if (this.status !== 'ready') {
      throw new Error(`Engine not ready (status: ${this.status})`)
    }
  }

  /** Guard for writeFile/mkdir/setMainFile — worker must exist (ready or compiling) */
  private checkInitialized(): void {
    if (!this.worker || this.status === 'unloaded' || this.status === 'loading') {
      throw new Error(`Engine not initialized (status: ${this.status})`)
    }
  }
}
