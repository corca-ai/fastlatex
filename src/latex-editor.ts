import type * as Monaco from 'monaco-editor'
import { createEditor, createFileModel, revealLine } from './editor/setup'
import { BibtexEngine } from './engine/bibtex-engine'
import { CompileScheduler } from './engine/compile-scheduler'
import { SwiftLatexEngine } from './engine/swiftlatex-engine'
import { VirtualFS } from './fs/virtual-fs'
import { parseAuxFile } from './lsp/aux-parser'
import { parseBibFile } from './lsp/bib-parser'
import { computeDiagnostics } from './lsp/diagnostic-provider'
import { ProjectIndex } from './lsp/project-index'
import { registerLatexProviders } from './lsp/register-providers'
import { parseTraceFile } from './lsp/trace-parser'
import { initPerfOverlay, perf } from './perf/metrics'
import { SynctexParser } from './synctex/synctex-parser'
import type {
  AppStatus,
  CompileResult,
  LatexEditorEventMap,
  LatexEditorOptions,
  TexError,
} from './types'
import { ErrorLog } from './ui/error-log'
import { setDiagnosticMarkers, setErrorMarkers } from './ui/error-markers'
import { FileTree } from './ui/file-tree'
import { setupDividers } from './ui/layout'
import { Outline } from './ui/outline'
import { PdfViewer } from './viewer/pdf-viewer'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.bmp', '.webp'])

function isImageFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return IMAGE_EXTENSIONS.has(name.substring(dot).toLowerCase())
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type EventHandler<T> = (event: T) => void

export class LatexEditor {
  // --- Options ---

  private mainFile: string

  private opts: LatexEditorOptions

  // --- DOM ---

  private root: HTMLElement

  // --- Components ---

  private engine: SwiftLatexEngine

  private fs: VirtualFS

  private synctexParser = new SynctexParser()

  private pdfViewer?: PdfViewer

  private errorLog?: ErrorLog

  private fileTree?: FileTree

  private outline?: Outline

  private scheduler!: CompileScheduler

  private editor!: Monaco.editor.IStandaloneCodeEditor

  private projectIndex = new ProjectIndex()

  private lspDisposables: { dispose(): void }[] = []

  // --- Models (one per project file, kept alive for cross-file diagnostics) ---

  private models = new Map<string, Monaco.editor.ITextModel>()

  // --- State ---

  private currentFile: string

  private pendingRecompile = false

  private editorChangeDisposable: { dispose(): void } | null = null

  private forwardSearchTimer: ReturnType<typeof setTimeout> | null = null

  private lastForwardLine = -1

  private lastForwardFile = ''

  private switchingModel = false

  private lastCompileErrors: TexError[] = []

  private previewEl: HTMLElement | null = null

  private bibtexEngine: BibtexEngine | null = null

  private bibtexDone = false

  private pendingBibtex = false

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

      // Create directories and write all FS files to engine

      const paths = this.fs.listFiles()

      this.ensureEngineDirectories(paths)

      for (const path of paths) {
        const file = this.fs.getFile(path)!

        this.engine.writeFile(path, file.content)
      }

      this.fs.markSynced()

      this.engine.setMainFile(this.mainFile)

      this.setStatus('compiling')

      const result = await this.engine.compile()

      this.onCompileResult(result)
    } catch (err) {
      console.error('Engine initialization failed:', err)

      this.setStatus('error', String(err))
    }
  }

  // --- File management ---

  /** Load a complete project state. */

  loadProject(files: Record<string, string | Uint8Array>): void {
    const oldPaths = new Set(this.models.keys())

    const newPaths = new Set(Object.keys(files))

    // Clear existing files and index

    for (const path of this.fs.listFiles()) {
      this.fs.deleteFile(path)

      this.projectIndex.removeFile(path)
    }

    this.updateModels(files, oldPaths, newPaths)

    this.updateBibIndex()

    this.bibtexDone = false

    // Switch editor to main file

    this.currentFile = this.mainFile

    this.lastForwardLine = -1

    this.lastForwardFile = ''

    const model = this.models.get(this.currentFile)

    if (model && this.editor) {
      this.switchingModel = true

      this.editor.setModel(model)

      this.switchingModel = false
    }

    this.emit('filesUpdate', { files: this.fs.listFiles() })

    this.outline?.update(this.currentFile)

    this.emitOutline()

    // Sync and compile

    this.syncAndCompile()
  }

  private updateModels(
    files: Record<string, string | Uint8Array>,

    oldPaths: Set<string>,

    newPaths: Set<string>,
  ): void {
    // Load new files, reuse or create models

    for (const [path, content] of Object.entries(files)) {
      this.fs.writeFile(path, content)

      if (typeof content === 'string') {
        if (path.endsWith('.tex')) {
          this.projectIndex.updateFile(path, content)
        }

        const existing = this.models.get(path)

        if (existing) {
          existing.setValue(content)
        } else {
          this.ensureModel(path, content)
        }
      }
    }

    // Dispose models for removed files

    for (const path of oldPaths) {
      if (!newPaths.has(path)) {
        this.disposeModel(path)
      }
    }
  }

  /** Export all project files. */

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

  /** Open a specific file in the editor. */

  openFile(path: string): void {
    this.onFileSelect(path)
  }

  /** Update or create a single file. */

  setFile(path: string, content: string | Uint8Array): void {
    const isNew = !this.fs.getFile(path)

    this.fs.writeFile(path, content)

    if (typeof content === 'string') {
      if (path.endsWith('.tex')) {
        this.projectIndex.updateFile(path, content)
      }

      if (path.endsWith('.bib')) {
        this.updateBibIndex()
      }

      const model = this.models.get(path)

      if (model) {
        model.setValue(content)
      } else {
        this.ensureModel(path, content)
      }
    }

    this.emit('filechange', { path, content })

    if (isNew) {
      this.emit('filesUpdate', { files: this.fs.listFiles() })
    }

    if (path === this.currentFile) {
      this.outline?.update(path)

      this.emitOutline()
    }
  }

  /** Read file content. */

  getFile(path: string): string | Uint8Array | null {
    return this.fs.readFile(path)
  }

  /** Delete a file. */

  deleteFile(path: string): boolean {
    this.disposeModel(path)

    this.projectIndex.removeFile(path)

    const deleted = this.fs.deleteFile(path)

    if (deleted) {
      this.emit('filesUpdate', { files: this.fs.listFiles() })

      if (this.currentFile === path) {
        this.openFile(this.mainFile)
      }
    }

    return deleted
  }

  /** Create a folder (represented by a .gitkeep file). */

  createFolder(path: string): void {
    const folderPath = path.replace(/\/+$/, '')

    this.setFile(`${folderPath}/.gitkeep`, '')
  }

  /** List all files in the project. */

  listFiles(): string[] {
    return this.fs.listFiles()
  }

  // --- Compilation ---

  /** Trigger an immediate compilation. */

  compile(): void {
    this.syncAndCompile()

    this.scheduler.flush()
  }

  /** Get the last rendered PDF as bytes. */

  getPdf(): Uint8Array | null {
    return this.pdfViewer?.getLastPdf() ?? null
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

  /** Get the raw Monaco editor instance. */

  getMonacoEditor(): Monaco.editor.IStandaloneCodeEditor {
    return this.editor
  }

  /** Get the built-in PDF viewer instance (if not in headless mode). */

  getViewer(): PdfViewer | undefined {
    return this.pdfViewer
  }

  /** Jump the editor to a specific line. */

  revealLine(line: number, file?: string): void {
    if (file && file !== this.currentFile) {
      this.openFile(file)

      requestAnimationFrame(() => revealLine(this.editor, line))
    } else {
      revealLine(this.editor, line)
    }
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

    for (const model of this.models.values()) model.dispose()

    this.models.clear()

    this.engine.terminate()

    this.bibtexEngine?.terminate()

    this.listeners.clear()

    this.root.remove()
  }

  // ------------------------------------------------------------------

  // Private: Model management

  // ------------------------------------------------------------------

  private ensureModel(path: string, content: string): Monaco.editor.ITextModel {
    let model = this.models.get(path)

    if (!model) {
      model = createFileModel(content, path)

      this.models.set(path, model)
    }

    return model
  }

  private disposeModel(path: string): void {
    const model = this.models.get(path)

    if (model) {
      model.dispose()

      this.models.delete(path)
    }
  }

  // ------------------------------------------------------------------

  // Private: DOM

  // ------------------------------------------------------------------

  private createDOM(container: HTMLElement): HTMLElement {
    const root = document.createElement('div')

    root.className = 'le-root'

    if (this.opts.headless) {
      // Just a simple wrapper for Monaco

      root.innerHTML = '<div class="le-editor" id="editor-panel"></div>'
    } else {
      root.innerHTML = `

        <div class="le-main" id="main-container">

          <div class="le-left-panel panel" id="left-panel">

            <div class="le-file-tree" id="file-tree-container"></div>

            <div class="le-outline" id="outline-container"></div>

          </div>

          <div class="le-divider-left divider"></div>

          <div class="le-editor panel" id="editor-panel"></div>

          <div class="le-divider-right divider"></div>

          <div class="le-viewer panel" id="viewer-panel"></div>

        </div>

        <div class="le-error-log" id="error-log-panel"></div>

      `
    }

    container.appendChild(root)

    return root
  }

  // ------------------------------------------------------------------

  // Private: Component init

  // ------------------------------------------------------------------

  private initComponents(): void {
    const isHeadless = !!this.opts.headless

    if (!isHeadless) {
      // PDF Viewer

      const viewerContainer = this.root.querySelector<HTMLElement>('.le-viewer')!

      this.pdfViewer = new PdfViewer(viewerContainer)

      // Inverse search (PDF click → source)

      this.pdfViewer.setInverseSearchHandler((loc) => {
        this.revealLine(loc.line, loc.file)
      })

      // Error Log

      const errorLogContainer = this.root.querySelector<HTMLElement>('.le-error-log')!

      this.errorLog = new ErrorLog(errorLogContainer, (file, line) => {
        this.revealLine(line, file)
      })
    }

    // Compile Scheduler

    this.scheduler = new CompileScheduler(
      this.engine,

      (result) => this.onCompileResult(result),

      (status, detail) => this.setStatus(status, detail),

      { minDebounceMs: 50, maxDebounceMs: 1000 },
    )

    // Create models for all text files and index .tex files

    for (const path of this.fs.listFiles()) {
      const file = this.fs.getFile(path)

      if (file && typeof file.content === 'string') {
        this.ensureModel(path, file.content)

        if (path.endsWith('.tex')) {
          this.projectIndex.updateFile(path, file.content)
        }
      }
    }

    this.updateBibIndex()

    // Ensure current file has a model (even if empty)

    if (!this.models.has(this.currentFile)) {
      this.ensureModel(this.currentFile, '')
    }

    // Editor (uses pre-created model)

    const editorContainer = this.root.querySelector<HTMLElement>('.le-editor')!

    this.editor = createEditor(editorContainer, this.models.get(this.currentFile)!)

    // Support cross-file navigation (Goto Definition)

    const editorService = (this.editor as any)._codeEditorService

    const originalOpenCodeEditor = editorService.openCodeEditor.bind(editorService)

    editorService.openCodeEditor = async (input: any, source: any, sideBySide: any) => {
      const result = await originalOpenCodeEditor(input, source, sideBySide)

      if (!result && input.resource) {
        const uri = input.resource.toString()

        for (const [path, model] of this.models.entries()) {
          if (model.uri.toString() === uri) {
            this.onFileSelect(path)

            if (input.options?.selection) {
              const range = input.options.selection

              this.editor.setSelection(range)

              this.editor.revealRangeInCenter(range)
            }

            return true
          }
        }
      }

      return result
    }

    if (!isHeadless) {
      // File Tree

      const fileTreeContainer = this.root.querySelector<HTMLElement>('.le-file-tree')!

      this.fileTree = new FileTree(fileTreeContainer, this.fs, (path) => this.onFileSelect(path))

      // Outline

      const outlineContainer = this.root.querySelector<HTMLElement>('.le-outline')!

      this.outline = new Outline(outlineContainer, this.projectIndex, (line) =>
        revealLine(this.editor, line),
      )

      this.outline.update(this.currentFile)
    }

    // Binary file preview overlay

    this.previewEl = document.createElement('div')

    this.previewEl.className = 'binary-preview'

    this.previewEl.style.display = 'none'

    editorContainer.appendChild(this.previewEl)

    // Single change handler — works across all model switches

    this.editorChangeDisposable = this.editor.onDidChangeModelContent(() => {
      this.onEditorChange(this.editor.getValue())
    })

    // Sync state when model changes (e.g. Goto Definition)

    this.editor.onDidChangeModel(() => {
      const model = this.editor.getModel()

      if (this.switchingModel) return

      if (!model) return

      for (const [path, m] of this.models.entries()) {
        if (m === model) {
          if (this.currentFile !== path) {
            this.currentFile = path

            this.fileTree?.setActive(path)

            this.outline?.update(path)

            this.emitOutline()

            this.runDiagnostics()
          }

          break
        }
      }
    })

    // Forward search (auto on cursor move, debounced)

    this.editor.onDidChangeCursorPosition(() => {
      if (this.switchingModel) return

      const pos = this.editor.getPosition()

      if (!pos) return

      // Update outline highlight

      this.outline?.setActiveLine(pos.lineNumber)

      this.emit('cursorChange', {
        path: this.currentFile,
        line: pos.lineNumber,
        column: pos.column,
      })

      if (pos.lineNumber === this.lastForwardLine && this.currentFile === this.lastForwardFile)
        return

      this.lastForwardLine = pos.lineNumber

      this.lastForwardFile = this.currentFile

      if (this.forwardSearchTimer) clearTimeout(this.forwardSearchTimer)

      this.forwardSearchTimer = setTimeout(() => {
        this.pdfViewer?.forwardSearch(this.currentFile, pos.lineNumber)
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

    if (!isHeadless) {
      // PDF Download button (in PDF viewer overlay)

      this.pdfViewer?.setDownloadHandler(() => this.downloadPdf())

      // Layout dividers

      setupDividers(this.root)
    }

    // Register LSP providers

    this.lspDisposables = registerLatexProviders(this.projectIndex, this.fs)

    // Perf overlay (activate with ?perf=1)

    initPerfOverlay()

    // Suppress Monaco's internal "Canceled" promise rejections on model switch

    window.addEventListener('unhandledrejection', (e) => {
      if (e.reason?.message === 'Canceled') e.preventDefault()
    })

    // Service Worker

    if (this.opts.serviceWorker !== false && 'serviceWorker' in navigator) {
      const base = this.opts.assetBaseUrl ?? import.meta.env.BASE_URL

      navigator.serviceWorker.register(`${base}sw.js`).catch((err) => {
        console.warn('SW registration failed:', err)
      })
    }
  }

  // ------------------------------------------------------------------

  // Private: Core logic

  // ------------------------------------------------------------------

  private setStatus(status: AppStatus, detail?: string): void {
    if (this.pdfViewer) {
      const labels: Record<AppStatus, string> = {
        unloaded: 'Initializing...',

        loading: 'Loading engine...',

        ready: 'Ready',

        compiling: 'Compiling...',

        error: 'Error',

        rendering: 'Rendering PDF...',
      }

      const label = detail ? `${labels[status]} ${detail}` : labels[status]

      this.pdfViewer.setLoadingStatus(label)
    }

    const payload: { status: AppStatus; detail?: string } = { status }

    if (detail !== undefined) payload.detail = detail

    this.emit('status', payload)
  }

  private syncAndCompile(): void {
    const status = this.engine.getStatus()

    if (status === 'unloaded' || status === 'loading' || status === 'error') return

    const modified = this.fs.getModifiedFiles()

    this.ensureEngineDirectories(modified.map((f) => f.path))

    for (const file of modified) {
      this.engine.writeFile(file.path, file.content)
    }

    this.fs.markSynced()

    this.engine.setMainFile(this.mainFile)

    this.scheduler.schedule()
  }

  private ensureEngineDirectories(paths: string[]): void {
    const dirs = new Set<string>()

    for (const p of paths) {
      const parts = p.split('/')

      let dir = ''

      for (let i = 0; i < parts.length - 1; i++) {
        dir = dir ? `${dir}/${parts[i]!}` : parts[i]!

        dirs.add(dir)
      }
    }

    for (const dir of Array.from(dirs).sort()) {
      this.engine.mkdir(dir)
    }
  }

  private onEditorChange(content: string): void {
    if (this.previewEl && this.previewEl.style.display !== 'none') return

    perf.mark('total')

    perf.mark('debounce')

    this.bibtexDone = false

    this.fs.writeFile(this.currentFile, content)

    if (this.currentFile.endsWith('.tex')) {
      this.projectIndex.updateFile(this.currentFile, content)
    }

    if (this.currentFile.endsWith('.bib')) {
      this.updateBibIndex()
    }

    this.outline?.update(this.currentFile)

    this.emitOutline()

    this.runDiagnostics()

    this.emit('filechange', { path: this.currentFile, content })

    this.syncAndCompile()
  }

  private onFileSelect(path: string): void {
    // Ignore files that don't exist in VFS (e.g. main.bbl from SyncTeX inverse search)

    const target = this.fs.getFile(path)

    if (!target) return

    // Save current editor content if we were editing text (not previewing binary)

    const wasPreviewingBinary = this.previewEl && this.previewEl.style.display !== 'none'

    if (this.editor && !wasPreviewingBinary) {
      const value = this.editor.getValue()

      this.fs.writeFile(this.currentFile, value)

      if (this.currentFile.endsWith('.tex')) {
        this.projectIndex.updateFile(this.currentFile, value)
      }
    }

    this.currentFile = path

    this.lastForwardLine = -1

    this.lastForwardFile = ''

    if (target.content instanceof Uint8Array) {
      // Binary file — show preview instead of Monaco

      this.showBinaryPreview(path, target.content)

      this.fileTree?.setActive(path)

      return
    }

    // Text file — hide preview, restore editor

    this.hideBinaryPreview()

    // Ensure model exists (file may have been added externally)

    if (typeof target.content === 'string' && !this.models.has(path)) {
      this.ensureModel(path, target.content)
    }

    const model = this.models.get(path)

    if (model && this.editor) {
      // Suppress cursor-change events during model switch to avoid

      // spurious forward searches and Monaco Delayer "Canceled" rejections

      this.switchingModel = true

      this.editor.setModel(model)

      this.switchingModel = false
    }

    this.fileTree?.setActive(path)

    this.outline?.update(path)

    this.emitOutline()

    this.runDiagnostics()
  }

  private showBinaryPreview(path: string, data: Uint8Array): void {
    if (!this.previewEl) return

    this.previewEl.innerHTML = ''

    if (isImageFile(path)) {
      const blob = new Blob([data.buffer as ArrayBuffer])

      const url = URL.createObjectURL(blob)

      const img = document.createElement('img')

      img.src = url

      img.className = 'binary-preview-img'

      img.onload = () => URL.revokeObjectURL(url)

      this.previewEl.appendChild(img)
    } else {
      const info = document.createElement('div')

      info.className = 'binary-preview-info'

      const ext = path.substring(path.lastIndexOf('.'))

      info.textContent = `${ext.toUpperCase()} file \u2014 ${formatBytes(data.length)}`

      this.previewEl.appendChild(info)
    }

    this.previewEl.style.display = 'flex'
  }

  private hideBinaryPreview(): void {
    if (this.previewEl) {
      this.previewEl.style.display = 'none'

      this.previewEl.innerHTML = ''
    }
  }

  private updateEngineMetadata(result: CompileResult): void {
    if (result.engineCommands?.length) {
      this.projectIndex.updateEngineCommands(result.engineCommands)
    }

    if (result.semanticTrace) {
      this.projectIndex.updateSemanticTrace(parseTraceFile(result.semanticTrace))
    } else {
      this.projectIndex.updateSemanticTrace({ labels: new Set(), refs: new Set() })
    }

    if (result.inputFiles?.length) {
      for (const path of result.inputFiles) {
        if (!this.projectIndex.getFileSymbols(path)) {
          const file = this.fs.getFile(path)

          if (file && typeof file.content === 'string') {
            this.projectIndex.updateFile(path, file.content)

            this.ensureModel(path, file.content)
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
      this.handleSuccessfulCompile(result, detail)
    } else {
      perf.end('total')

      this.setStatus(result.errors.length > 0 ? 'error' : 'ready')
    }

    this.handlePostCompile(result)
  }

  private handleSuccessfulCompile(result: CompileResult, detail?: string): void {
    for (const path of this.fs.listFiles()) {
      const file = this.fs.getFile(path)

      if (file && typeof file.content === 'string') {
        this.pdfViewer?.setSourceContent(path, file.content)
      }
    }

    this.handleSynctex(result)

    if (this.pdfViewer) {
      this.setStatus('rendering')

      perf.mark('render')

      this.pdfViewer.render(result.pdf!).then(() => {
        perf.end('render')

        perf.end('total')

        this.setStatus('ready', detail)
      })
    } else {
      perf.end('total')

      this.setStatus('ready', detail)
    }
  }

  private handlePostCompile(result: CompileResult): void {
    this.lastCompileErrors = result.errors

    setErrorMarkers(result.errors)

    this.updateAuxIndex()

    this.outline?.update(this.currentFile)

    this.emitOutline()

    this.runDiagnostics()

    // BibTeX takes priority over cross-ref recompile

    if (!this.pendingBibtex) {
      this.maybeRunBibtex(result)
    }

    if (!this.pendingBibtex) {
      this.maybeRecompile(result)
    }

    this.emit('compile', { result })
  }

  private handleSynctex(result: CompileResult): void {
    if (result.synctex) {
      perf.mark('synctex-parse')

      this.synctexParser

        .parse(result.synctex)

        .then((synctexData) => {
          perf.end('synctex-parse')

          this.pdfViewer?.setSynctexData(synctexData)
        })

        .catch((err) => {
          perf.end('synctex-parse')

          console.warn('SyncTeX parse failed, using text-mapper fallback:', err)

          this.pdfViewer?.setSynctexData(null)
        })
    } else {
      this.pdfViewer?.setSynctexData(null)
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

        this.syncAndCompile()
      })
    } else {
      this.pendingRecompile = false
    }
  }

  private maybeRunBibtex(result: CompileResult): void {
    if (this.pendingRecompile || this.pendingBibtex || !result.success || this.bibtexDone) return

    const hasBibFiles = this.fs.listFiles().some((f) => f.endsWith('.bib'))

    if (!hasBibFiles) return

    this.pendingBibtex = true

    this.runBibtexChain()

      .catch((err) => {
        console.warn('BibTeX chain error:', err)
      })

      .finally(() => {
        this.pendingBibtex = false
      })
  }

  private async runBibtexChain(): Promise<void> {
    const mainBase = this.mainFile.replace(/\.tex$/, '')

    const auxContent = await this.engine.readFile(`${mainBase}.aux`)

    if (!auxContent) return

    if (!auxContent.includes('\\citation{') || !auxContent.includes('\\bibdata{')) return

    this.bibtexDone = true

    const engine = await this.ensureBibtexEngine()

    if (!engine) return

    this.sendFilesToBibtex(engine, mainBase, auxContent)

    const bibtexResult = await engine.compile(mainBase)

    if (!bibtexResult.success) return

    const bbl = await engine.readFile(`${mainBase}.bbl`)

    if (!bbl) return

    this.engine.writeFile(`${mainBase}.bbl`, bbl)

    this.pendingRecompile = true

    const r = await this.engine.compile()

    this.pendingRecompile = false

    this.onCompileResult(r)

    this.syncAndCompile()
  }

  private async ensureBibtexEngine(): Promise<BibtexEngine | null> {
    if (this.bibtexEngine) return this.bibtexEngine

    const opts: { assetBaseUrl?: string; texliveUrl?: string } = {}

    if (this.opts.assetBaseUrl) opts.assetBaseUrl = this.opts.assetBaseUrl

    if (this.opts.texliveUrl) opts.texliveUrl = this.opts.texliveUrl

    this.bibtexEngine = new BibtexEngine(opts)

    try {
      await this.bibtexEngine.init()

      return this.bibtexEngine
    } catch (err) {
      console.warn('BibTeX engine init failed:', err)

      this.bibtexEngine = null

      return null
    }
  }

  private sendFilesToBibtex(engine: BibtexEngine, mainBase: string, auxContent: string): void {
    engine.writeFile(`${mainBase}.aux`, auxContent)

    const bibFiles = this.fs.listFiles().filter((f) => f.endsWith('.bib'))

    for (const bibPath of bibFiles) {
      const content = this.fs.readFile(bibPath)

      if (content != null) {
        engine.writeFile(bibPath, content)
      }
    }

    const bstMatch = auxContent.match(/\\bibstyle\{([^}]+)\}/)

    if (!bstMatch) return

    const bstName = bstMatch[1]!

    const bstPath = bstName.endsWith('.bst') ? bstName : `${bstName}.bst`

    const bstContent = this.fs.readFile(bstPath)

    if (bstContent != null) {
      engine.writeFile(bstPath, bstContent)
    }
  }

  private updateBibIndex(): void {
    const entries: import('./lsp/types').BibEntry[] = []

    for (const path of this.fs.listFiles()) {
      if (!path.endsWith('.bib')) continue

      const content = this.fs.readFile(path)

      if (typeof content === 'string') {
        entries.push(...parseBibFile(content, path))
      }
    }

    this.projectIndex.updateBib(entries)
  }

  private updateAuxIndex(): void {
    const mainBase = this.mainFile.replace(/\.tex$/, '')

    this.engine

      .readFile(`${mainBase}.aux`)

      .then((auxContent) => {
        if (!auxContent) return

        const auxData = parseAuxFile(auxContent)

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

      .catch(() => {})
  }

  private runDiagnostics(): void {
    const diagnostics = computeDiagnostics(this.projectIndex)

    setDiagnosticMarkers(diagnostics)

    this.emit('diagnostics', { diagnostics: diagnostics as TexError[] })

    if (this.errorLog) {
      const diagAsErrors: TexError[] = diagnostics.map((d) => ({
        line: d.line,

        message: d.message,

        severity: d.severity === 'info' ? ('warning' as const) : d.severity,

        file: d.file,
      }))

      this.errorLog.update([...this.lastCompileErrors, ...diagAsErrors])
    }
  }

  private downloadPdf(): void {
    const data = this.pdfViewer?.getLastPdf()

    if (!data) return

    const blob = new Blob([data.buffer as ArrayBuffer], { type: 'application/pdf' })

    const url = URL.createObjectURL(blob)

    const a = document.createElement('a')

    a.href = url

    a.download = 'output.pdf'

    a.click()

    URL.revokeObjectURL(url)
  }

  private emitOutline(): void {
    const symbols = this.projectIndex.getFileSymbols(this.currentFile)

    this.emit('outlineUpdate', { sections: symbols?.sections ?? [] })
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
