import type * as Monaco from 'monaco-editor'
import { createEditor, revealLine, setEditorContent } from './editor/setup'
import { CompileScheduler } from './engine/compile-scheduler'
import { SwiftLatexEngine } from './engine/swiftlatex-engine'
import { VirtualFS } from './fs/virtual-fs'
import { SynctexParser } from './synctex/synctex-parser'
import type { AppStatus, CompileResult } from './types'
import { ErrorLog } from './ui/error-log'
import { FileTree } from './ui/file-tree'
import { setupDividers } from './ui/layout'
import { PdfViewer } from './viewer/pdf-viewer'
import './styles.css'

// --- State ---
let currentFile = 'main.tex'
let editor: Monaco.editor.IStandaloneCodeEditor

// --- Components ---
const engine = new SwiftLatexEngine()
const synctexParser = new SynctexParser()
const fs = new VirtualFS()
const statusEl = document.getElementById('status')!

// Expose for E2E testing and dev tools
;(globalThis as Record<string, unknown>).__engine = engine

function setStatus(status: AppStatus, detail?: string): void {
  statusEl.className = status
  const labels: Record<AppStatus, string> = {
    unloaded: 'Initializing...',
    loading: 'Loading engine...',
    ready: 'Ready',
    compiling: 'Compiling...',
    error: 'Error',
    rendering: 'Rendering PDF...',
  }
  statusEl.textContent = detail ? `${labels[status]} ${detail}` : labels[status]
}

// --- PDF Viewer ---
const viewerContainer = document.getElementById('viewer-panel')!
const pdfViewer = new PdfViewer(viewerContainer)
;(globalThis as Record<string, unknown>).__pdfViewer = pdfViewer

// Inverse search: Cmd/Ctrl+click on PDF → jump to source line
pdfViewer.setInverseSearchHandler((loc) => {
  if (loc.file !== currentFile) {
    onFileSelect(loc.file)
  }
  revealLine(editor, loc.line)
})

// --- Error Log ---
const errorLogContainer = document.getElementById('error-log-panel')!
const errorLog = new ErrorLog(errorLogContainer, (line) => {
  revealLine(editor, line)
})

// --- Compile result handler ---
function onCompileResult(result: CompileResult): void {
  console.log(
    `Compile: ${result.success ? 'OK' : 'FAIL'} in ${result.compileTime.toFixed(0)}ms, ` +
      `${result.errors.length} error(s)`,
  )
  if (!result.success) {
    console.log('TeX log:', result.log)
  }

  if (result.success && result.pdf) {
    // Update source content for text-mapper fallback
    for (const path of fs.listFiles()) {
      const file = fs.getFile(path)
      if (file && typeof file.content === 'string') {
        pdfViewer.setSourceContent(path, file.content)
      }
    }

    // Parse SyncTeX data if available (preferred over text-mapper)
    if (result.synctex) {
      synctexParser
        .parse(result.synctex)
        .then((synctexData) => {
          pdfViewer.setSynctexData(synctexData)
          console.log(
            `SyncTeX: ${synctexData.inputs.size} inputs, ` +
              `${synctexData.pages.size} pages, ` +
              `mag=${synctexData.magnification}, unit=${synctexData.unit}, ` +
              `xOff=${synctexData.xOffset}, yOff=${synctexData.yOffset}`,
          )
          // Log sample nodes from page 1 for debugging
          const p1 = synctexData.pages.get(1)
          if (p1 && p1.length > 0) {
            const sample = p1.slice(0, 5)
            for (const n of sample) {
              console.log(
                `  [${n.type}] line=${n.line} h=${n.h.toFixed(1)} v=${n.v.toFixed(1)} w=${n.width.toFixed(1)} h=${n.height.toFixed(1)}`,
              )
            }
          }
        })
        .catch((err) => {
          console.warn('SyncTeX parse failed, using text-mapper fallback:', err)
          pdfViewer.setSynctexData(null)
        })
    } else {
      pdfViewer.setSynctexData(null)
    }

    setStatus('rendering')
    pdfViewer.render(result.pdf).then((renderTime) => {
      console.log(`PDF render: ${renderTime.toFixed(0)}ms`)
      setStatus('ready')
    })
  } else {
    setStatus(result.errors.length > 0 ? 'error' : 'ready')
  }

  errorLog.update(result.errors, result.log)
}

// --- Compile Scheduler ---
const scheduler = new CompileScheduler(engine, onCompileResult, setStatus, {
  minDebounceMs: 150,
  maxDebounceMs: 1000,
})

// --- Sync files to engine and compile ---
function syncAndCompile(): void {
  const status = engine.getStatus()
  if (status === 'unloaded' || status === 'loading' || status === 'error') return

  // Write modified files to engine (safe during compilation — messages queue in worker)
  for (const file of fs.getModifiedFiles()) {
    engine.writeFile(file.path, file.content)
  }
  fs.markSynced()

  engine.setMainFile('main.tex')
  scheduler.schedule()
}

// --- Editor change handler ---
function onEditorChange(content: string): void {
  fs.writeFile(currentFile, content)
  syncAndCompile()
}

// --- File selection handler ---
function onFileSelect(path: string): void {
  // Save current editor content
  if (editor) {
    fs.writeFile(currentFile, editor.getValue())
  }

  currentFile = path
  const file = fs.getFile(path)
  if (file && editor) {
    const content =
      typeof file.content === 'string' ? file.content : new TextDecoder().decode(file.content)
    setEditorContent(editor, content, path.endsWith('.tex') ? 'latex' : 'plaintext')

    // Re-attach change handler since setEditorContent creates a new model
    editor.onDidChangeModelContent(() => {
      onEditorChange(editor.getValue())
    })
  }
}

// --- Editor ---
const editorContainer = document.getElementById('editor-panel')!
const initialContent = fs.readFile('main.tex') as string
editor = createEditor(editorContainer, initialContent, onEditorChange)
;(globalThis as Record<string, unknown>).__editor = editor

// --- File Tree ---
const fileTreeContainer = document.getElementById('file-tree-panel')!
new FileTree(fileTreeContainer, fs, onFileSelect)

// --- Forward Search (auto on cursor move, debounced) ---
let forwardSearchTimer: ReturnType<typeof setTimeout> | null = null
let lastForwardLine = -1
editor.onDidChangeCursorPosition(() => {
  const line = editor.getPosition()?.lineNumber
  if (!line || line === lastForwardLine) return
  lastForwardLine = line
  if (forwardSearchTimer) clearTimeout(forwardSearchTimer)
  forwardSearchTimer = setTimeout(() => {
    pdfViewer.forwardSearch(currentFile, line)
  }, 100)
})

// --- Layout ---
setupDividers()

// --- Service Worker (texlive package cache) ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('SW registration failed:', err)
  })
}

// --- Initialize Engine ---
async function init(): Promise<void> {
  setStatus('loading')

  try {
    const engineStart = performance.now()
    await engine.init()
    console.log(`Engine load: ${(performance.now() - engineStart).toFixed(0)}ms`)

    setStatus('ready')

    // Write all FS files to engine and compile
    for (const path of fs.listFiles()) {
      const file = fs.getFile(path)!
      engine.writeFile(path, file.content)
    }
    fs.markSynced()

    engine.setMainFile('main.tex')
    const result = await engine.compile()
    onCompileResult(result)
  } catch (err) {
    console.error('Engine initialization failed:', err)
    setStatus('error', String(err))
  }
}

init()
