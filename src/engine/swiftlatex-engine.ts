import type { CompileResult, TexliveVersion, WarmupCache } from '../types'
import { BaseWorkerEngine, resolveTexliveUrl } from './base-worker-engine'
import { fetchGzWithFallback, readStreamToBuffer } from './fetch-gz'
import { parseTexErrors } from './parse-errors'

export interface SwiftLatexEngineOptions {
  /** TeX Live version to use. Defaults to '2025'. */
  texliveVersion?: TexliveVersion
  /** Base URL for WASM assets. Defaults to `import.meta.env.BASE_URL`. */
  assetBaseUrl?: string
  /** TexLive server endpoint. Defaults to `${location.origin}${BASE_URL}texlive/`. */
  texliveUrl?: string
  /** If true, do not attempt to preload the base .fmt file. */
  skipFormatPreload?: boolean
  /** Pre-fetched TeX Live files from `warmup()`. */
  warmupCache?: WarmupCache
}

/** Counter for unique message IDs. */
let nextMsgId = 1

/** Incoming response message from the WASM worker. */
interface WorkerMessage {
  result?: string
  status?: number
  cmd?: string
  msgId?: string
  file?: string
  log?: string
  pdf?: ArrayBuffer
  synctex?: ArrayBuffer
  format?: ArrayBuffer
  data?: string
  preambleSnapshot?: boolean
  engineCommands?: string[]
  inputFiles?: string[]
  semanticTrace?: string
}

export class SwiftLatexEngine extends BaseWorkerEngine<WorkerMessage> {
  private formatPath: string
  private skipFormatPreload: boolean
  private version: TexliveVersion
  private warmupCache: WarmupCache | undefined

  public onFileDownload?: (filename: string) => void

  constructor(options?: SwiftLatexEngineOptions) {
    const base = options?.assetBaseUrl ?? import.meta.env.BASE_URL
    const version = options?.texliveVersion ?? '2025'
    super(`${base}swiftlatex/${version}/swiftlatexpdftex.js`, options?.texliveUrl ?? null)
    this.formatPath = `${base}swiftlatex/${version}/swiftlatexpdftex.fmt`
    this.skipFormatPreload = !!options?.skipFormatPreload
    this.version = version
    this.warmupCache = options?.warmupCache
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
    const texliveUrl = resolveTexliveUrl(this.texliveUrl, this.version)
    this.worker!.postMessage({ cmd: 'settexliveurl', url: texliveUrl })

    // Inject warmup cache (pre-fetched files + 404 entries) before other preloads
    if (this.warmupCache) {
      await this.injectWarmupCache(this.warmupCache)
    }

    // Pre-load format and pdftex.map in parallel
    const preloads: Promise<void>[] = [
      this.preloadTexliveFile(
        11,
        'pdftex.map',
        `${resolveTexliveUrl(this.texliveUrl, this.version)}pdftex/11/pdftex.map`,
      ),
    ]
    if (!this.skipFormatPreload) {
      preloads.push(this.preloadFormat())
    }
    await Promise.all(preloads)
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
      if (data.cmd === 'downloading' && data.file) {
        this.onFileDownload?.(data.file)
        return
      }

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
      const buf = await this.fetchGzWithProgress(this.formatPath)
      if (!buf) return
      await this.postMessageWithResponse({ cmd: 'loadformat', data: buf }, 'cmd:loadformat', [buf])
    } catch {
      // Format not available — worker will try building one at compile time
    }
  }

  /** Pre-load a texlive file into the worker's MEMFS cache. */
  private async preloadTexliveFile(format: number, filename: string, url: string): Promise<void> {
    try {
      const buf = await fetchGzWithFallback(url)
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

  /** Inject pre-fetched warmup cache into the worker. */
  private async injectWarmupCache(cache: WarmupCache): Promise<void> {
    const promises: Promise<unknown>[] = []

    // Send each cached file to the worker via preloadtexlive.
    // Copy each buffer so the original cache stays usable across multiple init() calls.
    for (const file of cache.files) {
      const msgId = `msg-${nextMsgId++}`
      const buf = file.data.slice(0)
      promises.push(
        this.postMessageWithResponse(
          { cmd: 'preloadtexlive', format: file.format, filename: file.filename, data: buf, msgId },
          msgId,
          [buf],
        ),
      )
    }

    // Send 404 entries in a single batch.
    // Uses a timeout because old pre-built WASM workers won't have the
    // preload404 command and will silently ignore it (no response).
    if (cache.notFound.length > 0) {
      const msgId = `msg-${nextMsgId++}`
      const preload404 = this.postMessageWithResponse(
        { cmd: 'preload404', entries: cache.notFound, msgId },
        msgId,
      )
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
      promises.push(Promise.race([preload404, timeout]))
    }

    await Promise.all(promises)
  }

  /**
   * Try fetching url.gz first (with DecompressionStream), fall back to raw url.
   * Wraps the shared fetchGzWithFallback with download-progress tracking for
   * the .fmt preload.
   */
  private async fetchGzWithProgress(url: string): Promise<ArrayBuffer | null> {
    if (typeof DecompressionStream !== 'undefined' && this.onProgress) {
      try {
        const resp = await fetch(`${url}.gz`)
        if (resp.ok) {
          return await this.decompressWithProgress(resp)
        }
      } catch {
        // .gz fetch or decompress failed — try shared fallback
      }
    }
    return fetchGzWithFallback(url)
  }

  private async decompressWithProgress(resp: Response): Promise<ArrayBuffer> {
    const ds = new DecompressionStream('gzip')
    const contentLength = Number.parseInt(resp.headers.get('Content-Length') || '0', 10)
    let loaded = 0
    const engine = this

    const progressStream = new ReadableStream({
      async start(controller) {
        const reader = resp.body!.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          loaded += value.length
          if (contentLength && engine.onProgress) {
            engine.onProgress(Math.round((loaded / contentLength) * 100))
          }
          controller.enqueue(value)
        }
        controller.close()
      },
    })

    return readStreamToBuffer(progressStream.pipeThrough(ds))
  }

  async mkdir(path: string): Promise<void> {
    this.checkInitialized()
    await this.postMessageWithResponse({ cmd: 'mkdir', url: path }, 'cmd:mkdir')
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.checkInitialized()
    await this.postMessageWithResponse(
      { cmd: 'writefile', url: path, src: content },
      'cmd:writefile',
    )
  }

  setMainFile(path: string): void {
    this.checkInitialized()
    this.worker!.postMessage({ cmd: 'setmainfile', url: path })
  }

  async flushCache(): Promise<void> {
    this.checkInitialized()
    this.worker!.postMessage({ cmd: 'flushcache' })
  }

  async compile(): Promise<CompileResult> {
    this.checkReady()
    this.status = 'compiling'

    const start = performance.now()

    const data = await this.postMessageWithResponse({ cmd: 'compilelatex' }, 'cmd:compile')

    this.status = 'ready'
    const compileTime = performance.now() - start
    const log = data.log || ''
    // pdfTeX status 0 is success, 1 is warnings/non-fatal errors.
    // Both can produce valid PDF output.
    const success = data.result === 'ok' && (data.status === 0 || data.status === 1)
    const pdf = data.result === 'ok' || data.pdf ? new Uint8Array(data.pdf!) : null
    const synctex = data.result === 'ok' || data.synctex ? new Uint8Array(data.synctex!) : null
    const format = success && data.format ? new Uint8Array(data.format) : undefined
    const errors = parseTexErrors(log)
    const preambleSnapshot = !!data.preambleSnapshot

    const result: CompileResult = {
      success,
      pdf,
      log,
      errors,
      compileTime,
      synctex,
      format,
      preambleSnapshot,
    }
    if (data.engineCommands) {
      result.engineCommands = data.engineCommands
    }
    if (data.inputFiles) {
      result.inputFiles = data.inputFiles
    }
    if (data.semanticTrace) {
      result.semanticTrace = data.semanticTrace
    }
    return result
  }

  async readFile(path: string): Promise<string | null> {
    this.checkInitialized()

    const data = await this.postMessageWithResponse({ cmd: 'readfile', url: path }, 'cmd:readfile')

    return data.result === 'ok' ? (data.data ?? null) : null
  }

  isReady(): boolean {
    return this.status === 'ready'
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
