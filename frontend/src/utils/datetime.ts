import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import isToday from 'dayjs/plugin/isToday'
import isYesterday from 'dayjs/plugin/isYesterday'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.extend(isToday)
dayjs.extend(isYesterday)
dayjs.locale('zh-cn')

export type ISODateTime = string

/** 解析服务端 ISO 8601 UTC 毫秒时间戳。 */
export function parseIso(iso: ISODateTime | null | undefined): dayjs.Dayjs | null {
  if (!iso) return null
  const d = dayjs(iso)
  return d.isValid() ? d : null
}

/** 会话列表右侧的短时间：今天 HH:mm，昨天「昨天」，本年 M/D，跨年 YYYY/M/D。 */
export function formatListTime(iso: ISODateTime | null | undefined): string {
  const d = parseIso(iso)
  if (!d) return ''
  if (d.isToday()) return d.format('HH:mm')
  if (d.isYesterday()) return '昨天'
  if (d.year() === dayjs().year()) return d.format('M/D')
  return d.format('YYYY/M/D')
}

/** 气泡上方的精确时间。 */
export function formatBubbleTime(iso: ISODateTime | null | undefined): string {
  const d = parseIso(iso)
  if (!d) return ''
  if (d.isToday()) return d.format('HH:mm')
  if (d.isYesterday()) return `昨天 ${d.format('HH:mm')}`
  if (d.year() === dayjs().year()) return d.format('M月D日 HH:mm')
  return d.format('YYYY年M月D日 HH:mm')
}

/** 日期分隔条文案。 */
export function formatDateDivider(iso: ISODateTime): string {
  const d = parseIso(iso)
  if (!d) return ''
  if (d.isToday()) return '今天'
  if (d.isYesterday()) return '昨天'
  const diffDays = dayjs().startOf('day').diff(d.startOf('day'), 'day')
  if (diffDays > 0 && diffDays < 7) return d.format('dddd')
  if (d.year() === dayjs().year()) return d.format('M月D日')
  return d.format('YYYY年M月D日')
}

/** 判断两条消息是否应插入日期分隔条。 */
export function needsDateDivider(
  current: ISODateTime,
  previous: ISODateTime | null | undefined,
): boolean {
  if (!previous) return true
  return !dayjs(current).isSame(dayjs(previous), 'day')
}

/** 相邻两条消息间隔超过阈值则显示时间（业界通用的 5 分钟阈值）。 */
export function needsTimeLabel(
  current: ISODateTime,
  previous: ISODateTime | null | undefined,
  thresholdMinutes = 5,
): boolean {
  if (!previous) return true
  return Math.abs(dayjs(current).diff(dayjs(previous), 'minute')) >= thresholdMinutes
}

/** 相对时间，如「3 分钟前」。用于最后在线。 */
export function fromNow(iso: ISODateTime | null | undefined): string {
  const d = parseIso(iso)
  return d ? d.fromNow() : ''
}

/** 由 userId 派生一个稳定的头像底色（原创色板内取色）。 */
export function avatarColorOf(seed: string): string {
  const palette = [
    '#2187ae',
    '#2f9e6e',
    '#d08b2c',
    '#8b6fd1',
    '#d64545',
    '#41a3c9',
    '#c2578f',
    '#5c7f3f',
  ]
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return palette[hash % palette.length] ?? palette[0]!
}
