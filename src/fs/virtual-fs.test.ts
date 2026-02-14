import { describe, expect, it, vi } from 'vitest'
import { VirtualFS } from './virtual-fs'

describe('VirtualFS', () => {
  it('initializes with main.tex', () => {
    const fs = new VirtualFS()
    expect(fs.listFiles()).toContain('main.tex')
    expect(fs.readFile('main.tex')).toBeTypeOf('string')
  })

  it('writes and reads a file', () => {
    const fs = new VirtualFS()
    fs.writeFile('test.tex', 'hello')
    expect(fs.readFile('test.tex')).toBe('hello')
  })

  it('writes and reads binary content', () => {
    const fs = new VirtualFS()
    const data = new Uint8Array([1, 2, 3])
    fs.writeFile('image.png', data)
    expect(fs.readFile('image.png')).toEqual(data)
  })

  it('returns null for non-existent file', () => {
    const fs = new VirtualFS()
    expect(fs.readFile('nope.tex')).toBeNull()
  })

  it('deletes a file', () => {
    const fs = new VirtualFS()
    fs.writeFile('tmp.tex', 'x')
    expect(fs.deleteFile('tmp.tex')).toBe(true)
    expect(fs.readFile('tmp.tex')).toBeNull()
  })

  it('returns false when deleting non-existent file', () => {
    const fs = new VirtualFS()
    expect(fs.deleteFile('nope.tex')).toBe(false)
  })

  it('lists files sorted', () => {
    const fs = new VirtualFS()
    fs.writeFile('b.tex', '')
    fs.writeFile('a.tex', '')
    const files = fs.listFiles()
    expect(files).toEqual(['a.tex', 'b.tex', 'main.tex'])
  })

  it('tracks modified files', () => {
    const fs = new VirtualFS()
    // main.tex starts modified
    expect(fs.getModifiedFiles()).toHaveLength(1)

    fs.markSynced()
    expect(fs.getModifiedFiles()).toHaveLength(0)

    fs.writeFile('new.tex', 'content')
    expect(fs.getModifiedFiles()).toHaveLength(1)
    expect(fs.getModifiedFiles()[0]!.path).toBe('new.tex')
  })

  it('marks all files as synced', () => {
    const fs = new VirtualFS()
    fs.writeFile('a.tex', 'x')
    fs.writeFile('b.tex', 'y')
    fs.markSynced()
    expect(fs.getModifiedFiles()).toHaveLength(0)
  })

  it('notifies listeners on write', () => {
    const fs = new VirtualFS()
    const listener = vi.fn()
    fs.onChange(listener)
    listener.mockClear() // clear call from constructor's writeFile

    fs.writeFile('test.tex', 'hello')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifies listeners on delete', () => {
    const fs = new VirtualFS()
    fs.writeFile('test.tex', 'hello')
    const listener = vi.fn()
    fs.onChange(listener)

    fs.deleteFile('test.tex')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes listener', () => {
    const fs = new VirtualFS()
    const listener = vi.fn()
    const unsub = fs.onChange(listener)
    listener.mockClear()

    unsub()
    fs.writeFile('test.tex', 'x')
    expect(listener).not.toHaveBeenCalled()
  })

  it('getFile returns VirtualFile or undefined', () => {
    const fs = new VirtualFS()
    const file = fs.getFile('main.tex')
    expect(file).toBeDefined()
    expect(file!.path).toBe('main.tex')
    expect(file!.content).toBeTypeOf('string')

    expect(fs.getFile('nope.tex')).toBeUndefined()
  })

  it('overwrites existing file', () => {
    const fs = new VirtualFS()
    fs.writeFile('test.tex', 'first')
    fs.writeFile('test.tex', 'second')
    expect(fs.readFile('test.tex')).toBe('second')
    expect(fs.listFiles().filter((f) => f === 'test.tex')).toHaveLength(1)
  })
})
