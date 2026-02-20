import { LatexEditor } from 'latex-editor'
import './latex-editor.css'

const editorContainer = document.getElementById('editor')
const previewContainer = document.getElementById('preview')

const editor = new LatexEditor(editorContainer, previewContainer, {
  files: {
    'main.tex': `\\documentclass{article}
\\begin{document}
Hello from GitHub-installed LaTeX Editor!
\\end{document}`
  },
  serviceWorker: false,
})

editor.on('status', (evt) => {
  if (evt.detail === 'ready' || evt.detail === 'error') {
    console.log('[latex-editor status]', evt.detail)
  }
})

editor.on('compile', ({ result }) => {
  if (result.success) {
    console.log('compile success', { pdfBytes: result.pdf?.byteLength })
  } else {
    console.error('compile failed', result.log)
  }
})

await editor.init()
