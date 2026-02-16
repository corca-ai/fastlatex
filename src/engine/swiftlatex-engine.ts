import type { CompileResult, EngineStatus } from '../types'
import { parseTexErrors } from './parse-errors'
import type { TexEngine } from './tex-engine'

export interface SwiftLatexEngineOptions {
  /** Base URL for WASM assets. Defaults to `import.meta.env.BASE_URL`. */
  assetBaseUrl?: string
  /** TexLive server endpoint. Defaults to `${location.origin}${BASE_URL}texlive/`. */
  texliveUrl?: string
}

/** Counter for unique message IDs. */
let nextMsgId = 1

/** Worker response message shape (untyped — worker uses plain objects). */
interface WorkerMessage {
  result?: string
  cmd?: string
  msgId?: string
  log?: string
  pdf?: ArrayBuffer
  synctex?: ArrayBuffer
  format?: ArrayBuffer
  data?: string
  preambleSnapshot?: boolean
  engineCommands?: string[]
  inputFiles?: string[]
  [key: string]: unknown
}

export class SwiftLatexEngine implements TexEngine {
  private worker: Worker | null = null
  private status: EngineStatus = 'unloaded'
  private texliveUrl: string | null
  private baseUrl: string
  private enginePath: string
  private formatPath: string
  private pendingResponses = new Map<string, (data: WorkerMessage) => void>()

  constructor(options?: SwiftLatexEngineOptions) {
    const base = options?.assetBaseUrl ?? import.meta.env.BASE_URL
    this.baseUrl = base
    this.enginePath = `${base}swiftlatex/swiftlatexpdftex.js`
    this.formatPath = `${base}swiftlatex/swiftlatexpdftex.fmt`
    this.texliveUrl = options?.texliveUrl ?? null
  }

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
      this.worker = new Worker(this.enginePath)

      this.worker.onmessage = (ev) => {
        this.dispatchWorkerMessage(ev.data, resolve, reject)
      }

      this.worker.onerror = (err) => {
        this.status = 'error'
        reject(err)
      }
    })

    // Set TexLive endpoint — proxied through Vite dev server (/texlive/ → texlive:5001)
    // Note: do NOT use PdfTeXEngine's setTexliveEndpoint() — it has a bug
    // that nullifies the worker reference after posting the message
    const texliveUrl = this.texliveUrl ?? `${location.origin}${import.meta.env.BASE_URL}texlive/`
    this.worker!.postMessage({ cmd: 'settexliveurl', url: texliveUrl })

    // Pre-load format and pdftex.map in parallel
    await Promise.all([
      this.preloadFormat(),
      this.preloadTexliveFile(11, 'pdftex.map', `${this.baseUrl}texlive/pdftex/11/pdftex.map`),
    ])
  }

  /**
   * Dispatch a worker message to the appropriate handler.
   * Separated from init() to reduce cognitive complexity.
   */
  private dispatchWorkerMessage(
    data: WorkerMessage,
    initResolve: () => void,
    initReject: (err: Error) => void,
  ): void {
    // Init message (no msgId) — the WASM postRun callback
    if (!data.cmd && !data.msgId) {
      if (data.result === 'ok') {
        this.status = 'ready'
        initResolve()
      } else {
        this.status = 'error'
        initReject(new Error('Engine failed to initialize'))
      }
      return
    }

    // Dispatch by msgId (new protocol for parallel messages)
    if (data.msgId) {
      const cb = this.pendingResponses.get(data.msgId)
      if (cb) {
        this.pendingResponses.delete(data.msgId)
        cb(data)
        return
      }
    }

    // Dispatch by cmd (legacy protocol for compile/readfile)
    if (data.cmd) {
      const key = `cmd:${data.cmd}`
      const cb = this.pendingResponses.get(key)
      if (cb) {
        this.pendingResponses.delete(key)
        cb(data)
      }
    }
  }

  private async preloadFormat(): Promise<void> {
    try {
      const buf = await this.fetchGzWithFallback(this.formatPath)
      if (!buf) return
      await this.postMessageWithResponse({ cmd: 'loadformat', data: buf }, 'cmd:loadformat', [buf])
    } catch {
      // Format not available — worker will try building one at compile time
    }
  }

  /** Pre-load a texlive file into the worker's MEMFS cache. */
  private async preloadTexliveFile(format: number, filename: string, url: string): Promise<void> {
    try {
      const buf = await this.fetchGzWithFallback(url)
      if (!buf) return
      const msgId = `msg-${nextMsgId++}`
      await this.postMessageWithResponse(
        { cmd: 'preloadtexlive', format, filename, data: buf, msgId },
        msgId,
        [buf],
      )
    } catch {
      // File not available — worker will fetch on demand via XHR
    }
  }

  /**
   * Try fetching url.gz first (with DecompressionStream), fall back to raw url.
   * Returns the ArrayBuffer or null if both fail.
   */
  private async fetchGzWithFallback(url: string): Promise<ArrayBuffer | null> {
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const resp = await fetch(`${url}.gz`)
        if (resp.ok) {
          return await this.decompressGzipResponse(resp)
        }
      } catch {
        // .gz fetch or decompress failed — try raw
      }
    }

    // Fallback: fetch uncompressed
    try {
      const resp = await fetch(url)
      if (!resp.ok) return null
      return await resp.arrayBuffer()
    } catch {
      return null
    }
  }

  private async decompressGzipResponse(resp: Response): Promise<ArrayBuffer> {
    const ds = new DecompressionStream('gzip')
    const decompressed = resp.body!.pipeThrough(ds)
    const reader = decompressed.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const total = chunks.reduce((s, c) => s + c.length, 0)
    const result = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
      result.set(c, offset)
      offset += c.length
    }
    return result.buffer
  }

  /** Send a message to the worker and wait for a response keyed by responseKey. */
  private postMessageWithResponse(
    msg: Record<string, unknown>,
    responseKey: string,
    transferables?: Transferable[],
  ): Promise<WorkerMessage> {
    return new Promise<WorkerMessage>((resolve) => {
      this.pendingResponses.set(responseKey, resolve)
      if (transferables?.length) {
        this.worker!.postMessage(msg, transferables)
      } else {
        this.worker!.postMessage(msg)
      }
    })
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

    const data = await this.postMessageWithResponse({ cmd: 'compilelatex' }, 'cmd:compile')

    this.status = 'ready'
    const compileTime = performance.now() - start
    const log: string = data.log || ''
    const success = data.result === 'ok'
    const pdf = success ? new Uint8Array(data.pdf as ArrayBuffer) : null
    const synctex = success && data.synctex ? new Uint8Array(data.synctex as ArrayBuffer) : null
    const errors = parseTexErrors(log)
    const preambleSnapshot = !!data.preambleSnapshot

    const result: CompileResult = {
      success,
      pdf,
      log,
      errors,
      compileTime,
      synctex,
      preambleSnapshot,
    }
    if (data.engineCommands) {
      result.engineCommands = data.engineCommands
    }
    if (data.inputFiles) {
      result.inputFiles = data.inputFiles
    }
    return result
  }

  async readFile(path: string): Promise<string | null> {
    this.checkInitialized()

    const data = await this.postMessageWithResponse({ cmd: 'readfile', url: path }, 'cmd:readfile')

    return data.result === 'ok' ? (data.data as string) : null
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
      this.pendingResponses.clear()
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
