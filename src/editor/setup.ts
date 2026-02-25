import * as monaco from 'monaco-editor'
import { bibLanguage, bibLanguageConfig } from './bib-language'
import { latexLanguage, latexLanguageConfig } from './latex-language'

let languagesRegistered = false
let workersConfigured = false

/** Register LaTeX and BibTeX languages with Monaco. Safe to call multiple times.
 *  Exported so that host apps using an external editor can register syntax
 *  highlighting before creating their own Monaco instance. */
export function ensureLanguagesRegistered(): void {
  if (languagesRegistered) return
  languagesRegistered = true

  // Register LaTeX language
  monaco.languages.register({ id: 'latex' })
  monaco.languages.setMonarchTokensProvider('latex', latexLanguage)
  monaco.languages.setLanguageConfiguration('latex', latexLanguageConfig)

  // Register BibTeX language
  monaco.languages.register({ id: 'bibtex' })
  monaco.languages.setMonarchTokensProvider('bibtex', bibLanguage)
  monaco.languages.setLanguageConfiguration('bibtex', bibLanguageConfig)
}

/** Ensure Monaco web workers are configured.
 *
 *  When used as a **library** (installed via npm/bun), the consumer's bundler
 *  must handle Monaco worker URLs. Call {@link configureMonacoWorkers} in your
 *  own source **before** `new FastLatex(…)`, or set `self.MonacoEnvironment`
 *  manually. See the Integration Guide for details.
 *
 *  The built-in fallback only works when the source is processed directly by
 *  Vite (i.e. the demo app / `npm run dev`). */
function ensureWorkersConfigured(): void {
  if (workersConfigured) return
  workersConfigured = true

  if ((self as any).MonacoEnvironment?.getWorker) return

  console.warn(
    '[FastLaTeX] MonacoEnvironment.getWorker is not configured. ' +
      'Monaco editor workers may fail to load. ' +
      'Call configureMonacoWorkers() or set self.MonacoEnvironment before creating FastLatex. ' +
      'See the Integration Guide (docs/howto.md) for a ready-to-use snippet.',
  )
}

/** Ready-to-use Monaco worker configuration for Vite projects.
 *
 *  **Must be called in the consumer's own source code** so that the consumer's
 *  bundler (Vite / webpack / etc.) can resolve and bundle the worker files from
 *  `node_modules/monaco-editor`.
 *
 *  ```ts
 *  import { configureMonacoWorkers } from 'fastlatex'
 *  configureMonacoWorkers()
 *  ```
 *
 *  If your bundler does not support the `new Worker(new URL(…))` pattern, set
 *  `self.MonacoEnvironment.getWorker` manually instead. */
export function configureMonacoWorkers(): void {
  if ((self as any).MonacoEnvironment?.getWorker) return

  ;(self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') {
        return new Worker(
          new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url),
          { type: 'module' },
        )
      }
      return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
        type: 'module',
      })
    },
  }
}

function ensureMonacoConfigured(): void {
  ensureWorkersConfigured()
  ensureLanguagesRegistered()
}

/** Create a Monaco text model for a project file. */
export function createFileModel(content: string, filePath: string): monaco.editor.ITextModel {
  ensureLanguagesRegistered()
  const lang = filePath.endsWith('.tex')
    ? 'latex'
    : filePath.endsWith('.bib')
      ? 'bibtex'
      : 'plaintext'
  const path = filePath.startsWith('/') ? filePath : `/${filePath}`
  const uri = monaco.Uri.file(path)
  return monaco.editor.createModel(content, lang, uri)
}

/** Create the Monaco editor instance with an existing model. */
export function createEditor(
  container: HTMLElement,
  model: monaco.editor.ITextModel,
): monaco.editor.IStandaloneCodeEditor {
  ensureMonacoConfigured()
  return monaco.editor.create(container, {
    model,
    theme: 'vs-dark',
    fontSize: 14,
    lineNumbers: 'on',
    minimap: { enabled: false },
    wordWrap: 'on',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderWhitespace: 'none',
    tabSize: 2,
  })
}

export function revealLine(editor: monaco.editor.IStandaloneCodeEditor, line: number): void {
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: 1 })
  editor.focus()
}
