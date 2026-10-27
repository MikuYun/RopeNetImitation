/**
 * 附件纯逻辑单测：上传前拦截、体积格式化、图标分类、会话列表预览文案。
 *
 * 这些是全前端「附件」功能的地基 —— 一旦 formatBytes 算错，用户会看到
 * `10485760 B` 这种没法读的数字；一旦 checkUploadFile 漏判，>10MiB 的
 * 文件会白跑一次上传再被后端 413 打回。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
  attachmentAltText,
  attachmentIconKind,
  attachmentPreviewText,
  checkUploadFile,
  formatBytes,
  isImageAttachment,
  messageTypeOfAttachment,
} from './attachments'

describe('checkUploadFile', () => {
  it('正常文件放行', () => {
    expect(checkUploadFile({ name: 'a.png', size: 1024 })).toEqual({ ok: true })
  })

  it('空文件被拦下，提示可读', () => {
    const r = checkUploadFile({ name: 'a.png', size: 0 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('EMPTY_FILE')
      expect(r.message).toContain('空文件')
    }
  })

  it('无名文件被拦下', () => {
    const r = checkUploadFile({ name: '', size: 10 })
    expect(r.ok).toBe(false)
  })

  it('恰好 10MiB 放行（边界取等）', () => {
    expect(checkUploadFile({ name: 'a.bin', size: MAX_UPLOAD_BYTES })).toEqual({ ok: true })
  })

  it('10MiB + 1 字节被拦，并且提示里带具体体积', () => {
    const r = checkUploadFile({ name: 'a.bin', size: MAX_UPLOAD_BYTES + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('UPLOAD_TOO_LARGE')
      expect(r.message).toContain('10')
      expect(r.message).toContain('MB')
    }
  })
})

describe('formatBytes', () => {
  it('小于 1KB 用 B 且取整', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('KB / MB 保留 1 位小数', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe('10.0 MB')
  })

  it('非法值兜底为 0 B', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
  })
})

describe('attachmentIconKind', () => {
  const att = (mimeType: string, name: string) => ({ mimeType, name })

  it('按 mime 识别图片与 pdf', () => {
    expect(attachmentIconKind(att('image/png', 'x.png'))).toBe('image')
    expect(attachmentIconKind(att('application/pdf', 'x.pdf'))).toBe('pdf')
  })

  it('压缩包族都归 zip', () => {
    expect(attachmentIconKind(att('application/zip', 'x.zip'))).toBe('zip')
    expect(attachmentIconKind(att('application/x-zip-compressed', 'x.zip'))).toBe('zip')
    expect(attachmentIconKind(att('application/octet-stream', 'x.tar.gz'))).toBe('zip')
  })

  it('文本 / 代码类归 text', () => {
    expect(attachmentIconKind(att('text/plain', 'x.txt'))).toBe('text')
    expect(attachmentIconKind(att('application/json', 'x.json'))).toBe('text')
    expect(attachmentIconKind(att('application/octet-stream', 'x.ts'))).toBe('text')
  })

  it('未知类型归 other（不猜成图片）', () => {
    expect(attachmentIconKind(att('application/octet-stream', 'x.bin'))).toBe('other')
  })

  it('mime 为空时退回扩展名', () => {
    expect(attachmentIconKind(att('', 'x.png'))).toBe('image')
    expect(attachmentIconKind(att('', 'x.md'))).toBe('text')
  })
})

describe('messageTypeOfAttachment / isImageAttachment', () => {
  it('kind=image 映射成 image，其余 file', () => {
    expect(messageTypeOfAttachment({ kind: 'image' })).toBe('image')
    expect(messageTypeOfAttachment({ kind: 'file' })).toBe('file')
  })

  it('isImageAttachment 认 kind 也认 mime 前缀', () => {
    expect(isImageAttachment({ kind: 'image', mimeType: 'application/octet-stream' })).toBe(true)
    expect(isImageAttachment({ kind: 'file', mimeType: 'image/webp' })).toBe(true)
    expect(isImageAttachment({ kind: 'file', mimeType: 'application/pdf' })).toBe(false)
  })
})

describe('会话列表预览文案', () => {
  it('图片消息不把文件名塞进单行预览', () => {
    expect(attachmentPreviewText({ kind: 'image', name: 'screenshot.png' })).toBe('[图片]')
  })

  it('文件消息显示 [文件] + 文件名', () => {
    expect(attachmentPreviewText({ kind: 'file', name: '报告.pdf' })).toBe('[文件] 报告.pdf')
  })

  it('alt 文案带文件名，空名有兜底', () => {
    expect(attachmentAltText({ name: 'a.png' })).toBe('图片：a.png')
    expect(attachmentAltText({ name: '' })).toBe('图片附件')
  })
})
