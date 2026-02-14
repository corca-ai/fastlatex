import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompileResult } from '../types'
import { CompileScheduler } from './compile-scheduler'
import type { TexEngine } from './tex-engine'

function makeResult(overrides?: Partial<CompileResult>): CompileResult {
  return {
    success: true,
    pdf: new Uint8Array([1]),
    log: '',
    errors: [],
    compileTime: 100,
    ...overrides,
  }
}

function mockEngine(compileResult?: CompileResult): TexEngine {
  const result = compileResult ?? makeResult()
  return {
    init: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    setMainFile: vi.fn(),
    compile: vi.fn().mockResolvedValue(result),
    isReady: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('ready'),
    flushCache: vi.fn(),
    terminate: vi.fn(),
  }
}

describe('CompileScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces compile calls', () => {
    const engine = mockEngine()
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = new CompileScheduler(engine, onResult, onStatus, 300)

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()

    expect(engine.compile).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(engine.compile).toHaveBeenCalledTimes(1)
  })

  it('calls onResult after compile', async () => {
    const result = makeResult()
    const engine = mockEngine(result)
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = new CompileScheduler(engine, onResult, onStatus, 50)

    scheduler.schedule()
    vi.advanceTimersByTime(50)

    // Flush the microtask queue for the compile promise
    await vi.advanceTimersByTimeAsync(0)

    expect(onResult).toHaveBeenCalledWith(result)
  })

  it('calls onStatusChange when compiling', () => {
    const engine = mockEngine()
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = new CompileScheduler(engine, onResult, onStatus, 50)

    scheduler.schedule()
    vi.advanceTimersByTime(50)

    expect(onStatus).toHaveBeenCalledWith('compiling')
  })

  it('queues a pending compile if already compiling', async () => {
    let resolveCompile!: (result: CompileResult) => void
    const engine = mockEngine()
    ;(engine.compile as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<CompileResult>((r) => {
          resolveCompile = r
        }),
    )
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = new CompileScheduler(engine, onResult, onStatus, 0)

    // Start first compile
    scheduler.schedule()
    vi.advanceTimersByTime(0)
    expect(engine.compile).toHaveBeenCalledTimes(1)

    // Schedule while compiling — should set pending
    scheduler.schedule()
    vi.advanceTimersByTime(0)

    // Resolve first compile
    resolveCompile(makeResult())
    await vi.advanceTimersByTimeAsync(0)

    // Pending compile should have triggered a second compile
    expect(engine.compile).toHaveBeenCalledTimes(2)
  })

  it('cancel stops pending debounce', () => {
    const engine = mockEngine()
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = new CompileScheduler(engine, onResult, onStatus, 300)

    scheduler.schedule()
    scheduler.cancel()
    vi.advanceTimersByTime(300)

    expect(engine.compile).not.toHaveBeenCalled()
  })

  it('does not compile when engine is not ready', () => {
    const engine = mockEngine()
    ;(engine.isReady as ReturnType<typeof vi.fn>).mockReturnValue(false)
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = new CompileScheduler(engine, onResult, onStatus, 0)

    scheduler.schedule()
    vi.advanceTimersByTime(0)

    expect(engine.compile).not.toHaveBeenCalled()
  })

  it('handles compile errors gracefully', async () => {
    const engine = mockEngine()
    ;(engine.compile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('WASM crash'))
    const onResult = vi.fn()
    const onStatus = vi.fn()
    const scheduler = new CompileScheduler(engine, onResult, onStatus, 0)

    scheduler.schedule()
    vi.advanceTimersByTime(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(onResult).toHaveBeenCalledTimes(1)
    const result = onResult.mock.calls[0]![0] as CompileResult
    expect(result.success).toBe(false)
    expect(result.errors).toHaveLength(1)
  })
})
