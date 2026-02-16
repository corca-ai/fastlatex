import type * as Monaco from 'monaco-editor'
import { createEditor, revealLine, setEditorContent } from './editor/setup'
import { CompileScheduler } from './engine/compile-scheduler'
import { SwiftLatexEngine } from './engine/swiftlatex-engine'
import { VirtualFS } from './fs/virtual-fs'
import { parseAuxFile } from './lsp/aux-parser'
import { computeDiagnostics } from './lsp/diagnostic-provider'
import { ProjectIndex } from './lsp/project-index'
import { registerLatexProviders } from './lsp/register-providers'
import { initPerfOverlay, perf } from './perf/metrics'
import { SynctexParser } from './synctex/synctex-parser'
import type { AppStatus, CompileResult, LatexEditorEventMap, LatexEditorOptions } from './types'
import { ErrorLog } from './ui/error-log'
import { setDiagnosticMarkers, setErrorMarkers } from './ui/error-markers'
import { FileTree } from './ui/file-tree'
import { setupDividers } from './ui/layout'
import { PdfViewer } from './viewer/pdf-viewer'

type EventHandler<T> = (event: T) => void

export class LatexEditor {
  // --- Options ---
  private mainFile: string
  private opts: LatexEditorOptions

  // --- DOM ---
  private root: HTMLElement
  private statusEl!: HTMLElement

  // --- Components ---
  private engine: SwiftLatexEngine
  private fs: VirtualFS
  private synctexParser = new SynctexParser()
  private pdfViewer!: PdfViewer
  private errorLog!: ErrorLog
  private fileTree!: FileTree
  private scheduler!: CompileScheduler
  private editor!: Monaco.editor.IStandaloneCodeEditor
  private projectIndex = new ProjectIndex()
  private lspDisposables: { dispose(): void }[] = []

  // --- State ---
  private currentFile: string
  private pendingRecompile = false
  private editorChangeDisposable: { dispose(): void } | null = null
  private forwardSearchTimer: ReturnType<typeof setTimeout> | null = null
  private lastForwardLine = -1
  private disposed = false

  // --- Events ---
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous event map
  private listeners = new Map<string, Set<EventHandler<any>>>()

  constructor(container: HTMLElement, options?: LatexEditorOptions) {
    this.opts = options ?? {}
    this.mainFile = this.opts.mainFile ?? 'main.tex'
    this.currentFile = this.mainFile

    // Create engine
    const engineOpts: import('./engine/swiftlatex-engine').SwiftLatexEngineOptions = {}
    if (this.opts.assetBaseUrl) engineOpts.assetBaseUrl = this.opts.assetBaseUrl
    if (this.opts.texliveUrl) engineOpts.texliveUrl = this.opts.texliveUrl
    this.engine = new SwiftLatexEngine(engineOpts)

    // Create VFS
    if (this.opts.files) {
      this.fs = new VirtualFS({ empty: true })
      for (const [path, content] of Object.entries(this.opts.files)) {
        this.fs.writeFile(path, content)
      }
    } else {
      this.fs = new VirtualFS()
    }

    // Build DOM
    this.root = this.createDOM(container)

    // Initialize sub-components
    this.initComponents()
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  async init(): Promise<void> {
    this.setStatus('loading')

    try {
      await this.engine.init()
      this.setStatus('ready')

      // Write all FS files to engine and compile
      for (const path of this.fs.listFiles()) {
        const file = this.fs.getFile(path)!
        this.engine.writeFile(path, file.content)
      }
      this.fs.markSynced()

      this.engine.setMainFile(this.mainFile)
      const result = await this.engine.compile()
      this.onCompileResult(result)
    } catch (err) {
      console.error('Engine initialization failed:', err)
      this.setStatus('error', String(err))
    }
  }

  // --- File management ---

  loadProject(files: Record<string, string | Uint8Array>): void {
    // Clear existing files and index
    for (const path of this.fs.listFiles()) {
      this.fs.deleteFile(path)
      this.projectIndex.removeFile(path)
    }
    // Load new files
    for (const [path, content] of Object.entries(files)) {
      this.fs.writeFile(path, content)
      if (typeof content === 'string') {
        this.projectIndex.updateFile(path, content)
      }
    }
    // Switch editor to main file
    this.currentFile = this.mainFile
    const file = this.fs.getFile(this.currentFile)
    if (file && this.editor) {
      const content =
        typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content)
      setEditorContent(
        this.editor,
        content,
        this.currentFile.endsWith('.tex') ? 'latex' : 'plaintext',
        this.currentFile,
      )
      this.reattachEditorChangeHandler()
    }
    // Sync and compile
    this.syncAndCompile()
  }

  saveProject(): Record<string, string | Uint8Array> {
    // Save current editor content
    if (this.editor) {
      this.fs.writeFile(this.currentFile, this.editor.getValue())
    }
    const result: Record<string, string | Uint8Array> = {}
    for (const path of this.fs.listFiles()) {
      const file = this.fs.getFile(path)
      if (file) result[path] = file.content
    }
    return result
  }

  setFile(path: string, content: string | Uint8Array): void {
    this.fs.writeFile(path, content)
    if (typeof content === 'string' && path.endsWith('.tex')) {
      this.projectIndex.updateFile(path, content)
    }
    if (path === this.currentFile && this.editor) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
      setEditorContent(this.editor, text, path.endsWith('.tex') ? 'latex' : 'plaintext')
      this.reattachEditorChangeHandler()
    }
    this.emit('filechange', { path, content })
  }

  getFile(path: string): string | Uint8Array | null {
    return this.fs.readFile(path)
  }

  deleteFile(path: string): boolean {
    return this.fs.deleteFile(path)
  }

  listFiles(): string[] {
    return this.fs.listFiles()
  }

  // --- Compilation ---

  compile(): void {
    this.syncAndCompile()
    this.scheduler.flush()
  }

  getPdf(): Uint8Array | null {
    return this.pdfViewer.getLastPdf()
  }

  // --- Events ---

  on<K extends keyof LatexEditorEventMap>(
    event: K,
    handler: EventHandler<LatexEditorEventMap[K]>,
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
  }

  off<K extends keyof LatexEditorEventMap>(
    event: K,
    handler: EventHandler<LatexEditorEventMap[K]>,
  ): void {
    this.listeners.get(event)?.delete(handler)
  }

  // --- Escape hatches ---

  getMonacoEditor(): Monaco.editor.IStandaloneCodeEditor {
    return this.editor
  }

  getViewer(): PdfViewer {
    return this.pdfViewer
  }

  // --- Cleanup ---

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scheduler.cancel()
    for (const d of this.lspDisposables) d.dispose()
    this.lspDisposables = []
    this.editorChangeDisposable?.dispose()
    this.editor?.dispose()
    this.engine.terminate()
    this.listeners.clear()
    this.root.remove()
  }

  // ------------------------------------------------------------------
  // Private: DOM
  // ------------------------------------------------------------------

  private createDOM(container: HTMLElement): HTMLElement {
    const root = document.createElement('div')
    root.className = 'le-root'

    root.innerHTML = `
      <div class="le-toolbar" id="toolbar">
        <span class="le-status" id="status">Loading...</span>
      </div>
      <div class="le-main" id="main-container">
        <div class="le-file-tree panel" id="file-tree-panel"></div>
        <div class="le-divider-left divider"></div>
        <div class="le-editor panel" id="editor-panel"></div>
        <div class="le-divider-right divider"></div>
        <div class="le-viewer panel" id="viewer-panel"></div>
      </div>
      <div class="le-error-log" id="error-log-panel"></div>
    `

    container.appendChild(root)
    return root
  }

  // ------------------------------------------------------------------
  // Private: Component init
  // ------------------------------------------------------------------

  private initComponents(): void {
    this.statusEl = this.root.querySelector<HTMLElement>('.le-status')!

    // PDF Viewer
    const viewerContainer = this.root.querySelector<HTMLElement>('.le-viewer')!
    this.pdfViewer = new PdfViewer(viewerContainer)

    // Inverse search
    this.pdfViewer.setInverseSearchHandler((loc) => {
      if (loc.file !== this.currentFile) {
        this.onFileSelect(loc.file)
      }
      revealLine(this.editor, loc.line)
    })

    // Error Log
    const errorLogContainer = this.root.querySelector<HTMLElement>('.le-error-log')!
    this.errorLog = new ErrorLog(errorLogContainer, (line) => {
      revealLine(this.editor, line)
    })

    // Compile Scheduler
    this.scheduler = new CompileScheduler(
      this.engine,
      (result) => this.onCompileResult(result),
      (status) => this.setStatus(status),
      { minDebounceMs: 50, maxDebounceMs: 1000 },
    )

    // Editor
    const editorContainer = this.root.querySelector<HTMLElement>('.le-editor')!
    const initialContent = (this.fs.readFile(this.currentFile) as string) ?? ''
    this.editor = createEditor(
      editorContainer,
      initialContent,
      (content) => this.onEditorChange(content),
      this.currentFile,
    )

    // File Tree
    const fileTreeContainer = this.root.querySelector<HTMLElement>('.le-file-tree')!
    this.fileTree = new FileTree(fileTreeContainer, this.fs, (path) => this.onFileSelect(path))

    // Forward search (auto on cursor move, debounced)
    this.editor.onDidChangeCursorPosition(() => {
      const line = this.editor.getPosition()?.lineNumber
      if (!line || line === this.lastForwardLine) return
      this.lastForwardLine = line
      if (this.forwardSearchTimer) clearTimeout(this.forwardSearchTimer)
      this.forwardSearchTimer = setTimeout(() => {
        this.pdfViewer.forwardSearch(this.currentFile, line)
      }, 100)
    })

    // Ctrl+S: flush debounce and compile immediately
    this.editor.addAction({
      id: 'latex.save-compile',
      label: 'Save & Compile',
      keybindings: [2048 /* CtrlCmd */ | 49 /* KeyS */],
      run: () => {
        this.syncAndCompile()
        this.scheduler.flush()
      },
    })

    // PDF Download button
    const downloadBtn = document.createElement('button')
    downloadBtn.textContent = 'PDF'
    downloadBtn.title = 'Download PDF'
    downloadBtn.style.cssText =
      'margin-left:auto;background:#404040;border:none;color:#ccc;padding:2px 8px;cursor:pointer;border-radius:3px;font-size:12px;'
    downloadBtn.onclick = () => this.downloadPdf()
    this.root.querySelector<HTMLElement>('.le-toolbar')!.appendChild(downloadBtn)

    // Register LSP providers
    this.lspDisposables = registerLatexProviders(this.projectIndex, this.fs)

    // Index initial files
    for (const path of this.fs.listFiles()) {
      const file = this.fs.getFile(path)
      if (file && typeof file.content === 'string') {
        this.projectIndex.updateFile(path, file.content)
      }
    }

    // Layout dividers
    setupDividers(this.root)

    // Perf overlay (activate with ?perf=1)
    initPerfOverlay()

    // Service Worker
    if (this.opts.serviceWorker !== false && 'serviceWorker' in navigator) {
      const base = this.opts.assetBaseUrl ?? import.meta.env.BASE_URL
      navigator.serviceWorker.register(`${base}sw.js`).catch((err) => {
        console.warn('SW registration failed:', err)
      })
    }
  }

  // ------------------------------------------------------------------
  // Private: Core logic (ported from main.ts)
  // ------------------------------------------------------------------

  private setStatus(status: AppStatus, detail?: string): void {
    this.statusEl.className = `le-status ${status}`
    const labels: Record<AppStatus, string> = {
      unloaded: 'Initializing...',
      loading: 'Loading engine...',
      ready: 'Ready',
      compiling: 'Compiling...',
      error: 'Error',
      rendering: 'Rendering PDF...',
    }
    const label = detail ? `${labels[status]} ${detail}` : labels[status]
    this.statusEl.textContent = label
    this.pdfViewer.setLoadingStatus(label)
    this.emit('status', { status })
  }

  private syncAndCompile(): void {
    const status = this.engine.getStatus()
    if (status === 'unloaded' || status === 'loading' || status === 'error') return

    for (const file of this.fs.getModifiedFiles()) {
      this.engine.writeFile(file.path, file.content)
    }
    this.fs.markSynced()

    this.engine.setMainFile(this.mainFile)
    this.scheduler.schedule()
  }

  private onEditorChange(content: string): void {
    perf.mark('total')
    perf.mark('debounce')
    this.fs.writeFile(this.currentFile, content)
    this.projectIndex.updateFile(this.currentFile, content)
    this.runDiagnostics()
    this.emit('filechange', { path: this.currentFile, content })
    this.syncAndCompile()
  }

  private onFileSelect(path: string): void {
    // Save current editor content and update index
    if (this.editor) {
      const value = this.editor.getValue()
      this.fs.writeFile(this.currentFile, value)
      this.projectIndex.updateFile(this.currentFile, value)
    }

    this.currentFile = path
    const file = this.fs.getFile(path)
    if (file && this.editor) {
      const content =
        typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content)
      setEditorContent(this.editor, content, path.endsWith('.tex') ? 'latex' : 'plaintext', path)
      this.reattachEditorChangeHandler()
    }
    this.fileTree.setActive(path)
  }

  private reattachEditorChangeHandler(): void {
    if (this.editorChangeDisposable) this.editorChangeDisposable.dispose()
    this.editorChangeDisposable = this.editor.onDidChangeModelContent(() => {
      this.onEditorChange(this.editor.getValue())
    })
  }

  private updateEngineMetadata(result: CompileResult): void {
    if (result.engineCommands?.length) {
      this.projectIndex.updateEngineCommands(result.engineCommands)
    }
    if (result.log) {
      this.projectIndex.updateLogData(result.log)
    }
    if (result.inputFiles?.length) {
      this.projectIndex.updateInputFiles(result.inputFiles)
      for (const path of result.inputFiles) {
        if (!this.projectIndex.getFileSymbols(path)) {
          const file = this.fs.getFile(path)
          if (file && typeof file.content === 'string') {
            this.projectIndex.updateFile(path, file.content)
          }
        }
      }
    }
  }

  private onCompileResult(result: CompileResult): void {
    perf.end('compile')

    const detail = result.preambleSnapshot ? '(cached preamble)' : undefined

    this.updateEngineMetadata(result)

    if (result.success && result.pdf) {
      for (const path of this.fs.listFiles()) {
        const file = this.fs.getFile(path)
        if (file && typeof file.content === 'string') {
          this.pdfViewer.setSourceContent(path, file.content)
        }
      }
      this.handleSynctex(result)

      this.setStatus('rendering')
      perf.mark('render')
      this.pdfViewer.render(result.pdf).then(() => {
        perf.end('render')
        perf.end('total')
        this.setStatus('ready', detail)
      })
    } else {
      perf.end('total')
      this.setStatus(result.errors.length > 0 ? 'error' : 'ready')
    }

    this.errorLog.update(result.errors)
    setErrorMarkers(this.editor, result.errors)
    this.updateAuxIndex()
    this.runDiagnostics()
    this.maybeRecompile(result)
    this.emit('compile', { result })
  }

  private handleSynctex(result: CompileResult): void {
    if (result.synctex) {
      perf.mark('synctex-parse')
      this.synctexParser
        .parse(result.synctex)
        .then((synctexData) => {
          perf.end('synctex-parse')
          this.pdfViewer.setSynctexData(synctexData)
        })
        .catch((err) => {
          perf.end('synctex-parse')
          console.warn('SyncTeX parse failed, using text-mapper fallback:', err)
          this.pdfViewer.setSynctexData(null)
        })
    } else {
      this.pdfViewer.setSynctexData(null)
    }
  }

  private maybeRecompile(result: CompileResult): void {
    if (
      !this.pendingRecompile &&
      result.success &&
      result.log?.includes('Rerun to get cross-references right')
    ) {
      this.pendingRecompile = true
      this.engine.compile().then((r) => {
        this.pendingRecompile = false
        this.onCompileResult(r)
        // Re-schedule: maybeRecompile bypasses the scheduler, so the engine
        // was 'compiling' while the scheduler didn't know. If the user edited
        // during the recompile, the scheduler's debounced compile was silently
        // dropped (engine not ready at line 54 of compile-scheduler). This
        // re-schedule picks up any such dropped edits.
        this.syncAndCompile()
      })
    } else {
      this.pendingRecompile = false
    }
  }

  private updateAuxIndex(): void {
    // Read .aux file from engine after compilation
    const mainBase = this.mainFile.replace(/\.tex$/, '')
    this.engine
      .readFile(`${mainBase}.aux`)
      .then((auxContent) => {
        if (!auxContent) return
        const auxData = parseAuxFile(auxContent)
        // Read sub-aux files referenced by \@input{...}
        const pending = auxData.includes.map((inc) =>
          this.engine.readFile(inc).then((sub) => (sub ? parseAuxFile(sub) : null)),
        )
        Promise.all(pending).then((subResults) => {
          for (const sub of subResults) {
            if (!sub) continue
            for (const [k, v] of sub.labels) auxData.labels.set(k, v)
            for (const c of sub.citations) auxData.citations.add(c)
          }
          this.projectIndex.updateAuxData(auxData)
          this.runDiagnostics()
        })
      })
      .catch(() => {
        // .aux file may not exist on first compile or after errors
      })
  }

  private runDiagnostics(): void {
    const diagnostics = computeDiagnostics(this.projectIndex)
    setDiagnosticMarkers(diagnostics)
  }

  private downloadPdf(): void {
    const data = this.pdfViewer.getLastPdf()
    if (!data) return
    const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'output.pdf'
    a.click()
    URL.revokeObjectURL(url)
  }

  // ------------------------------------------------------------------
  // Private: Event emitter
  // ------------------------------------------------------------------

  private emit<K extends keyof LatexEditorEventMap>(event: K, data: LatexEditorEventMap[K]): void {
    const handlers = this.listeners.get(event)
    if (handlers) {
      for (const fn of handlers) fn(data)
    }
  }
}
