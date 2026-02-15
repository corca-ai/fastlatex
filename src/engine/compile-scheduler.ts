import { perf } from '../perf/metrics'
import type { CompileResult } from '../types'
import type { TexEngine } from './tex-engine'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export class CompileScheduler {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private compiling = false
  private pendingCompile = false
  private generation = 0
  private lastCompileTime = 0
  private minDebounceMs: number
  private maxDebounceMs: number

  constructor(
    private engine: TexEngine,
    private onResult: (result: CompileResult) => void,
    private onStatusChange: (status: 'compiling') => void,
    { minDebounceMs = 150, maxDebounceMs = 1000 } = {},
  ) {
    this.minDebounceMs = minDebounceMs
    this.maxDebounceMs = maxDebounceMs
  }

  private get debounceMs(): number {
    if (this.lastCompileTime === 0) return this.minDebounceMs
    return clamp(this.lastCompileTime * 0.5, this.minDebounceMs, this.maxDebounceMs)
  }

  schedule(): void {
    this.generation++

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      perf.end('debounce')
      perf.mark('compile')
      this.runCompile()
    }, this.debounceMs)
  }

  private async runCompile(): Promise<void> {
    if (this.compiling) {
      this.pendingCompile = true
      return
    }

    if (!this.engine.isReady()) return

    this.compiling = true
    const compileGeneration = this.generation
    this.onStatusChange('compiling')

    try {
      const result = await this.engine.compile()
      this.lastCompileTime = result.compileTime

      if (compileGeneration === this.generation) {
        this.onResult(result)
      }
    } catch (err) {
      console.error('Compilation error:', err)
      if (compileGeneration === this.generation) {
        this.onResult({
          success: false,
          pdf: null,
          log: String(err),
          errors: [{ line: 0, message: String(err), severity: 'error' }],
          compileTime: 0,
          synctex: null,
        })
      }
    } finally {
      this.compiling = false

      if (this.pendingCompile) {
        this.pendingCompile = false
        this.runCompile()
      }
    }
  }

  /** Immediately fire the pending debounce timer (skip remaining wait). */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
      perf.end('debounce')
      perf.mark('compile')
      this.runCompile()
    }
  }

  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.pendingCompile = false
  }

  getDebounceMs(): number {
    return this.debounceMs
  }
}
