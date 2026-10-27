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

/** 业务上限 10 MiB：超过即 413 UPLOAD_TOO_LARGE。 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * 传输层 bodyLimit 11 MiB = 业务上限 + 1 MiB 余量。
 * 两层上限分开的理由：bodyLimit 是 fastify 在解析阶段就能拒绝的硬闸（省内存），
 * 而业务上限要由我们自己回一个带错误码的 413；留出 1 MiB 余量保证
 * 「10 MiB < size ≤ 11 MiB」这种刚好越界的情况会走到业务判定、拿到 UPLOAD_TOO_LARGE，
 * 而不是被解析层提前掐断成通用错误。
 */
export const UPLOAD_BODY_LIMIT = 11 * 1024 * 1024;

interface Signature {
  mimeType: string;
  test: (bytes: Buffer) => boolean;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 魔数白名单（顺序即优先级，先命中先返回）。
 * 只收录「能安全 inline 展示或明确可附件下载」的类型：
 * 可执行文件、脚本、HTML、SVG 一律不进白名单 —— 它们进白名单就意味着
 * 上传接口变成 XSS/挂马的分发通道。
 */
const SIGNATURES: Signature[] = [
  { mimeType: 'image/png', test: bytes => bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) },
  { mimeType: 'image/jpeg', test: bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  {
    mimeType: 'image/webp',
    test: bytes => bytes.length >= 12
      && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { mimeType: 'image/gif', test: bytes => bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === 'GIF8' },
  { mimeType: 'application/pdf', test: bytes => bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-' },
  {
    mimeType: 'application/zip',
    test: bytes => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04,
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

/** 返回服务端认定的 mime；null = 不在白名单（调用方回 415）。 */
export function detectMimeType(bytes: Buffer): string | null {
  for (const signature of SIGNATURES) {
    if (signature.test(bytes)) return signature.mimeType;
  }
  return isPlainText(bytes) ? 'text/plain' : null;
}

/** 存储用扩展名。由 mime 推导（而不是沿用客户端文件名），保证磁盘上的名字不可被客户端影响。 */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
};

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? '.bin';
}

/** 磁盘文件名 = <id><扩展名>；id 是服务端生成的 UUID，因此不含任何客户端输入。 */
export function uploadPath(dir: string, id: string, mimeType: string): string {
  return join(dir, `${id}${extensionFor(mimeType)}`);
}

export type UploadKind = 'image' | 'file';

export function kindFor(mimeType: string): UploadKind {
  return mimeType.startsWith('image/') ? 'image' : 'file';
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
