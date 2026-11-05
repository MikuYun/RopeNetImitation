/**
 * 附件纯逻辑单测：上传前拦截、体积格式化、图标分类、会话列表预览文案。
 *
 * 这些是全前端「附件」功能的地基 —— 一旦 formatBytes 算错，用户会看到
 * `52428800 B` 这种没法读的数字；一旦 checkUploadFile 漏判，>50MiB 的
 * 文件会白跑一次上传再被后端 413 打回。
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  attachmentAltText,
  attachmentIconKind,
  attachmentKindOf,
  attachmentPreviewText,
  attachmentsPreviewText,
  checkAttachmentSelection,
  checkUploadFile,
  formatBytes,
  formatDuration,
  isImageAttachment,
  isVideoAttachment,
  messageTypeOfAttachment,
  messageTypeOfAttachments,
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

  it('恰好 50MiB 放行（边界取等）', () => {
    expect(checkUploadFile({ name: 'a.bin', size: MAX_UPLOAD_BYTES })).toEqual({ ok: true })
  })

  it('50MiB + 1 字节被拦，并且提示里带具体体积', () => {
    const r = checkUploadFile({ name: 'a.bin', size: MAX_UPLOAD_BYTES + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('UPLOAD_TOO_LARGE')
      expect(r.message).toContain('50')
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
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe('50.0 MB')
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

  it('Office 家族按扩展名分类（docx 是 zip 容器，不能显示成压缩包）', () => {
    expect(attachmentIconKind(att('application/zip', 'r.docx'))).toBe('doc')
    expect(attachmentIconKind(att('application/zip', 'r.xlsx'))).toBe('sheet')
    expect(attachmentIconKind(att('application/zip', 'r.pptx'))).toBe('slide')
    expect(attachmentIconKind(att('application/x-ole-storage', 'old.doc'))).toBe('doc')
  })

  it('音频归 audio', () => {
    expect(attachmentIconKind(att('audio/mpeg', 'a.mp3'))).toBe('audio')
    expect(attachmentIconKind(att('application/octet-stream', 'a.flac'))).toBe('audio')
    expect(attachmentIconKind(att('', 'a.wav'))).toBe('audio')
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

/*
 * ── v2：视频分档 / 多附件组合 / 新增预览文案 ──
 *
 * 这几条是 API 0.3.0 才出现的行为，之前没有测试保护：
 *   - 视频上限 100MiB 与普通文件 50MiB 是**两档**，写成一档会让 60MB 的 mp4
 *     被前端拦下（用户以为功能坏了），或者让 60MB 的 pdf 白跑一次上传再被 413。
 *   - 合计 ≤9 / 视频 ≤1 的规则在三个入口（选文件、拖拽、粘贴）共用。
 */
describe('v2 附件分档：视频 100MiB / 图片与普通文件 50MiB', () => {
  it('视频恰好 100MiB 放行，超 1 字节被拦且提示带体积', () => {
    expect(checkUploadFile({ name: 'a.mp4', size: MAX_VIDEO_UPLOAD_BYTES, type: 'video/mp4' })).toEqual({
      ok: true,
    })
    const r = checkUploadFile({
      name: 'a.mp4',
      size: MAX_VIDEO_UPLOAD_BYTES + 1,
      type: 'video/mp4',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('UPLOAD_TOO_LARGE')
      expect(r.message).toContain('100')
    }
  })

  it('50MiB 的 mp4 放行，同样体积的普通文件也放行（v2.3 起普通档也是 50MiB）', () => {
    expect(checkUploadFile({ name: 'a.mp4', size: 50 * 1024 * 1024, type: 'video/mp4' })).toEqual({
      ok: true,
    })
    expect(checkUploadFile({ name: 'a.pdf', size: 50 * 1024 * 1024, type: 'application/pdf' })).toEqual({
      ok: true,
    })
    // 两档的差别体现在上限之外：普通文件 50MiB 是天花板，视频还能再往上到 100MiB
    const r = checkUploadFile({ name: 'a.pdf', size: 60 * 1024 * 1024, type: 'application/pdf' })
    expect(r.ok).toBe(false)
  })

  it('webm 也算视频', () => {
    expect(checkUploadFile({ name: 'a.webm', size: 20 * 1024 * 1024, type: 'video/webm' })).toEqual({
      ok: true,
    })
  })

  it('视频不再限死 mp4/webm：MOV/MKV 也放行（服务端按魔数认容器）', () => {
    expect(checkUploadFile({ name: 'a.mov', size: 1024, type: 'video/quicktime' })).toEqual({
      ok: true,
    })
    expect(checkUploadFile({ name: 'a.mkv', size: 1024, type: 'video/x-matroska' })).toEqual({
      ok: true,
    })
  })

  it('可执行文件被拦，并提示压缩成 zip', () => {
    for (const name of ['a.exe', 'a.msi', 'a.dll', 'a.jar', 'a.apk', 'a.dmg']) {
      const r = checkUploadFile({ name, size: 1024 })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.code).toBe('UNSUPPORTED_TYPE')
        expect(r.message).toContain('zip')
      }
    }
  })

  it('任意普通文件格式都放行（不再有类型白名单）', () => {
    for (const name of ['a.docx', 'a.xlsx', 'a.pptx', 'a.rar', 'a.7z', 'a.mp3', 'a.psd', 'a.iso', 'a.bin']) {
      expect(checkUploadFile({ name, size: 1024 })).toEqual({ ok: true })
    }
  })

  it('图片只受 50MiB 档约束（图片不因视频放宽）', () => {
    expect(checkUploadFile({ name: 'a.png', size: MAX_UPLOAD_BYTES, type: 'image/png' })).toEqual({
      ok: true,
    })
    expect(checkUploadFile({ name: 'a.png', size: MAX_UPLOAD_BYTES + 1, type: 'image/png' }).ok).toBe(
      false,
    )
  })
})

describe('attachmentKindOf', () => {
  it('mime 前缀优先', () => {
    expect(attachmentKindOf('image/png', 'x.bin')).toBe('image')
    expect(attachmentKindOf('video/mp4', 'x.bin')).toBe('video')
    expect(attachmentKindOf('application/pdf', 'x.pdf')).toBe('file')
  })

  it('mime 为空时退回扩展名', () => {
    expect(attachmentKindOf('', 'x.mp4')).toBe('video')
    expect(attachmentKindOf(null, 'x.webm')).toBe('video')
    expect(attachmentKindOf(undefined, 'x.png')).toBe('image')
  })

  it('无法判定时兜底 file（最保守的展示形态）', () => {
    expect(attachmentKindOf('', 'x.bin')).toBe('file')
  })
})

describe('checkAttachmentSelection：合计 ≤9 / 视频 ≤1 / 不重复', () => {
  const img = (id: string) => ({ id, kind: 'image' as const })
  const vid = (id: string) => ({ id, kind: 'video' as const })
  const file = (id: string) => ({ id, kind: 'file' as const })

  it('空数组放行', () => {
    expect(checkAttachmentSelection([])).toEqual({ ok: true })
  })

  it('恰好 9 个放行，10 个被拦', () => {
    const nine = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => img(`a${i}`))
    expect(checkAttachmentSelection(nine)).toEqual({ ok: true })
    const r = checkAttachmentSelection([...nine, img('a-extra')])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('TOO_MANY_ATTACHMENTS')
      expect(r.message).toBe('最多 9 个附件，视频最多 1 个')
    }
  })

  it('两个视频被拦（即使总数远不到 9）', () => {
    const r = checkAttachmentSelection([vid('v1'), vid('v2')])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('视频最多')
  })

  it('一个视频 + 8 张图（共 9）放行', () => {
    const list = [vid('v1'), ...Array.from({ length: 8 }, (_, i) => img(`a${i}`))]
    expect(checkAttachmentSelection(list)).toEqual({ ok: true })
  })

  it('重复 id 被拦（同一附件不能重复加两次）', () => {
    const r = checkAttachmentSelection([img('a1'), img('a1')])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('重复')
  })

  it('普通文件不计入视频名额', () => {
    expect(checkAttachmentSelection([file('f1'), file('f2'), vid('v1')])).toEqual({ ok: true })
  })
})

describe('messageTypeOfAttachments（乐观消息的 type 推导）', () => {
  it('无附件 → text', () => {
    expect(messageTypeOfAttachments([])).toBe('text')
  })

  it('单一 kind → 对应类型', () => {
    expect(messageTypeOfAttachments([{ kind: 'image' } as never])).toBe('image')
    expect(messageTypeOfAttachments([{ kind: 'video' } as never])).toBe('video')
    expect(messageTypeOfAttachments([{ kind: 'file' } as never])).toBe('file')
    expect(messageTypeOfAttachments([{ kind: 'file' } as never, { kind: 'file' } as never])).toBe(
      'file',
    )
  })

  it('混合 kind → mixed', () => {
    expect(
      messageTypeOfAttachments([{ kind: 'image' } as never, { kind: 'video' } as never]),
    ).toBe('mixed')
  })
})

describe('isVideoAttachment', () => {
  it('认 kind 也认 mime 前缀', () => {
    expect(isVideoAttachment({ kind: 'video', mimeType: 'application/octet-stream' })).toBe(true)
    expect(isVideoAttachment({ kind: 'file', mimeType: 'video/mp4' })).toBe(true)
    expect(isVideoAttachment({ kind: 'file', mimeType: 'image/png' })).toBe(false)
  })
})

describe('attachmentsPreviewText（会话列表 / 置顶条的多附件文案）', () => {
  it('空数组 → 空串（调用方据此回退到正文）', () => {
    expect(attachmentsPreviewText([])).toBe('')
  })

  it('单个沿用 attachmentPreviewText', () => {
    expect(attachmentsPreviewText([{ kind: 'image', name: 'a.png' }])).toBe('[图片]')
    expect(attachmentsPreviewText([{ kind: 'video', name: 'a.mp4' }])).toBe('[视频]')
    expect(attachmentsPreviewText([{ kind: 'file', name: '报告.pdf' }])).toBe('[文件] 报告.pdf')
  })

  it('同类多个折叠成 ×N（不把 9 个文件名排进单行）', () => {
    expect(
      attachmentsPreviewText([
        { kind: 'image', name: '1.png' },
        { kind: 'image', name: '2.png' },
        { kind: 'image', name: '3.png' },
      ]),
    ).toBe('[图片 ×3]')
  })

  it('混合 kind 归为 [附件]', () => {
    expect(
      attachmentsPreviewText([
        { kind: 'image', name: '1.png' },
        { kind: 'file', name: 'a.pdf' },
      ]),
    ).toBe('[附件]')
  })
})

describe('formatDuration（视频时长角标）', () => {
  it('正常值输出 m:ss', () => {
    expect(formatDuration(0.4)).toBe('0:00')
    expect(formatDuration(5)).toBe('0:05')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(600)).toBe('10:00')
  })

  it('非法 / 非正值返回空串（不渲染 0:00 这种假信息）', () => {
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(-1)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('')
  })
})
