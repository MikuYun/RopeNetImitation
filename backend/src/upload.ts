import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 上传能力的「文件级」实现：魔数嗅探 + 原子落盘 + 增量 sha256。
 *
 * 为什么不用 multipart：引入 @fastify/multipart 会带新的运行时依赖与一套 multipart 解析
 * 攻击面（边界混淆、超大 part、文件名字节注入），而本项目的客户端是自家前端，
 * 只要「裸二进制 body + filename 查询参数」就够用，协议面更小、更好测、更好审。
 *
 * 为什么按魔数而不是 Content-Type 判定：Content-Type 完全由客户端控制，
 * 把 image/png 说成 text/plain 只需要改一个请求头。真正决定「文件会不会被浏览器当图片执行」
 * 的是字节本身，所以类型必须以字节为准，客户端声明只作为提示丢弃。
 */

/**
 * 业务上限 50 MiB：超过即 413 UPLOAD_TOO_LARGE。
 *
 * 【为什么从 10 MiB 提到 50 MiB】白名单放开到「几乎任何格式」之后，真实文件
 * （压缩包、设计稿、Office 文档、字体包）动辄二三十 MiB。只放宽格式却死守 10 MiB，
 * 等于把「不支持的类型」换成了「太大发不了」，用户拿到的仍是拒绝。
 * 图片与视频的上限语义不变（视频 100 MiB，见 MAX_VIDEO_BYTES）。
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * 传输层 bodyLimit 51 MiB = 业务上限 + 1 MiB 余量。
 * 两层上限分开的理由：bodyLimit 是 fastify 在解析阶段就能拒绝的硬闸（省内存），
 * 而业务上限要由我们自己回一个带错误码的 413；留出 1 MiB 余量保证
 * 「50 MiB < size ≤ 51 MiB」这种刚好越界的情况会走到业务判定、拿到 UPLOAD_TOO_LARGE，
 * 而不是被解析层提前掐断成通用错误。
 *
 * 注意：上传路由实际注册的解析器用的是最宽的一档 UPLOAD_BODY_LIMIT_VIDEO
 * （解析阶段还无法知道这次传的是不是视频）；本常量保留给反代配置校验
 * （backend/test/deploy-headers.test.ts）对齐使用。
 */
export const UPLOAD_BODY_LIMIT = 51 * 1024 * 1024;

/** 视频业务上限 100 MiB（契约 §3：视频单独一档，图片/普通文件仍 50 MiB）。 */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * 视频上传的传输层 bodyLimit = 100 MiB + 1 MiB 余量。
 * 与 UPLOAD_BODY_LIMIT 同理：留 1 MiB 让「100 MiB < size ≤ 101 MiB」走到业务判定，
 * 由我们回带错误码的 413 UPLOAD_TOO_LARGE，而不是被 fastify 解析层掐断成通用错误。
 * 路由层按「本次上传声明的 kind」在 UPLOAD_BODY_LIMIT / UPLOAD_BODY_LIMIT_VIDEO 之间选。
 */
export const UPLOAD_BODY_LIMIT_VIDEO = MAX_VIDEO_BYTES + 1024 * 1024;

/**
 * 单张表情包的体积上限 2 MiB。
 *
 * 【为什么表情要单独卡上限】表情包是**长期**占用磁盘的收藏品：上传的原图会跟着
 * 保留策略被清掉，但被收藏的 upload 因为 `stickers` 引用而永远保留（sweep 把
 * stickers 算作在用引用）。等于每个用户可以永久占用「表情数量 × 原图体积」，
 * 几十个人各存几张图就能把磁盘吃掉。前端收藏时会先压到 512px 的 WebP，
 * 这里再做一次服务端兜底（客户端可以被绕过）。
 */
export const MAX_STICKER_BYTES = 2 * 1024 * 1024;

interface Signature {
  mimeType: string;
  test: (bytes: Buffer) => boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ISO BMFF：偏移 4..8 一定是 'ftyp'，偏移 8..12 是 major brand。 */
function ftypBrand(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  return bytes.subarray(4, 8).toString('latin1') === 'ftyp' ? bytes.subarray(8, 12).toString('latin1') : null;
}

/**
 * 可执行文件魔数黑名单：命中即 415。
 *
 * 【这不是安全边界】真正的边界在下载侧：`X-Content-Type-Options: nosniff` +
 * `Content-Security-Policy: default-src 'none'; sandbox` + 非图片强制
 * `Content-Disposition: attachment` 三件套，保证任何字节都不会在站内被执行。
 * 这里只是一条产品上的便利保护 —— 不让聊天平台变成裸 exe 的分发通道
 * （打包成 zip 依然可以传，这与主流 IM 的做法一致）。
 */
const EXECUTABLES: Array<{ label: string; test: (bytes: Buffer) => boolean }> = [
  {
    label: 'Windows 可执行文件',
    // 只认真正的 PE：DOS 头 + e_lfanew 指向 'PE\0\0'。
    // 单纯以 "MZ" 开头的文本（例如以「MZ-80 笔记」起头的 md）不能被误伤成可执行文件。
    test: bytes => {
      if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false;
      const offset = bytes.readUInt32LE(0x3c);
      if (offset < 0x40 || offset + 4 > bytes.length) return false;
      return bytes.subarray(offset, offset + 4).toString('latin1') === 'PE\u0000\u0000';
    },
  },
  {
    label: 'Linux 可执行文件',
    test: bytes => bytes.length >= 4 && bytes[0] === 0x7f && bytes.subarray(1, 4).toString('latin1') === 'ELF',
  },
  {
    label: 'macOS 可执行文件',
    test: bytes => {
      if (bytes.length < 4) return false;
      const magic = bytes.subarray(0, 4).toString('hex');
      return magic === 'feedface' || magic === 'cefaedfe' || magic === 'feedfacf' || magic === 'cffaedfe';
    },
  },
  {
    label: 'Java 类文件',
    test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('hex') === 'cafebabe',
  },
];

/** 命中可执行文件魔数时返回给人看的类型标签；null = 不是可执行文件。 */
export function blockedExecutableLabel(bytes: Buffer): string | null {
  for (const entry of EXECUTABLES) if (entry.test(bytes)) return entry.label;
  return null;
}

/**
 * 魔数白名单（顺序即优先级，先命中先返回）。
 *
 * 【v2.3 的定位变了】它不再是「准入名单」，而是「**能认出具体类型的名单**」：
 * 认不出来的二进制不再被 415 拒绝，而是落到 application/octet-stream 当通用文件下载。
 * 因此这里只做两件事：把能安全 inline 渲染的媒体认出来（图片/音频/视频），
 * 把常见文档与压缩包认出来（好给出正确的图标与扩展名）。
 *
 * 【为什么不再担心 XSS】加密后的判定只影响 Content-Type 与扩展名；
 * 下载响应头（nosniff + sandbox CSP + 非图片强制 attachment）决定了
 * HTML/SVG/脚本即使被上传也只会被当成文件下载，无法在本域执行。
 * 唯一 inline 的是 image/* 且必须魔数命中真实图片格式（SVG 是文本，永远走不到 image/*）。
 */
const SIGNATURES: Signature[] = [
  // ── 图片：只收浏览器能直接渲染的（避免 <img> 裂图）──
  { mimeType: 'image/png', test: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) },
  { mimeType: 'image/jpeg', test: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  {
    mimeType: 'image/webp',
    test: bytes => bytes.length >= 12
      && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mimeType: 'image/gif', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    // BMP 以 'BM' 起头，但文本也可能以 "BM" 开头（如 "BMW 说明书"），
    // 所以再要求「保留字段为 0」+「DIB 头长度是已知值」两个硬特征。
    mimeType: 'image/bmp',
    test: bytes => {
      if (bytes.length < 18 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return false;
      if (bytes.readUInt32LE(6) !== 0) return false;
      return [12, 40, 52, 56, 64, 108, 124].includes(bytes.readUInt32LE(14));
    },
  },
  { mimeType: 'image/x-icon', test: bytes => bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 },
  // AVIF 是 ISO BMFF 家族，必须在通用 ftyp 规则之前命中，否则会被当成视频。
  // HEIC/HEIF 同理但浏览器不能渲染，故意不放进来（回落成通用文件下载）。
  {
    mimeType: 'image/avif',
    test: bytes => {
      const brand = ftypBrand(bytes);
      return brand === 'avif' || brand === 'avis';
    },
  },
  // ── 音频 ──
  {
    mimeType: 'audio/wav',
    test: bytes => bytes.length >= 12
      && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WAVE',
  },
  { mimeType: 'audio/flac', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'fLaC' },
  { mimeType: 'audio/ogg', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'OggS' },
  {
    mimeType: 'audio/mp4',
    test: bytes => {
      const brand = ftypBrand(bytes);
      return brand !== null && ['M4A ', 'M4B ', 'M4P ', 'F4A ', 'mp4a'].includes(brand);
    },
  },
  { mimeType: 'audio/amr', test: bytes => bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '#!AMR' },
  { mimeType: 'audio/midi', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'MThd' },
  {
    mimeType: 'audio/x-ms-wma',
    test: bytes => bytes.length >= 4 && bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2 && bytes[3] === 0x75,
  },
  // ADTS 帧头（AAC）必须在 MP3 的「0xFFEx 同步字」规则之前，否则 aac 会被判成 mp3。
  { mimeType: 'audio/aac', test: bytes => bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] === 0xf1 || bytes[1] === 0xf9) },
  {
    mimeType: 'audio/mpeg',
    test: bytes => {
      if (bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'ID3') return true;
      if (bytes.length < 2 || bytes[0] !== 0xff) return false;
      // noUncheckedIndexedAccess：已用 length>=2 收窄，这里显式断言掉 undefined。
      const second = bytes[1] as number;
      return [0xfa, 0xfb, 0xf3, 0xf2].includes(second);
    },
  },
  // ── 文档 ──
  { mimeType: 'application/pdf', test: bytes => bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-' },
  // doc/xls/ppt 共用的 OLE2 复合文档头。三者无法在字节层区分，统一交给扩展名出图标。
  {
    mimeType: 'application/x-ole-storage',
    test: bytes => bytes.length >= 8
      && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0
      && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1,
  },
  { mimeType: 'application/rtf', test: bytes => bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '{\\rtf' },
  // ── 压缩包 / 归档 ──
  {
    mimeType: 'application/zip',
    test: bytes => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
      && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08)),
  },
  {
    mimeType: 'application/x-rar-compressed',
    test: bytes => bytes.length >= 7 && bytes.subarray(0, 4).toString('latin1') === 'Rar!',
  },
  {
    mimeType: 'application/x-7z-compressed',
    test: bytes => bytes.length >= 6 && bytes.subarray(0, 6).toString('hex') === '377abcaf271c',
  },
  { mimeType: 'application/gzip', test: bytes => bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b },
  {
    mimeType: 'application/x-bzip2',
    test: bytes => bytes.length >= 3 && bytes.subarray(0, 3).toString('latin1') === 'BZh',
  },
  {
    mimeType: 'application/x-xz',
    test: bytes => bytes.length >= 6 && bytes.subarray(0, 6).toString('hex') === 'fd377a585a00',
  },
  {
    mimeType: 'application/zstd',
    test: bytes => bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd,
  },
  // tar 没有头部魔数，只有偏移 257 处的 'ustar' 标记（GNU 是 'ustar  \0'，POSIX 是 'ustar\0'）。
  {
    mimeType: 'application/x-tar',
    test: bytes => bytes.length >= 265 && bytes.subarray(257, 262).toString('latin1') === 'ustar',
  },
  {
    mimeType: 'application/vnd.ms-cab-compressed',
    test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'MSCF',
  },
  // ── 字体 ──
  { mimeType: 'font/woff', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'wOFF' },
  { mimeType: 'font/woff2', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'wOF2' },
  { mimeType: 'font/otf', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'OTTO' },
  {
    mimeType: 'font/ttf',
    test: bytes => bytes.length >= 5
      && ((bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00 && bytes[4] === 0x00)
        || bytes.subarray(0, 4).toString('latin1') === 'true'),
  },
  // ── 视频（放在最后：通用 ftyp 会把 avif/m4a 抢走，所以它们必须排在前面）──
  {
    mimeType: 'video/mp4',
    test: bytes => bytes.length >= 8 && bytes.subarray(4, 8).toString('latin1') === 'ftyp',
  },
  // WebM/Matroska 共用 EBML 头。这里不去解析 DocType：两者都是 <video> 能播的容器，
  // 统一归到 video/webm 只会影响扩展名（.webm），不会影响安全性或播放能力。
  {
    mimeType: 'video/webm',
    test: bytes => bytes.length >= 4
      && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3,
  },
];

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 纯文本判定：无 NUL 字节且能被严格 UTF-8 解码。
 * fatal 模式的 TextDecoder 会拒绝替换字符，避免把随机二进制当作「能解码」放行；
 * NUL 检查则是为了挡住 UTF-8 合法但明显是二进制（如部分 UTF-16/结构化数据）的内容。
 */
function isPlainText(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  if (bytes.includes(0)) return false;
  try {
    UTF8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * 返回服务端认定的 mime（永不返回 null）。
 *
 * 判定顺序：魔数白名单 → 严格 UTF-8 纯文本 → `application/octet-stream` 兜底。
 *
 * 【兜底是 v2.3 的核心变化】以前认不出的二进制会 415「不支持的文件类型」，
 * 结果就是「除了 png/pdf/zip，什么都不能发」。现在认不出只会失去「具体类型」
 * 这个便利（图标退化成通用文件、磁盘扩展名 .bin），文件本身照样能传能下：
 * 下载时由 nosniff + sandbox CSP + attachment 三件套兜住安全。
 * 真正被拒的只有可执行文件，见 blockedExecutableLabel。
 */
export function detectMimeType(bytes: Buffer): string {
  for (const signature of SIGNATURES) {
    if (signature.test(bytes)) return signature.mimeType;
  }
  return isPlainText(bytes) ? 'text/plain' : 'application/octet-stream';
}

/** 存储用扩展名。由 mime 推导（而不是沿用客户端文件名），保证磁盘上的名字不可被客户端影响。 */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico',
  'image/avif': '.avif',
  'audio/wav': '.wav',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'audio/midi': '.mid',
  'audio/x-ms-wma': '.wma',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
  'application/x-ole-storage': '.ole',
  'application/rtf': '.rtf',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'application/x-7z-compressed': '.7z',
  'application/gzip': '.gz',
  'application/x-bzip2': '.bz2',
  'application/x-xz': '.xz',
  'application/zstd': '.zst',
  'application/x-tar': '.tar',
  'application/vnd.ms-cab-compressed': '.cab',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/otf': '.otf',
  'font/ttf': '.ttf',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'application/octet-stream': '.bin',
};

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? '.bin';
}

/** 磁盘文件名 = <id><扩展名>；id 是服务端生成的 UUID，因此不含任何客户端输入。 */
export function uploadPath(dir: string, id: string, mimeType: string): string {
  return join(dir, `${id}${extensionFor(mimeType)}`);
}

export type UploadKind = 'image' | 'video' | 'file';

export function kindFor(mimeType: string): UploadKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/** 是否为视频（判断依据是服务端嗅探出的 mime，不是客户端声明）。 */
export function isVideo(mimeType: string): boolean {
  return mimeType.startsWith('video/');
}

/**
 * 启动期就验证目录可用：不可写必须让进程起不来。
 * 否则第一次真实上传才会失败，而那时错误会以 500 的形式出现在用户面前，
 * 运维也拿不到「配置错了」这个信号。
 */
export function ensureUploadsDir(dir: string): void {
  const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`uploads directory is not writable: ${dir} (${detail})`);
  }
}

/**
 * 原子落盘：先写 <target>.tmp，fsync 后 rename 成正式名。
 * - rename 在同一文件系统内是原子的，因此读取侧永远看不到半个文件；
 * - 边写边算 sha256，避免「先写盘再整块读回来算哈希」的第二次 IO；
 * - 任何失败都在 catch 里删掉临时文件，不留孤儿 .tmp。
 */
export function writeUpload(dir: string, id: string, mimeType: string, bytes: Buffer): { sha256: string; size: number } {
  const target = uploadPath(dir, id, mimeType);
  const temporary = `${target}.tmp`;
  const hash = createHash('sha256');
  let descriptor: number | null = null;
  const chunkSize = 64 * 1024;
  try {
    descriptor = openSync(temporary, 'w', 0o600);
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      hash.update(chunk);
      writeSync(descriptor, chunk);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
    return { sha256: hash.digest('hex'), size: bytes.length };
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch { /* 关闭失败不掩盖原始错误 */ }
    }
    try { unlinkSync(temporary); } catch { /* 临时文件可能还没创建，忽略 */ }
    throw error;
  }
}

/** 删除磁盘文件；文件已不存在视为成功（清理是幂等的）。 */
export function removeUploadFile(dir: string, id: string, mimeType: string): boolean {
  try {
    unlinkSync(uploadPath(dir, id, mimeType));
    return true;
  } catch {
    return false;
  }
}

/**
 * 文件名只做展示用途，但必须清洗：
 * 去掉路径分隔符（防止 `../` 之类的展示欺骗）、控制字符（防止响应头/日志注入），
 * 并限制长度。真正的磁盘文件名由 id 决定，这里不会参与任何路径拼接。
 */
export function sanitizeFilename(candidate: string | undefined): string {
  const base = (candidate ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = cleaned.length > 0 ? cleaned : '未命名文件';
  return name.length > 120 ? name.slice(0, 120) : name;
}
