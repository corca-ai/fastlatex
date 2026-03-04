// Minimal monaco-editor mock for vitest
export const languages = {
  CompletionItemKind: {
    Function: 1,
    Variable: 5,
    Reference: 17,
    Module: 8,
    File: 16,
    Keyword: 13,
  },
  CompletionItemInsertTextRule: {
    InsertAsSnippet: 4,
  },
  SymbolKind: {
    Module: 1,
    Key: 19,
    Function: 11,
    Struct: 22,
  },
  registerCompletionItemProvider: () => ({ dispose() {} }),
  registerDefinitionProvider: () => ({ dispose() {} }),
  registerHoverProvider: () => ({ dispose() {} }),
  registerDocumentSymbolProvider: () => ({ dispose() {} }),
  registerReferenceProvider: () => ({ dispose() {} }),
  registerRenameProvider: () => ({ dispose() {} }),
  register: () => {},
  setMonarchTokensProvider: () => {},
  setLanguageConfiguration: () => {},
}

export class Uri {
  readonly scheme: string
  readonly path: string
  constructor(scheme: string, path: string) {
    this.scheme = scheme
    this.path = path.startsWith('/') ? path : `/${path}`
  }
  static file(path: string): Uri {
    return new Uri('file', path)
  }
  static parse(url: string): Uri {
    const scheme = url.split('://')[0]!
    const path = url.split('://')[1]!
    return new Uri(scheme, path)
  }
  with(change: { path?: string; scheme?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path)
  }
  toString(): string {
    return `${this.scheme}://${this.path}`
  }
}

export class Range {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
  constructor(startLine: number, startCol: number, endLine: number, endCol: number) {
    this.startLineNumber = startLine
    this.startColumn = startCol
    this.endLineNumber = endLine
    this.endColumn = endCol
  }
}

export const editor = {
  create: () => ({}),
  createModel: () => ({}),
  getModel: () => null,
}

export default {
  languages,
  Uri,
  Range,
  editor,
}
