<script setup lang="ts">
/**
 * 管理后台（ux2-contract §十四-4，接口见 §六）。
 *
 * 页面结构（对应契约四项要求）：
 *   1. 概览：用户数 / 会话数 / 消息数 / 在线数（另加附件数，契约 §六 stats 有 uploads）；
 *   2. 用户列表：UID、账号名、昵称、状态、注册时间、在线、操作；
 *   3. 操作：禁言 N 分钟 / 解除禁言 / 删除账号，**全部二次确认**；
 *   4. 非管理员看不到数据 —— 路由守卫兜住（`canAccessAdmin`），后端 403 再兜一层。
 *
 * 几处必须写对的细节：
 *  - **对接口的 uid 是数字 uid，不是 UUID**：`POST /admin/users/:uid/mute` 的参数
 *    校验是 `Type.Integer({minimum:1000})`，传成员 id（UUID）直接 400。
 *  - **禁言状态要判「是否已到期」**，不能只看 `mutedUntil !== null`：后端解除禁言
 *    是把值写回 null，但历史上被禁言又到期的用户 `mutedUntil` 仍是过去的时刻，
 *    直接用 `!== null` 会把他永久显示成禁言中。这里复用 `userStateOf`（内部走
 *    `isMutedNow`），并单测过「已到期不再算禁言」。
 *  - **删除必须二次确认且默认焦点在「取消」**：删除是幂等但不可逆的高危操作，
 *    AppModal 会把焦点放到弹层里第一个可聚焦元素 —— 所以把「取消」放在 footer
 *    的第一个位置，误触回车不会直接删号。
 *  - **分页用 nextOffset 做「加载更多」**，不要一次拉全量：真实后台用户数不设上限，
 *    全量拉取会打满后端 200 次/分钟限流。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppInput from '@/components/base/AppInput.vue'
import AppModal from '@/components/base/AppModal.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppEmpty from '@/components/base/AppEmpty.vue'
import AppSkeleton from '@/components/base/AppSkeleton.vue'
import { useAdminStore, userStateOf, canAccessAdmin, type AdminUserState } from '@/stores/admin'
import { useAuthStore } from '@/stores/auth'
import { useUiStore } from '@/stores/ui'
import { isMutedNow } from '@/api/normalize'
import { toApiError } from '@/api/http'
import { goBack as goBackTo } from '@/composables/useBackNavigation'
import { useBreakpoint } from '@/composables/useBreakpoint'
import type { User } from '@/api/auth.types'

const admin = useAdminStore()
const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()
const { isMobile } = useBreakpoint()

/** 关键词（输入框即时绑定，点搜索/回车才发请求）。 */
const keyword = ref('')
/** 当前时间快照：用于判定禁言是否过期。每次操作后刷新，避免页面停留久了状态不更新。 */
const now = ref(Date.now())

const allowed = computed(() => canAccessAdmin(auth.user?.role))

/* ── 禁言弹层 ─────────────────────────────────────────────────────── */

const muteOpen = ref(false)
const muteTarget = ref<User | null>(null)
/** 预设时长（分钟）；0 表示解除禁言。 */
const muteMinutes = ref(60)
const MUTE_PRESETS: { label: string; minutes: number }[] = [
  { label: '10 分钟', minutes: 10 },
  { label: '1 小时', minutes: 60 },
  { label: '1 天', minutes: 1_440 },
  { label: '7 天', minutes: 10_080 },
  { label: '30 天', minutes: 43_200 },
]

function openMute(user: User): void {
  muteTarget.value = user
  // 已在禁言：默认落在「解除」（minutes=0），否则默认 1 小时
  muteMinutes.value = isMutedNow(user, now.value) ? 0 : 60
  muteOpen.value = true
}

async function doMute(): Promise<void> {
  const target = muteTarget.value
  if (!target) return
  try {
    await admin.mute(target.uid, muteMinutes.value)
    muteOpen.value = false
    muteTarget.value = null
    now.value = Date.now()
    ui.toast(muteMinutes.value === 0 ? `已解除 ${target.displayName} 的禁言` : `已禁言 ${target.displayName}`, 'success')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  }
}

/* ── 删除弹层 ─────────────────────────────────────────────────────── */

const deleteOpen = ref(false)
const deleteTarget = ref<User | null>(null)
/** 二次确认词：必须手工输入 uid，防手滑。 */
const deleteConfirm = ref('')

function openDelete(user: User): void {
  deleteTarget.value = user
  deleteConfirm.value = ''
  deleteOpen.value = true
}

const deleteReady = computed(() => {
  const target = deleteTarget.value
  if (!target) return false
  return deleteConfirm.value.trim() === String(target.uid)
})

async function doDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target || !deleteReady.value) return
  try {
    await admin.remove(target)
    deleteOpen.value = false
    deleteTarget.value = null
    deleteConfirm.value = ''
    now.value = Date.now()
    ui.toast(`已删除账号 ${target.username}`, 'info')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  }
}

/* ── 数据加载 ─────────────────────────────────────────────────────── */

async function reload(): Promise<void> {
  now.value = Date.now()
  await Promise.all([admin.load(keyword.value), admin.refreshStats()])
}

function submitSearch(): void {
  void admin.load(keyword.value)
}

onMounted(() => {
  // 守卫已经拦过一道；这里再判一次是为了「直接改 URL 进来」或 auth.user 晚到
  // （bootstrap 未完成时 role 是 undefined）的窗口期 —— 不能先打请求再判断。
  if (!allowed.value) {
    void router.replace({ name: 'chat-empty' })
    return
  }
  void reload()
})

/* ── 展示格式化 ───────────────────────────────────────────────────── */

function goBack(): void {
  goBackTo(router, { name: 'chat-empty' })
}

/** 注册时间：本地化的 yyyy-MM-dd HH:mm（后端给 ISO）。 */
function formatTime(iso: string | undefined): string {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 禁言到期时刻，列表里显示成「禁言至 2026-10-24 10:00」。 */
function muteUntilText(user: User): string {
  return user.mutedUntil ? formatTime(user.mutedUntil) : ''
}

type Pill = { text: string; tone: AdminUserState | 'admin' }

function statusPills(user: User): Pill[] {
  const state = userStateOf(user, now.value)
  const out: Pill[] = []
  if (state === 'banned') out.push({ text: '已被禁用', tone: 'banned' })
  else if (state === 'muted') out.push({ text: `禁言至 ${muteUntilText(user)}`, tone: 'muted' })
  else out.push({ text: '正常', tone: 'active' })
  if (user.role === 'admin') out.push({ text: '管理员', tone: 'admin' })
  return out
}

const statsCards = computed(() => {
  const s = admin.stats
  return [
    { key: 'users', label: '用户数', value: s?.users ?? null },
    { key: 'conversations', label: '会话数', value: s?.conversations ?? null },
    { key: 'messages', label: '消息数', value: s?.messages ?? null },
    { key: 'online', label: '在线', value: s?.online ?? null },
    { key: 'uploads', label: '附件数', value: s?.uploads ?? null },
  ]
})
</script>

<template>
  <section class="admin">
    <header class="admin__head">
      <button
        class="admin__back touch-target"
        type="button"
        :aria-label="isMobile ? '返回会话列表' : '返回'"
        @click="goBack"
      >
        <AppIcon name="back" :size="18" />
      </button>
      <span class="admin__title">管理后台</span>
      <AppButton label="刷新" tone="ghost" size="sm" :loading="admin.loading || admin.statsLoading" @click="reload" />
    </header>

    <div class="admin__body">
      <!-- 概览 -->
      <div class="admin__stats">
        <div v-for="c in statsCards" :key="c.key" class="stat" :data-stat="c.key">
          <span class="stat__value">{{ c.value === null ? '—' : c.value }}</span>
          <span class="stat__label">{{ c.label }}</span>
        </div>
      </div>

      <!-- 搜索 -->
      <div class="admin__search">
        <AppInput v-model="keyword" placeholder="搜索 UID / 账号名 / 昵称" @enter="submitSearch" />
        <AppButton label="搜索" tone="ghost" @click="submitSearch" />
        <AppButton
          v-if="admin.query.length > 0"
          label="清空"
          tone="ghost"
          @click="((keyword = ''), submitSearch())"
        />
      </div>

      <p v-if="admin.error" class="admin__error">{{ admin.error }}</p>

      <!-- 列表 -->
      <div v-if="admin.loading" class="admin__loading">
        <AppSkeleton :count="6" />
      </div>
      <AppEmpty
        v-else-if="admin.isEmpty"
        icon="users"
        :title="admin.query ? '没有匹配的用户' : '还没有用户'"
        :description="admin.query ? '换个关键词试试，支持 UID / 账号名 / 昵称' : ''"
      />
      <div v-else class="admin__table">
        <div class="row row--head">
          <span class="cell cell--uid">UID</span>
          <span class="cell cell--user">账号</span>
          <span class="cell cell--status">状态</span>
          <span class="cell cell--time">注册时间</span>
          <span class="cell cell--ops">操作</span>
        </div>
        <div v-for="u in admin.users" :key="u.id" class="row" :data-uid="u.uid">
          <span class="cell cell--uid">
            <b class="uid">#{{ u.uid }}</b>
          </span>
          <span class="cell cell--user">
            <AppAvatar :name="u.displayName" :seed="u.id" :size="30" :src="u.avatarUrl ?? ''" />
            <span class="who">
              <span class="who__name">{{ u.displayName }}</span>
              <span class="who__acc">
                @{{ u.username }}
                <span v-if="u.online" class="who__online">在线</span>
                <span v-else class="who__offline">离线</span>
              </span>
            </span>
          </span>
          <span class="cell cell--status">
            <span
              v-for="(p, i) in statusPills(u)"
              :key="i"
              class="pill"
              :class="`pill--${p.tone}`"
            >
              {{ p.text }}
            </span>
          </span>
          <span class="cell cell--time">{{ formatTime(u.createdAt) }}</span>
          <span class="cell cell--ops">
            <button
              class="op"
              type="button"
              :disabled="u.role === 'admin' || admin.saving"
              :title="u.role === 'admin' ? '管理员账号不可禁言' : '禁言 / 解除禁言'"
              @click="openMute(u)"
            >
              {{ isMutedNow(u, now) ? '解除禁言' : '禁言' }}
            </button>
            <button
              class="op op--danger"
              type="button"
              :disabled="u.role === 'admin' || admin.saving"
              :title="u.role === 'admin' ? '管理员账号不可删除' : '删除账号'"
              @click="openDelete(u)"
            >
              删除
            </button>
          </span>
        </div>
      </div>

      <div v-if="admin.hasMore" class="admin__more">
        <AppButton
          label="加载更多"
          tone="ghost"
          :loading="admin.loadingMore"
          @click="admin.loadMore()"
        />
      </div>
      <p v-else-if="admin.users.length > 0" class="admin__end">已到末尾 · 共 {{ admin.users.length }} 条</p>
    </div>

    <!-- 禁言二次确认 -->
    <AppModal title="禁言账号" :open="muteOpen" @close="muteOpen = false">
      <p class="confirm__text">
        对 <b>{{ muteTarget?.displayName }}</b>（UID #{{ muteTarget?.uid }}）执行：
      </p>
      <div class="confirm__presets">
        <button
          v-for="p in MUTE_PRESETS"
          :key="p.minutes"
          class="preset"
          :class="{ 'preset--on': muteMinutes === p.minutes }"
          type="button"
          @click="muteMinutes = p.minutes"
        >
          {{ p.label }}
        </button>
        <button
          class="preset preset--off"
          :class="{ 'preset--on': muteMinutes === 0 }"
          type="button"
          @click="muteMinutes = 0"
        >
          解除禁言
        </button>
      </div>
      <p class="confirm__hint">
        {{ muteMinutes === 0 ? '立即解除该账号的禁言状态。' : `该账号在 ${muteMinutes} 分钟内不能发送消息。` }}
      </p>
      <template #footer>
        <AppButton label="取消" tone="ghost" @click="muteOpen = false" />
        <AppButton
          :label="muteMinutes === 0 ? '确认解除' : '确认禁言'"
          :loading="admin.saving"
          @click="doMute"
        />
      </template>
    </AppModal>

    <!-- 删除二次确认：需手输 uid -->
    <AppModal title="删除账号" :open="deleteOpen" @close="deleteOpen = false">
      <p class="confirm__text">
        即将永久删除 <b>{{ deleteTarget?.displayName }}</b>（UID #{{ deleteTarget?.uid }}）。
        该账号的消息与会话关系会被清理，且**无法恢复**。
      </p>
      <AppInput
        v-model="deleteConfirm"
        :label="`请输入 UID ${deleteTarget?.uid} 以确认`"
        placeholder="输入 UID"
        :maxlength="12"
      />
      <template #footer>
        <AppButton label="取消" tone="ghost" @click="deleteOpen = false" />
        <AppButton label="永久删除" tone="danger" :disabled="!deleteReady" :loading="admin.saving" @click="doDelete" />
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.admin {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--app-panel);
}
.admin__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--app-border);
}
.admin__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.admin__back:hover {
  background: var(--app-hover);
}
.admin__title {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
}
.admin__body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px 32px;
  min-height: 0;
}
.admin__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 10px;
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-bg);
}
.stat__value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stat__label {
  font-size: 11px;
  color: var(--app-text-faint);
}
.admin__search {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  margin: 18px 0 12px;
  flex-wrap: wrap;
}
.admin__search > :first-child {
  flex: 1 1 220px;
  min-width: 0;
}
.admin__error {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-danger-500) 10%, transparent);
  color: var(--color-danger-500);
  font-size: 12px;
}
.admin__loading {
  padding: 8px 0;
}
.admin__table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-top: 1px solid var(--app-border);
  font-size: 12.5px;
}
.row:first-child {
  border-top: none;
}
.row--head {
  background: var(--app-bg);
  color: var(--app-text-faint);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.cell {
  min-width: 0;
}
.cell--uid {
  flex: 0 0 64px;
}
.cell--user {
  flex: 1 1 180px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cell--status {
  flex: 0 0 168px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.cell--time {
  flex: 0 0 132px;
  color: var(--app-text-muted);
  font-variant-numeric: tabular-nums;
}
.cell--ops {
  flex: 0 0 104px;
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}
.uid {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.who {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.who__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who__acc {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--app-text-faint);
}
.who__online {
  color: #2f9e6e;
}
.who__offline {
  color: var(--app-text-faint);
}
.pill {
  display: inline-block;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10.5px;
  line-height: 17px;
  background: var(--app-hover);
  color: var(--app-text-muted);
  white-space: nowrap;
}
.pill--active {
  background: color-mix(in srgb, #2f9e6e 14%, transparent);
  color: #2f9e6e;
}
.pill--banned {
  background: color-mix(in srgb, var(--color-danger-500) 14%, transparent);
  color: var(--color-danger-500);
}
.pill--muted {
  background: color-mix(in srgb, #d08b2c 16%, transparent);
  color: #a8691f;
}
.pill--admin {
  background: color-mix(in srgb, var(--color-brand-500) 14%, transparent);
  color: var(--color-brand-600);
}
.op {
  border: 1px solid var(--app-border);
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: 11.5px;
  line-height: 20px;
  padding: 0 7px;
  cursor: pointer;
  white-space: nowrap;
}
.op:hover:not(:disabled) {
  background: var(--app-hover);
  color: var(--app-text);
}
.op--danger {
  color: var(--color-danger-500);
  border-color: color-mix(in srgb, var(--color-danger-500) 34%, var(--app-border));
}
.op--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-danger-500) 10%, transparent);
  color: var(--color-danger-500);
}
.op:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.admin__more {
  display: flex;
  justify-content: center;
  margin-top: 14px;
}
.admin__end {
  margin: 14px 0 0;
  text-align: center;
  font-size: 11px;
  color: var(--app-text-faint);
}
.confirm__text {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
}
.confirm__presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preset {
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: 12px;
  padding: 5px 10px;
  cursor: pointer;
}
.preset:hover {
  background: var(--app-hover);
}
.preset--on {
  border-color: var(--color-brand-500);
  color: var(--color-brand-600);
  background: color-mix(in srgb, var(--color-brand-500) 10%, transparent);
}
.preset--off.preset--on {
  border-color: #2f9e6e;
  color: #2f9e6e;
  background: color-mix(in srgb, #2f9e6e 12%, transparent);
}
.confirm__hint {
  margin: 12px 0 0;
  font-size: 11.5px;
  color: var(--app-text-faint);
}

@media (max-width: 767px) {
  .admin__head {
    padding-top: calc(8px + var(--safe-top));
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(12px + var(--safe-right));
  }
  .admin__head .admin__back {
    width: var(--spacing-touch-target);
    height: var(--spacing-touch-target);
    margin-left: -8px;
  }
  .admin__body {
    padding: 14px calc(12px + var(--safe-right)) 28px calc(12px + var(--safe-left));
  }
  /* 手机：表格改成两行卡片（UID+账号 / 状态+时间+操作），避免横向滚动 */
  .row--head {
    display: none;
  }
  .row {
    flex-wrap: wrap;
    gap: 6px 8px;
    padding: 10px;
  }
  .cell--uid {
    flex: 0 0 auto;
  }
  .cell--user {
    flex: 1 1 auto;
  }
  .cell--status {
    flex: 1 1 100%;
    order: 3;
  }
  .cell--time {
    flex: 0 0 auto;
    order: 4;
    font-size: 11px;
  }
  .cell--ops {
    flex: 1 1 100%;
    order: 5;
    justify-content: flex-start;
  }
  /* 手机热区 ≥44px（--spacing-touch-target） */
  .op {
    min-height: var(--spacing-touch-target);
    padding: 0 12px;
  }
  .preset {
    min-height: var(--spacing-touch-target);
    padding: 0 12px;
  }
}
</style>
