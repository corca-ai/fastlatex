import * as monaco from 'monaco-editor'
import type { VirtualFS } from '../fs/virtual-fs'
import { createCompletionProvider } from './completion-provider'
import { createDefinitionProvider } from './definition-provider'
import { createHoverProvider } from './hover-provider'
import type { ProjectIndex } from './project-index'
import { createReferenceProvider } from './reference-provider'
import { createRenameProvider } from './rename-provider'
import { createDocumentSymbolProvider } from './symbol-provider'

export function registerLatexProviders(index: ProjectIndex, fs: VirtualFS): monaco.IDisposable[] {
  return [
    monaco.languages.registerCompletionItemProvider('latex', createCompletionProvider(index, fs)),
    monaco.languages.registerDefinitionProvider('latex', createDefinitionProvider(index)),
    monaco.languages.registerHoverProvider('latex', createHoverProvider(index)),
    monaco.languages.registerDocumentSymbolProvider('latex', createDocumentSymbolProvider(index)),
    monaco.languages.registerReferenceProvider('latex', createReferenceProvider(index)),
    monaco.languages.registerRenameProvider('latex', createRenameProvider(index)),
  ]
}
