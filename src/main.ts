import { LatexEditor } from './latex-editor'
import './styles.css'

const container = document.getElementById('app')!
let opts = (globalThis as any).__LATEX_EDITOR_OPTS || {}

// Support manual extraction mode via localStorage
if (localStorage.getItem('extract_mode') === 'true') {
  console.log('[main] Manual extraction mode enabled')
  opts = {
    ...opts,
    skipFormatPreload: true,
    serviceWorker: false,
    texliveUrl: 'https://dwrg2en9emzif.cloudfront.net/2025/',
  }
}

const editor = new LatexEditor(container, opts)

editor.init().then(() => {
  // E2E backward compat: expose globals
  ;(globalThis as Record<string, unknown>).__engine = (editor as any).engine
  ;(globalThis as Record<string, unknown>).__pdfViewer = editor.getViewer()
  ;(globalThis as Record<string, unknown>).__editor = editor.getMonacoEditor()
  ;(globalThis as Record<string, unknown>).__latexEditor = editor
})
