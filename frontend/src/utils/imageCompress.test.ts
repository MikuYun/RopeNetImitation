/**
 * 表情包压缩的纯逻辑单测。
 *
 * 只测不依赖 DOM 的部分（尺寸计算 / 格式判定 / 上限判定 / 文件名）：
 * 本仓库 vitest 没有 jsdom，`compressImageForSticker` 在 node 环境下会直接返回 null，
 * 真正的 canvas 编码只能在浏览器里由 e2e 覆盖。
 *
 * 为什么要测 stickerTargetSize：它是「表情不会因为缩放炸成 0×0 或反向放大」的唯一防线。
 * 一张 4000×1 的长条图、一张 1×1 的图、一张已经只有 100px 的图，都必须得到正确结论。
 */
import { describe, expect, it } from 'vitest'
import {
  STICKER_MAX_BYTES,
  STICKER_MAX_EDGE,
  compressImageForSticker,
  isStickerStaticMime,
  isStickerTooLarge,
  stickerFileName,
  stickerLimitText,
  stickerTargetSize,
} from './imageCompress'

describe('stickerTargetSize', () => {
  it('超过上限的横图按长边等比缩到 512', () => {
    expect(stickerTargetSize(1024, 512)).toEqual({ width: 512, height: 256 })
  })

  it('超过上限的竖图按长边等比缩到 512', () => {
    expect(stickerTargetSize(400, 1600)).toEqual({ width: 128, height: 512 })
  })

  it('正方形缩到 512×512', () => {
    expect(stickerTargetSize(2048, 2048)).toEqual({ width: 512, height: 512 })
  })

  it('已经不超过上限的图不放大，原样返回', () => {
    expect(stickerTargetSize(120, 90)).toEqual({ width: 120, height: 90 })
    expect(stickerTargetSize(STICKER_MAX_EDGE, 1)).toEqual({ width: STICKER_MAX_EDGE, height: 1 })
  })

  it('极端长条图缩放后至少保留 1px，不会出现 0', () => {
    const size = stickerTargetSize(4000, 1)
    expect(size).toEqual({ width: 512, height: 1 })
    expect(stickerTargetSize(1, 4000)).toEqual({ width: 1, height: 512 })
  })

  it('非法尺寸返回 null（而不是算出 NaN 塞进 canvas）', () => {
    expect(stickerTargetSize(Number.NaN, 100)).toBeNull()
    expect(stickerTargetSize(100, Number.POSITIVE_INFINITY)).toBeNull()
    expect(stickerTargetSize(0, 100)).toBeNull()
    expect(stickerTargetSize(-10, 100)).toBeNull()
  })

  it('自定义上限也生效（便于将来调大表情尺寸）', () => {
    expect(stickerTargetSize(1000, 500, 256)).toEqual({ width: 256, height: 128 })
    expect(stickerTargetSize(1000, 500, 0)).toBeNull()
  })
})

describe('isStickerStaticMime', () => {
  it('静图可转码', () => {
    expect(isStickerStaticMime('image/png')).toBe(true)
    expect(isStickerStaticMime('image/jpeg')).toBe(true)
    expect(isStickerStaticMime('image/webp')).toBe(true)
    expect(isStickerStaticMime('IMAGE/PNG')).toBe(true)
  })

  it('GIF 不转码（canvas 只能取首帧，转码会丢动画）', () => {
    expect(isStickerStaticMime('image/gif')).toBe(false)
  })

  it('空值与未知类型按不可压缩处理', () => {
    expect(isStickerStaticMime('')).toBe(false)
    expect(isStickerStaticMime('video/mp4')).toBe(false)
  })
})

describe('isStickerTooLarge', () => {
  it('上限内不算超', () => {
    expect(isStickerTooLarge(0)).toBe(false)
    expect(isStickerTooLarge(STICKER_MAX_BYTES)).toBe(false)
  })

  it('超过上限算超', () => {
    expect(isStickerTooLarge(STICKER_MAX_BYTES + 1)).toBe(true)
  })

  it('size 非法（NaN）按超限处理 —— 宁可拦下也不要存一张来历不明的大图', () => {
    expect(isStickerTooLarge(Number.NaN)).toBe(true)
  })

  it('可传入自定义上限', () => {
    expect(isStickerTooLarge(100, 99)).toBe(true)
    expect(isStickerTooLarge(99, 99)).toBe(false)
  })
})

describe('stickerFileName', () => {
  it('沿用原文件名，扩展名改成 webp', () => {
    expect(stickerFileName('猫猫.png', 'image/webp')).toBe('猫猫.webp')
  })

  it('编码回退成 PNG 时扩展名跟着真实 type 走', () => {
    expect(stickerFileName('猫猫.png', 'image/png')).toBe('猫猫.png')
  })

  it('去掉路径分隔符，避免文件名穿越到目录', () => {
    expect(stickerFileName('a/b\\c.png', 'image/webp')).toBe('abc.webp')
  })

  it('空名字回退成 sticker', () => {
    expect(stickerFileName('', 'image/webp')).toBe('sticker.webp')
    expect(stickerFileName('   ', 'image/webp')).toBe('sticker.webp')
  })

  it('超长名字被截断到 80 字符以内', () => {
    const long = `${'x'.repeat(200)}.png`
    expect(stickerFileName(long, 'image/webp')).toBe(`${'x'.repeat(80)}.webp`)
  })
})

describe('stickerLimitText', () => {
  it('2 MiB 显示为整数 2 MB', () => {
    expect(stickerLimitText()).toBe('2 MB')
  })

  it('自定义上限保留一位小数', () => {
    expect(stickerLimitText(1536 * 1024)).toBe('1.5 MB')
  })
})

describe('compressImageForSticker', () => {
  it('node 环境没有 createImageBitmap，直接返回 null 让调用方回退原图', async () => {
    await expect(compressImageForSticker(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))).resolves.toBeNull()
  })
})
