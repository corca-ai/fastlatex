import { LatexEditor } from './latex-editor'
import './styles.css'

const container = document.getElementById('app')!

const urlParams = new URLSearchParams(window.location.search)
const tlParam = urlParams.get('tl') as any
const texliveVersion = tlParam === '2020' || tlParam === '2025' ? tlParam : '2025'

const editor = new LatexEditor(container, {
  texliveVersion,
})

editor.init().then(() => {
  // E2E backward compat: expose globals
  ;(globalThis as Record<string, unknown>).__engine = (editor as any).engine
  ;(globalThis as Record<string, unknown>).__pdfViewer = editor.getViewer()
  ;(globalThis as Record<string, unknown>).__editor = editor.getMonacoEditor()
  ;(globalThis as Record<string, unknown>).__latexEditor = editor
})
