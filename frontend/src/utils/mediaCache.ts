/**
 * 媒体本地缓存层（内存 LRU → IndexedDB → 网络）。
 *
 * 背景：附件/头像/表情每渲染一次都要带 Bearer 走一遍 `GET /api/v1/uploads/:id`。
 * 消息列表滚动时组件反复挂载/卸载（AttachmentView 在 `onUnmounted` 里 revoke），
 * 控制台因此出现上千个请求并触发 429。本模块在「取字节」这一层加三层缓存：
 *
 *   1. 内存层（同步命中，最快）：key → { blob, bytes, usedAt } 的 LRU 表。
 *      不存 objectURL —— URL 单独一张 `keyToUrl` 表管理，见下。
 *   2. IndexedDB 层（持久化，刷新页面/重启浏览器仍命中）：`blobs` 存 Blob，
 *      `meta` 存 { bytes, usedAt }；总容量上限 200 MiB，超限按 usedAt 淘汰最久未用。
 *   3. 网络：loader 由调用方注入（`@/api/uploads` 里用项目的 `http` 实例），
 *      只在 1/2 都 miss 且没有在途相同请求时才调用。
 *
 * 【objectURL 生命周期（关键契约）】
 *   - 同一 key 同时只有一个存活 objectURL。命中内存层时**复用**它，不新建；
 *   - 用**引用计数**保护共享：每次 `getCachedObjectUrl` 成功都把该 URL 的 ref +1，
 *     调用方 `releaseCachedObjectUrl()` 递减，最后一个持有者才真正
 *     `URL.revokeObjectURL`。若直接 revoke，另一个仍显示同一附件的组件会破图
 *     （表情面板 / 消息气泡 / 头像都可能指向同一个 upload id）；
 *   - revoke 只摘掉「key → URL」这条内存关联，**不删** IndexedDB 里的 blob，
 *     也不丢内存里的 blob：下次同 key 再取会立刻重建一个新 URL，0 网络请求；
 *   - revoke **幂等**：重复 revoke 同一个 URL 是安全空操作；
 *   - 非本层创建的 blob URL（例如 MessageComposer 的本地 File 预览）走同一条
 *     `releaseCachedObjectUrl` 时因为没有 ref 记录，直接 revoke —— 与老
 *     `revokeObjectUrl` 行为完全一致。
 *
 * 【失败降级】
 *   indexedDB 不存在 / 开库失败（隐私模式、SecurityError）/ 事务报错 /
 *   QuotaExceededError 一律静默退化为纯内存：写穿 IDB 是 best-effort，
 *   任何一步失败都不向渲染链路抛异常。
 *
 * 【并发去重】
 *   同一 key 的并发 `getCachedBlob` / `getCachedObjectUrl` 共享同一个 Promise
 *   （blob 表 + URL 表两级），既只发一次网络请求，也只创建一次 objectURL。
 */

/** IndexedDB 层容量上限：200 MiB，超限淘汰最久未用的条目。 */
export const MEDIA_CACHE_IDB_BUDGET_BYTES = 200 * 1024 * 1024

/** 内存层容量上限（blob 数据本身）；与条目数上限共同兜底。 */
const MEMORY_BUDGET_BYTES = 96 * 1024 * 1024
const MEMORY_MAX_ENTRIES = 200
/** 单条 blob 超过这个大小就不进内存 LRU（大视频不挤占图片缓存），但 IDB 照存。 */
const MEMORY_MAX_ENTRY_BYTES = 16 * 1024 * 1024
/** 开库最长等待：被别的标签页 blocked 时不能让首屏一直等它。 */
const IDB_OPEN_TIMEOUT_MS = 3_000
/** 读命中后回写 meta.usedAt 的节流间隔，避免每次命中都写一次事务。 */
const META_TOUCH_INTERVAL_MS = 30_000

const IDB_DB_NAME = 'aitrance-media-cache'
const IDB_VERSION = 1
const BLOB_STORE = 'blobs'
const META_STORE = 'meta'

interface MemoryEntry {
  key: string
  blob: Blob
  bytes: number
  usedAt: number
}

/** `meta` 存的结构；单独一张表是为了淘汰时不把 200MB 的 blob 全读出来。 */
interface StoredMeta {
  key: string
  bytes: number
  usedAt: number
}

interface StoredBlob {
  key: string
  blob: Blob
}

/* ── 内存层 ─────────────────────────────────────────────────────── */

const memory = new Map<string, MemoryEntry>()
/** key → 当前存活的 objectURL（同一 key 至多一个）。 */
const keyToUrl = new Map<string, string>()
/** objectURL → key，用于 revoke 时反查。 */
const urlToKey = new Map<string, string>()
/** objectURL → 引用计数；只有归零才真正 revoke。 */
const urlRefs = new Map<string, number>()

const blobInFlight = new Map<string, Promise<Blob>>()
const urlInFlight = new Map<string, Promise<string>>()

const counters = {
  memoryHits: 0,
  idbHits: 0,
  inflightJoins: 0,
  networkLoads: 0,
}

/** 缓存代际：clearMediaCache 时 +1，作废清空瞬间仍在途的请求结果。 */
let cacheEpoch = 0

function safeRevoke(url: string): void {
  try {
    URL.revokeObjectURL(url)
  } catch {
    /* 非浏览器环境 / 非法 URL：忽略 */
  }
}

function addRef(url: string): void {
  urlRefs.set(url, (urlRefs.get(url) ?? 0) + 1)
}

function memoryTouch(entry: MemoryEntry): void {
  entry.usedAt = Date.now()
  // Map 的插入顺序即 LRU 顺序：删了再插 = 移到队尾
  memory.delete(entry.key)
  memory.set(entry.key, entry)
}

/**
 * 按「总字节 + 条目数」淘汰内存 LRU。
 *
 * 优先淘汰没有存活 objectURL 的条目；仍超限时再丢有 URL 的条目（blob 数据
 * 其实还被 URL 引用着，丢的只是 JS 侧的缓存引用，不会让图片破图）。
 */
function enforceMemoryBudget(): void {
  let bytes = 0
  for (const entry of memory.values()) bytes += entry.bytes
  if (bytes <= MEMORY_BUDGET_BYTES && memory.size <= MEMORY_MAX_ENTRIES) return

  const oldest = [...memory.values()].sort((a, b) => a.usedAt - b.usedAt)
  for (const entry of oldest) {
    if (bytes <= MEMORY_BUDGET_BYTES && memory.size <= MEMORY_MAX_ENTRIES) return
    if (keyToUrl.has(entry.key)) continue
    memory.delete(entry.key)
    bytes -= entry.bytes
  }
  for (const entry of oldest) {
    if (bytes <= MEMORY_BUDGET_BYTES && memory.size <= MEMORY_MAX_ENTRIES) return
    if (!memory.delete(entry.key)) continue
    bytes -= entry.bytes
  }
}

function memoryInsert(key: string, blob: Blob): void {
  if (blob.size > MEMORY_MAX_ENTRY_BYTES) return
  const existing = memory.get(key)
  if (existing) {
    existing.blob = blob
    existing.bytes = blob.size
    memoryTouch(existing)
    return
  }
  memory.set(key, { key, blob, bytes: blob.size, usedAt: Date.now() })
  enforceMemoryBudget()
}

/* ── IndexedDB 层 ───────────────────────────────────────────────── */

let dbPromise: Promise<IDBDatabase | null> | null = null
/** 开库彻底失败（隐私模式 / SecurityError）后不再重试。 */
let idbUnavailable = false
let idbIndexLoaded = false
let idbBytes = 0
const idbSizes = new Map<string, number>()

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve()
    }
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    }
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

/** 开库（best-effort）。失败/超时返回 null，调用方静默降级。 */
function openDb(): Promise<IDBDatabase | null> {
  if (idbUnavailable) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  if (!hasIndexedDb()) {
    idbUnavailable = true
    return Promise.resolve(null)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const opening = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false
    const finish = (db: IDBDatabase | null): void => {
      if (settled) {
        if (db) {
          try {
            db.close()
          } catch {
            /* 忽略 */
          }
        }
        return
      }
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (db === null) dbPromise = null // 允许后续重试（例如临时被 blocked）
      resolve(db)
    }

    try {
      const request = indexedDB.open(IDB_DB_NAME, IDB_VERSION)
      timer = setTimeout(() => finish(null), IDB_OPEN_TIMEOUT_MS)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' })
      }
      request.onsuccess = () => {
        const db = request.result
        // 别的标签页要升级版本时主动让路，避免把它 block 死
        db.onversionchange = () => {
          try {
            db.close()
          } catch {
            /* 忽略 */
          }
          dbPromise = null
        }
        finish(db)
      }
      request.onerror = () => {
        idbUnavailable = true
        finish(null)
      }
      // onblocked：不 resolve，交给超时兜底（不能阻塞渲染）
    } catch {
      idbUnavailable = true
      finish(null)
    }
  })

  dbPromise = opening
  return opening
}

let writeChain: Promise<void> = Promise.resolve()

/** 串行化所有 IDB 写操作：避免并发 put/淘汰互相踩（idbBytes 记账也不会错乱）。 */
function queueWrite(task: () => Promise<void>): void {
  writeChain = writeChain.then(task, task).catch(() => {
    /* best-effort：写穿失败不影响任何调用方 */
  })
}

async function ensureIdbIndex(db: IDBDatabase): Promise<void> {
  if (idbIndexLoaded) return
  idbIndexLoaded = true
  try {
    const metas = await requestAsPromise<StoredMeta[]>(
      db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll() as IDBRequest<StoredMeta[]>,
    )
    idbSizes.clear()
    idbBytes = 0
    for (const meta of metas) {
      idbSizes.set(meta.key, meta.bytes)
      idbBytes += meta.bytes
    }
  } catch {
    // 读不出索引就当空库：容量预测失效，但读写仍会照常进行
  }
}

async function writeEntry(db: IDBDatabase, key: string, blob: Blob): Promise<void> {
  const tx = db.transaction([BLOB_STORE, META_STORE], 'readwrite')
  const done = transactionDone(tx)
  tx.objectStore(BLOB_STORE).put({ key, blob } satisfies StoredBlob)
  tx.objectStore(META_STORE).put({ key, bytes: blob.size, usedAt: Date.now() } satisfies StoredMeta)
  await done
  const previous = idbSizes.get(key) ?? 0
  idbSizes.set(key, blob.size)
  idbBytes += blob.size - previous
}

async function deleteIdbKeys(db: IDBDatabase, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return
  const tx = db.transaction([BLOB_STORE, META_STORE], 'readwrite')
  const done = transactionDone(tx)
  const blobStore = tx.objectStore(BLOB_STORE)
  const metaStore = tx.objectStore(META_STORE)
  for (const key of keys) {
    blobStore.delete(key)
    metaStore.delete(key)
  }
  await done
  for (const key of keys) {
    const bytes = idbSizes.get(key)
    if (bytes === undefined) continue
    idbSizes.delete(key)
    idbBytes = Math.max(0, idbBytes - bytes)
  }
}

/** 从最久未用的开始删，腾出至少 targetBytes 空间。 */
async function evictForSpace(db: IDBDatabase, targetBytes: number, keepKey: string): Promise<void> {
  const metas = await requestAsPromise<StoredMeta[]>(
    db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll() as IDBRequest<StoredMeta[]>,
  )
  const candidates = metas.filter((meta) => meta.key !== keepKey).sort((a, b) => a.usedAt - b.usedAt)
  const victims: string[] = []
  let freed = 0
  for (const meta of candidates) {
    if (freed >= targetBytes) break
    victims.push(meta.key)
    freed += meta.bytes
  }
  await deleteIdbKeys(db, victims)
}

async function readFromIdb(key: string): Promise<Blob | null> {
  if (idbUnavailable) return null
  const db = await openDb()
  if (!db) return null
  try {
    // 两个 get 在同一个事务里一次性发出：中间不能 await 别的东西，
    // 否则事务可能在两个请求之间自动提交（InvalidStateError）。
    const tx = db.transaction([BLOB_STORE, META_STORE], 'readonly')
    const blobReq = tx.objectStore(BLOB_STORE).get(key) as IDBRequest<StoredBlob | undefined>
    const metaReq = tx.objectStore(META_STORE).get(key) as IDBRequest<StoredMeta | undefined>
    const [record, meta] = await Promise.all([
      requestAsPromise<StoredBlob | undefined>(blobReq),
      requestAsPromise<StoredMeta | undefined>(metaReq),
    ])
    if (!record || !(record.blob instanceof Blob)) return null
    const usedAt = meta?.usedAt ?? 0
    if (Date.now() - usedAt > META_TOUCH_INTERVAL_MS) queueWrite(() => touchMeta(key))
    return record.blob
  } catch {
    return null
  }
}

/** 只刷新 usedAt（LRU 依据），并在同一个事务里完成 get + put，避免事务已提交。 */
async function touchMeta(key: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  const tx = db.transaction(META_STORE, 'readwrite')
  const done = transactionDone(tx)
  const store = tx.objectStore(META_STORE)
  const request = store.get(key) as IDBRequest<StoredMeta | undefined>
  request.onsuccess = () => {
    const meta = request.result
    if (!meta) return
    meta.usedAt = Date.now()
    store.put(meta)
  }
  await done
}

/** 写穿 IDB（best-effort）：超预算先淘汰，配额失败再砍一批重试一次，仍失败就放弃。
 *
 * `epoch` 是调度时捕获的缓存代际：如果真正执行时缓存已被 `clearMediaCache()`
 * 作废，就直接放弃 —— 否则登出后一个奴隶的晚到响应会把上一账号的字节又写回去。
 */
async function persistToIdb(key: string, blob: Blob, epoch: number): Promise<void> {
  const bytes = blob.size
  if (bytes <= 0 || bytes > MEDIA_CACHE_IDB_BUDGET_BYTES) return
  if (epoch !== cacheEpoch) return
  const db = await openDb()
  if (!db) return
  await ensureIdbIndex(db)
  if (epoch !== cacheEpoch) return

  const previous = idbSizes.get(key) ?? 0
  const projected = idbBytes - previous + bytes
  if (projected > MEDIA_CACHE_IDB_BUDGET_BYTES) {
    await evictForSpace(db, projected - MEDIA_CACHE_IDB_BUDGET_BYTES, key)
    if (idbBytes - (idbSizes.get(key) ?? 0) + bytes > MEDIA_CACHE_IDB_BUDGET_BYTES) return
  }

  try {
    await writeEntry(db, key, blob)
  } catch {
    // 浏览器按「源」给的真实配额可能远小于 200MB：砍掉 1/4 再试一次
    try {
      await evictForSpace(db, Math.max(bytes, Math.floor(idbBytes / 4)), key)
      await writeEntry(db, key, blob)
    } catch {
      /* 静默降级：纯内存仍可用 */
    }
  }
}

/* ── 取字节 / 取 URL ───────────────────────────────────────────── */

/**
 * 取 blob：内存 → IndexedDB → 网络（loader）。
 *
 * `key` 用附件 id（upload id）——附件内容不可变，天然可作缓存键。
 */
export async function getCachedBlob(key: string, loader: () => Promise<Blob>): Promise<Blob> {
  const cached = memory.get(key)
  if (cached) {
    memoryTouch(cached)
    counters.memoryHits += 1
    return cached.blob
  }
  const joined = blobInFlight.get(key)
  if (joined) {
    counters.inflightJoins += 1
    return joined
  }

  const epoch = cacheEpoch
  const task = (async (): Promise<Blob> => {
    const persisted = await readFromIdb(key)
    if (persisted) {
      counters.idbHits += 1
      if (epoch === cacheEpoch) memoryInsert(key, persisted)
      return persisted
    }
    counters.networkLoads += 1
    const blob = await loader()
    if (epoch === cacheEpoch) {
      memoryInsert(key, blob)
      queueWrite(() => persistToIdb(key, blob, epoch))
    }
    return blob
  })()

  blobInFlight.set(key, task)
  try {
    return await task
  } finally {
    if (blobInFlight.get(key) === task) blobInFlight.delete(key)
  }
}

/**
 * 取 blob URL：命中内存层时**复用**已有 URL（不新建），否则从 blob 建一个。
 *
 * 返回的 URL 由调用方持有一份引用，用完必须 `releaseCachedObjectUrl(url)`。
 */
export async function getCachedObjectUrl(key: string, loader: () => Promise<Blob>): Promise<string> {
  const live = keyToUrl.get(key)
  if (live) {
    counters.memoryHits += 1
    const cached = memory.get(key)
    if (cached) memoryTouch(cached)
    addRef(live)
    return live
  }
  const joined = urlInFlight.get(key)
  if (joined) {
    counters.inflightJoins += 1
    const joinedUrl = await joined
    const liveNow = keyToUrl.get(key)
    if (liveNow) {
      addRef(liveNow)
      return liveNow
    }
    // 在途结果在我们拿到之前已被最后一个持有者释放：那个 URL 已经死了，
    // 清掉残留引用后继续往下重建一个（blob 已在内存层，不需要网络）。
    urlRefs.delete(joinedUrl)
    urlToKey.delete(joinedUrl)
  }

  const epoch = cacheEpoch
  const task = (async (): Promise<string> => {
    const blob = await resolveBlobForUrl(key, loader)
    // 等 blob 期间另一个调用可能已经把 URL 建好了：复用它，别多建一个
    const liveNow = keyToUrl.get(key)
    if (liveNow) {
      addRef(liveNow)
      return liveNow
    }
    const url = URL.createObjectURL(blob)
    if (epoch === cacheEpoch) {
      keyToUrl.set(key, url)
      urlToKey.set(url, key)
    }
    addRef(url)
    return url
  })()

  urlInFlight.set(key, task)
  try {
    return await task
  } finally {
    if (urlInFlight.get(key) === task) urlInFlight.delete(key)
  }
}

/**
 * `getCachedObjectUrl` 内部的取 blob 步骤。
 *
 * 与 `getCachedBlob` 同源，但**不**占用它的 in-flight 表 —— URL 表已经按 key
 * 去重过，这里只做「内存 → IDB → 网络」的读取。
 */
async function resolveBlobForUrl(key: string, loader: () => Promise<Blob>): Promise<Blob> {
  const cached = memory.get(key)
  if (cached) {
    memoryTouch(cached)
    return cached.blob
  }
  const joined = blobInFlight.get(key)
  if (joined) return joined

  const epoch = cacheEpoch
  const task = (async (): Promise<Blob> => {
    const persisted = await readFromIdb(key)
    if (persisted) {
      counters.idbHits += 1
      if (epoch === cacheEpoch) memoryInsert(key, persisted)
      return persisted
    }
    counters.networkLoads += 1
    const blob = await loader()
    if (epoch === cacheEpoch) {
      memoryInsert(key, blob)
      queueWrite(() => persistToIdb(key, blob, epoch))
    }
    return blob
  })()

  blobInFlight.set(key, task)
  try {
    return await task
  } finally {
    if (blobInFlight.get(key) === task) blobInFlight.delete(key)
  }
}

/**
 * 释放一个 blob URL（即老的 `revokeObjectUrl` 语义，多了引用计数与缓存联动）。
 *
 * - 只处理 `blob:`，其他协议直接忽略；
 * - 幂等：重复释放同一个 URL 安全（引用计数归零后再调只是空操作）；
 * - 只摘掉内存里的 key → URL 关联，**绝不**删 IndexedDB 里的 blob。
 */
export function releaseCachedObjectUrl(url: string | null | undefined): void {
  if (!url) return
  if (!url.startsWith('blob:')) return

  const refs = urlRefs.get(url)
  if (refs === undefined) {
    // 不是本层创建的（例如本地 File 预览 URL）：保持老语义直接 revoke
    safeRevoke(url)
    return
  }
  if (refs > 1) {
    urlRefs.set(url, refs - 1)
    return
  }

  urlRefs.delete(url)
  const key = urlToKey.get(url)
  urlToKey.delete(url)
  if (key !== undefined && keyToUrl.get(key) === url) keyToUrl.delete(key)
  safeRevoke(url)
}

/**
 * 丢弃某个 key 的全部缓存（内存 + IndexedDB）。
 *
 * 用于 `deleteUpload`：附件已经在服务端删了，本地再留着字节既白占配额、
 * 也可能在 id 被复用时返回陈旧内容。若该 key 还有存活的 objectURL，一并 revoke
 * （服务端只允许删除未被消息引用的上传，所以不会打断正在显示的图片）。
 */
export function evictCachedMedia(key: string): void {
  memory.delete(key)

  const url = keyToUrl.get(key)
  if (url !== undefined) {
    keyToUrl.delete(key)
    urlToKey.delete(url)
    urlRefs.delete(url)
    safeRevoke(url)
  }
  blobInFlight.delete(key)
  urlInFlight.delete(key)

  queueWrite(async () => {
    const db = await openDb()
    if (!db) return
    await ensureIdbIndex(db)
    await deleteIdbKeys(db, [key])
  })
}

export interface MediaCacheStats {
  memoryEntries: number
  memoryBytes: number
  liveUrls: number
  idbAvailable: boolean
  /** 已知的 IDB 占用字节（索引尚未加载时为 0）。 */
  idbBytes: number
  memoryHits: number
  idbHits: number
  inflightJoins: number
  networkLoads: number
}

/** 诊断用：缓存命中情况（用户手动验收「滚动不再请求」时可直接在控制台看）。 */
export function getMediaCacheStats(): MediaCacheStats {
  let memoryBytes = 0
  for (const entry of memory.values()) memoryBytes += entry.bytes
  return {
    memoryEntries: memory.size,
    memoryBytes,
    liveUrls: urlRefs.size,
    idbAvailable: !idbUnavailable && hasIndexedDb(),
    idbBytes,
    memoryHits: counters.memoryHits,
    idbHits: counters.idbHits,
    inflightJoins: counters.inflightJoins,
    networkLoads: counters.networkLoads,
  }
}

/**
 * 清空全部缓存（登出 / 切换账号时调用）。
 *
 * 会 revoke 所有由本层创建的 objectURL（调用时仍在显示的图片会失效，所以
 * 应在页面卸载/登出流程里调用）。IDB 清理失败会被吞掉，不影响登出。
 */
export async function clearMediaCache(): Promise<void> {
  cacheEpoch += 1

  for (const url of [...urlRefs.keys()]) safeRevoke(url)
  urlRefs.clear()
  urlToKey.clear()
  keyToUrl.clear()
  memory.clear()
  // 清空瞬间仍在途的请求靠 epoch 丢弃结果，这两张表只是提前释放引用
  blobInFlight.clear()
  urlInFlight.clear()

  counters.memoryHits = 0
  counters.idbHits = 0
  counters.inflightJoins = 0
  counters.networkLoads = 0

  try {
    const db = await openDb()
    if (db) {
      const tx = db.transaction([BLOB_STORE, META_STORE], 'readwrite')
      const done = transactionDone(tx)
      tx.objectStore(BLOB_STORE).clear()
      tx.objectStore(META_STORE).clear()
      await done
    }
  } catch {
    /* 静默：缓存清不掉不影响登出 */
  }
  idbSizes.clear()
  idbBytes = 0
  idbIndexLoaded = true
}
