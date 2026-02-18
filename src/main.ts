import { LatexEditor } from './latex-editor'
import './styles.css'

const container = document.getElementById('app')!
const editor = new LatexEditor(container)

editor.init().then(() => {
  // E2E backward compat: expose globals
  ;(globalThis as Record<string, unknown>).__engine = (editor as any).engine
  ;(globalThis as Record<string, unknown>).__pdfViewer = editor.getViewer()
  ;(globalThis as Record<string, unknown>).__editor = editor.getMonacoEditor()
  ;(globalThis as Record<string, unknown>).__latexEditor = editor
})
