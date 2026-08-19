import { describe, it, expect } from 'vitest'
import { formatBytes } from './FileAttachments'

describe('formatBytes', () => {
  it('renders bytes for values under 1024', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('renders KB with one decimal below 10 KB, none above', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12345)).toBe('12 KB')
  })

  it('renders MB with one decimal below 10 MB, none above', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB')
  })
})
