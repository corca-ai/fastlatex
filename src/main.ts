import { LatexEditor } from './latex-editor'
import './styles.css'

const container = document.getElementById('app')!

const urlParams = new URLSearchParams(window.location.search)
const tlParam = urlParams.get('tl') as any
const texliveVersion = tlParam === '2020' || tlParam === '2025' ? tlParam : '2025'

const projParam = urlParams.get('proj') || 'default'

async function start() {
  let files: Record<string, string | Uint8Array> | undefined = undefined

  if (projParam === 'sample') {
    console.log('[main] Loading "Paper Sample" project...')
    // List of files we found in public/sample
    const fileList = ['main.tex', 'introduction.tex', 'refs.bib']

    files = {}
    const timestamp = Date.now()
    await Promise.all(
      fileList.map(async (name) => {
        const resp = await fetch(`${import.meta.env.BASE_URL}sample/${name}?t=${timestamp}`)
        if (resp.ok) {
          const isBinary = /\.(png|jpg|jpeg|gif|pdf)$/i.test(name)
          files![name] = isBinary ? new Uint8Array(await resp.arrayBuffer()) : await resp.text()
        }
      }),
    )
  }

  const opts: any = {
    texliveVersion,
  }
  if (files) {
    opts.files = files
  }

  const editor = new LatexEditor(container, opts)

  await editor.init()

  // E2E backward compat: expose globals
  ;(globalThis as Record<string, unknown>).__engine = (editor as any).engine
  ;(globalThis as Record<string, unknown>).__pdfViewer = editor.getViewer()
  ;(globalThis as Record<string, unknown>).__editor = editor.getMonacoEditor()
  ;(globalThis as Record<string, unknown>).__latexEditor = editor
}

start()
