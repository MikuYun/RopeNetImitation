import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const base = process.argv[2]
const files = []
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.data', 'evidence', 'backups'].includes(e.name)) continue
      walk(p)
    } else {
      // 跳过工具链的临时锁文件：它们是 0 字节、写文件时出现、写完即删的副作用，
      // 若被算进指纹，会让「同一份源码」在两次采样里得到不同聚合值（假漂移）。
      if (/^\.dsh-ops-update-.*\.lock$/.test(e.name)) continue
      files.push(relative(base, p).replaceAll('\\', '/'))
    }
  }
}
walk(base)
files.sort()
const h = createHash('sha256')
for (const f of files) {
  h.update(createHash('sha256').update(readFileSync(join(base, f))).digest('hex'))
  h.update(f)
}
console.log(`${base} files=${files.length} aggregate=${h.digest('hex')}`)
