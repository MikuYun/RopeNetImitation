<script setup lang="ts">
/**
 * 会话信息页（ux2-contract §十四-3）。
 * - 单聊：展示对方资料（昵称 / 用户名 / **UID**）
 * - 群聊：群头像 + 群名（owner/admin 可改）、成员列表角色徽标、加人 / 移人 /
 *   设管理员 / 退群
 *
 * 权限判断**不硬编码策略**（docs/04 风险 E.22）：UI 只按契约 §7.1 的矩阵决定
 * 「显示哪些入口」，真正裁决永远在后端 —— 后端 403 `OWNER_REQUIRED` 原样提示。
 *
 * 两个不能改的既有约定：
 *  1. `.info__edit`（改群名）与 `.member__remove`（移出）是 e2e 矩阵脚本的
 *     选择器契约（`e2e-matrix.mjs` FE-03 群权限组按数量断言），改名/删除会
 *     直接让那组断言失效；
 *  2. 群头像/群名/角色三处写操作后一律 `convStore.fetchDetail` 重新拉权威详情，
 *     不做增量猜测 —— 后端会同时插 system 消息并广播 `conversation.updated`，
 *     本地拼接很容易与广播结果打架。
 *
 * 关于头像：`avatarUrl` 可能是 `/api/v1/uploads/<uuid>`（站内附件，需 Bearer）
 * 或 https 外链，两种都由 `AppAvatar` 内部收敛成 blob/直链，本页只负责传值。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppModal from '@/components/base/AppModal.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppInput from '@/components/base/AppInput.vue'
import PresenceDot from '@/components/layout/PresenceDot.vue'
import { useAuthStore } from '@/stores/auth'
import { useConversationStore } from '@/stores/conversation'
import { useFriendStore } from '@/stores/friend'
import { useUiStore } from '@/stores/ui'
import { http, toApiError } from '@/api/http'
import { uploadFile, UPLOAD_MAX_BYTES } from '@/api/uploads'
import { checkUploadFile, formatBytes } from '@/utils/attachments'
import type { WireConversation } from '@/api/wire'
import type { MemberRole } from '@/types/domain'
import { goBack as goBackTo } from '@/composables/useBackNavigation'
import { useBreakpoint } from '@/composables/useBreakpoint'

const props = defineProps<{ convId: string }>()

const auth = useAuthStore()
const convStore = useConversationStore()
const friendStore = useFriendStore()
const ui = useUiStore()
const router = useRouter()
const { isMobile } = useBreakpoint()

const detail = computed(() => convStore.detailsById.get(props.convId) ?? null)
const isGroup = computed(() => detail.value?.type === 'group')
const myRole = computed<MemberRole>(() => detail.value?.myRole ?? 'member')
const isOwner = computed(() => myRole.value === 'owner')
/** owner 或群管理员都能改群资料 / 加人（契约 §7.1）。 */
const canManage = computed(() => isGroup.value && (isOwner.value || myRole.value === 'admin'))

/**
 * 群头像：私聊用对方头像，群聊用群头像。
 * 私聊后端 `conversation.avatarUrl` 恒为空串（service.ts conversation()），
 * 必须按 peer 取，否则私聊头像会退化成首字母。
 */
const heroAvatar = computed(() => {
  const d = detail.value
  if (!d) return ''
  if (d.type === 'group') return d.avatarUrl ?? ''
  return d.peer?.avatarUrl ?? ''
})

const renameOpen = ref(false)
const renameValue = ref('')
const addOpen = ref(false)
const addSelected = ref<Set<string>>(new Set())
const busy = ref(false)
/** 群头像上传中（独立于 busy，避免上传进度期间禁掉整个页面）。 */
const avatarBusy = ref(false)
const avatarInput = ref<HTMLInputElement | null>(null)

watch(
  () => props.convId,
  async (id) => {
    if (!id) return
    await convStore.ensureDetail(id)
  },
  { immediate: true },
)

/** 可加入的候选：好友里还不在群中的。 */
const addCandidates = computed(() => {
  const inGroup = new Set(detail.value?.members.map((m) => m.user.id) ?? [])
  return friendStore.friends.filter((f) => !inGroup.has(f.user.id))
})

function goBack(): void {
  // 站内回退：深链直达详情时浏览器历史里没有会话页，back() 会退到站外
  goBackTo(router, { name: 'chat', params: { convId: props.convId } })
}

/** 统一刷新：三处写操作（群名/群头像/角色）都走它。 */
async function refreshDetail(): Promise<void> {
  await convStore.fetchDetail(props.convId)
}

/** PATCH 会话。`api/conversations.ts` 的 renameConversation 只发 name（归 task-10），
 * 群头像需要自己发一个带 avatarUrl 的 PATCH，故在本组件内直接调 http。 */
async function patchConversation(payload: { name?: string; avatarUrl?: string }): Promise<void> {
  await http.patch<WireConversation>(
    `/api/v1/conversations/${encodeURIComponent(props.convId)}`,
    payload,
  )
}

function openRename(): void {
  renameValue.value = detail.value?.title ?? ''
  renameOpen.value = true
}

async function doRename(): Promise<void> {
  const v = renameValue.value.trim()
  if (!v) return
  busy.value = true
  try {
    await patchConversation({ name: v })
    await refreshDetail()
    renameOpen.value = false
    ui.toast('群名称已更新', 'success')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busy.value = false
  }
}

/* ── 群头像 ─────────────────────────────────────────────────────── */

function pickGroupAvatar(): void {
  if (!canManage.value || avatarBusy.value) return
  avatarInput.value?.click()
}

async function onGroupAvatarChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空 value：允许再次选择同一个文件（与 MessageComposer 同款处理）
  input.value = ''
  if (!file) return
  const verdict = checkUploadFile(file)
  if (!verdict.ok) {
    ui.toast(verdict.message, 'error')
    return
  }
  if (!file.type.startsWith('image/')) {
    ui.toast('群头像必须是图片', 'error')
    return
  }
  avatarBusy.value = true
  try {
    const att = await uploadFile(file)
    await patchConversation({ avatarUrl: `/api/v1/uploads/${att.id}` })
    await refreshDetail()
    ui.toast('群头像已更新', 'success')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    avatarBusy.value = false
  }
}

async function clearGroupAvatar(): Promise<void> {
  avatarBusy.value = true
  try {
    // 契约 §7.2：空串表示移除头像
    await patchConversation({ avatarUrl: '' })
    await refreshDetail()
    ui.toast('已移除群头像', 'info')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    avatarBusy.value = false
  }
}

/* ── 成员管理 ───────────────────────────────────────────────────── */

function toggleAdd(userId: string): void {
  const next = new Set(addSelected.value)
  if (next.has(userId)) next.delete(userId)
  else next.add(userId)
  addSelected.value = next
}

async function doAdd(): Promise<void> {
  if (addSelected.value.size === 0) return
  busy.value = true
  try {
    // 服务端返回完整 Detail，整体替换缓存（不做增量猜测）
    await convStore.addMembers(props.convId, [...addSelected.value])
    addOpen.value = false
    addSelected.value = new Set()
    ui.toast('成员已添加', 'success')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busy.value = false
  }
}

/**
 * 移出权限按契约 §7.4：
 *  - owner 可移 admin 与 member，不可移自己（退群走 danger 区）；
 *  - 群管理员只能移**普通成员**（移其它 admin 后端 403 OWNER_REQUIRED）；
 *  - 普通成员看不到任何移除入口。
 */
function canRemoveMember(targetRole: MemberRole, targetId: string): boolean {
  if (!isGroup.value) return false
  if (targetId === auth.userId) return false
  if (isOwner.value) return targetRole !== 'owner'
  if (myRole.value === 'admin') return targetRole === 'member'
  return false
}

async function removeMember(userId: string, name: string): Promise<void> {
  busy.value = true
  try {
    await convStore.removeMember(props.convId, userId)
    ui.toast(`已将 ${name} 移出群聊`, 'success')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busy.value = false
  }
}

/**
 * 设置 / 取消管理员。仅群主可操作（契约 §7.3，后端 `requireOwner`）。
 * `:userId` 这里是成员 UUID（不是 uid）—— 与 admin 后台按数字 uid 操作不同，
 * 混用会被后端 404 `MEMBER_NOT_FOUND`。
 */
async function setMemberRole(userId: string, role: 'admin' | 'member', name: string): Promise<void> {
  busy.value = true
  try {
    await http.post(
      `/api/v1/conversations/${encodeURIComponent(props.convId)}/members/${encodeURIComponent(userId)}/role`,
      { role },
    )
    await refreshDetail()
    ui.toast(role === 'admin' ? `已将 ${name} 设为管理员` : `已取消 ${name} 的管理员`, 'success')
  } catch (e) {
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busy.value = false
  }
}

async function leaveGroup(): Promise<void> {
  busy.value = true
  try {
    await convStore.removeMember(props.convId, auth.userId)
    convStore.removeSummary(props.convId)
    ui.toast('已退出群聊', 'info')
    void router.push({ name: 'chat-empty' })
  } catch (e) {
    // 群主退群等策略由后端裁定，这里只如实提示
    ui.toast(toApiError(e).message, 'error')
  } finally {
    busy.value = false
  }
}

/** `.member__meta` 用的省略式角色标签：普通成员留空，避免每行都是噪声。 */
function roleLabel(role: string): string {
  return role === 'owner' ? '群主' : role === 'admin' ? '管理员' : ''
}

/** 徽标文案（契约 §十四-3 要求三档都可见）。 */
function roleBadge(role: MemberRole): string {
  return role === 'owner' ? '群主' : role === 'admin' ? '管理员' : '成员'
}

const avatarLimitText = formatBytes(UPLOAD_MAX_BYTES)
</script>

<template>
  <section class="info">
    <header class="info__head">
      <button
        class="info__back touch-target"
        type="button"
        :aria-label="isMobile ? '返回会话' : '返回'"
        @click="goBack"
      >
        <AppIcon name="back" :size="18" />
      </button>
      <span class="info__title">会话信息</span>
    </header>

    <div v-if="!detail" class="info__loading">加载中…</div>

    <div v-else class="info__body">
      <div class="info__hero">
        <button
          class="info__hero-avatar"
          type="button"
          :disabled="!canManage || avatarBusy"
          :aria-label="canManage ? '更换群头像' : '群头像'"
          @click="pickGroupAvatar"
        >
          <AppAvatar :name="detail.title" :seed="detail.peer?.id ?? detail.id" :size="64" :radius="12" :src="heroAvatar" />
          <span v-if="canManage" class="info__hero-badge">
            {{ avatarBusy ? '上传中…' : '换头像' }}
          </span>
        </button>
        <div class="info__hero-text">
          <div class="info__name">
            {{ detail.title }}
            <button v-if="canManage" class="info__edit" type="button" title="修改群名" @click="openRename">
              <AppIcon name="more" :size="15" />
            </button>
          </div>
          <div class="info__sub">
            {{ detail.type === 'group' ? `${detail.members.length} 名成员` : `@${detail.peer?.username ?? ''}` }}
          </div>
          <button
            v-if="canManage && heroAvatar"
            class="info__avatar-clear"
            type="button"
            :disabled="avatarBusy"
            @click="clearGroupAvatar"
          >
            移除群头像
          </button>
        </div>
      </div>

      <!-- 群头像选择：隐藏 input，点击头像触发（不经 <label> 以免 iOS 焦点异常） -->
      <input
        ref="avatarInput"
        class="info__file"
        type="file"
        accept="image/*"
        tabindex="-1"
        aria-hidden="true"
        @change="onGroupAvatarChange"
      />

      <template v-if="isGroup">
        <div class="info__section-head">
          <span>群成员</span>
          <AppButton v-if="canManage" label="添加成员" tone="ghost" @click="addOpen = true" />
        </div>

        <div class="info__members">
          <div v-for="m in detail.members" :key="m.user.id" class="member" :data-role="m.role">
            <div class="member__avatar">
              <AppAvatar :name="m.user.displayName" :seed="m.user.id" :size="36" :src="m.user.avatarUrl ?? ''" />
              <PresenceDot class="member__dot" :user-id="m.user.id" />
            </div>
            <div class="member__col">
              <span class="member__name">
                {{ m.user.displayName }}
                <span v-if="m.user.id === auth.userId" class="member__self">（我）</span>
                <span class="member__badge" :class="`member__badge--${m.role}`">{{ roleBadge(m.role) }}</span>
              </span>
              <span class="member__meta">
                {{ roleLabel(m.role) }}
                <span v-if="roleLabel(m.role)">·</span>
                已读至 {{ m.lastReadSeq }}
              </span>
            </div>
            <button
              v-if="isOwner && m.role === 'member' && m.user.id !== auth.userId"
              class="member__role"
              type="button"
              :disabled="busy"
              @click="setMemberRole(m.user.id, 'admin', m.user.displayName)"
            >
              设为管理员
            </button>
            <button
              v-else-if="isOwner && m.role === 'admin'"
              class="member__role"
              type="button"
              :disabled="busy"
              @click="setMemberRole(m.user.id, 'member', m.user.displayName)"
            >
              取消管理员
            </button>
            <button
              v-if="canRemoveMember(m.role, m.user.id)"
              class="member__remove"
              type="button"
              @click="removeMember(m.user.id, m.user.displayName)"
            >
              移出
            </button>
          </div>
        </div>

        <div class="info__danger">
          <AppButton
            :label="isOwner ? '退出群聊（群主需先转让）' : '退出群聊'"
            tone="danger"
            :loading="busy"
            @click="leaveGroup"
          />
        </div>
      </template>

      <template v-else>
        <div class="info__section-head"><span>对方资料</span></div>
        <div class="info__kv">
          <span class="info__k">昵称</span><span class="info__v">{{ detail.peer?.displayName }}</span>
          <span class="info__k">用户名</span><span class="info__v">@{{ detail.peer?.username }}</span>
          <span class="info__k">UID</span>
          <span class="info__v">
            <span class="info__uid">#{{ detail.peer?.uid ?? '—' }}</span>
          </span>
        </div>
      </template>

      <p v-if="canManage" class="info__hint">群头像支持 JPG/PNG 等图片，不超过 {{ avatarLimitText }}。</p>
    </div>

    <!-- 改群名 -->
    <AppModal title="修改群名称" :open="renameOpen" @close="renameOpen = false">
      <AppInput v-model="renameValue" label="群名称" :maxlength="30" />
      <template #footer>
        <AppButton label="取消" tone="ghost" @click="renameOpen = false" />
        <AppButton label="保存" :loading="busy" @click="doRename" />
      </template>
    </AppModal>

    <!-- 添加成员 -->
    <AppModal title="添加成员" :open="addOpen" @close="addOpen = false">
      <div v-if="addCandidates.length === 0" class="info__none">
        没有可添加的好友（可能都已在群里）
      </div>
      <button
        v-for="f in addCandidates"
        :key="f.user.id"
        class="cand"
        :class="{ 'cand--on': addSelected.has(f.user.id) }"
        type="button"
        @click="toggleAdd(f.user.id)"
      >
        <span class="cand__check"><AppIcon v-if="addSelected.has(f.user.id)" name="check" :size="12" /></span>
        <AppAvatar :name="f.user.displayName" :seed="f.user.id" :size="28" :src="f.user.avatarUrl ?? ''" />
        <span>{{ f.user.displayName }}</span>
      </button>
      <template #footer>
        <AppButton label="取消" tone="ghost" @click="addOpen = false" />
        <AppButton label="添加" :loading="busy" :disabled="addSelected.size === 0" @click="doAdd" />
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--app-panel);
}
.info__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--app-border);
}
.info__back {
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
.info__back:hover {
  background: var(--app-hover);
}
.info__title {
  font-size: 14px;
  font-weight: 600;
}
.info__loading {
  padding: 24px;
  color: var(--app-text-faint);
  font-size: 13px;
}
.info__body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 22px;
  min-height: 0;
}
.info__hero {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--app-border);
}
/* 群头像按钮：去掉原生按钮样式，只让头像本身可点 */
.info__hero-avatar {
  position: relative;
  display: flex;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  flex: 0 0 auto;
}
.info__hero-avatar:disabled {
  cursor: default;
}
/* 「换头像」蒙层：只在 hover / focus 时显现，平时不压住头像 */
.info__hero-badge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: rgb(0 0 0 / 0.45);
  color: #fff;
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
.info__hero-avatar:hover .info__hero-badge,
.info__hero-avatar:focus-visible .info__hero-badge {
  opacity: 1;
}
.info__hero-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.info__name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 16px;
  font-weight: 600;
}
.info__edit {
  display: flex;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
}
.info__edit:hover {
  background: var(--app-hover);
}
.info__avatar-clear {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--app-text-faint);
  font-family: inherit;
  font-size: 12px;
  padding: 2px 0;
  cursor: pointer;
  text-decoration: underline;
}
.info__avatar-clear:hover {
  color: var(--app-text-muted);
}
.info__file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.info__sub {
  font-size: 12px;
  color: var(--app-text-faint);
}
.info__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 0 8px;
  font-size: 13px;
  color: var(--app-text-muted);
}
.info__members {
  display: flex;
  flex-direction: column;
}
.member {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
.member__avatar {
  position: relative;
  flex: 0 0 auto;
}
.member__dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
}
.member__col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.member__name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.member__self {
  color: var(--app-text-faint);
}
/* 角色徽标：三档（群主/管理员/成员）都用同一形状，只换配色 */
.member__badge {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 16px;
  background: var(--app-hover);
  color: var(--app-text-muted);
}
.member__badge--owner {
  background: color-mix(in srgb, var(--color-brand-500) 16%, transparent);
  color: var(--color-brand-600);
}
.member__badge--admin {
  background: color-mix(in srgb, var(--color-brand-500) 10%, transparent);
  color: var(--color-brand-600);
}
.member__meta {
  font-size: 11px;
  color: var(--app-text-faint);
}
.member__role {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--color-brand-600);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 4px;
}
.member__role:hover {
  background: var(--app-hover);
}
.member__remove {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--color-danger-500);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 4px;
}
.member__remove:hover {
  background: color-mix(in srgb, var(--color-danger-500) 12%, transparent);
}
.info__danger {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--app-border);
}
.info__kv {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 10px 12px;
  font-size: 13px;
}
.info__k {
  color: var(--app-text-faint);
}
.info__uid {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.info__none {
  padding: 12px 0;
  font-size: 13px;
  color: var(--app-text-faint);
}
.info__hint {
  margin: 14px 0 0;
  font-size: 11px;
  color: var(--app-text-faint);
}
.cand {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.cand:hover {
  background: var(--app-hover);
}
.cand--on {
  background: color-mix(in srgb, var(--color-brand-500) 10%, transparent);
}
.cand__check {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  color: #fff;
}
.cand--on .cand__check {
  background: var(--color-brand-500);
  border-color: var(--color-brand-500);
}

/* ── 手机：顶部安全区 + 列表行热区 ───────────────────────────────── */
@media (max-width: 767px) {
  .info__head {
    padding-top: calc(8px + var(--safe-top));
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(12px + var(--safe-right));
  }
  .info__head .info__back {
    /* 返回是高频操作，热区必须够大 */
    width: var(--spacing-touch-target);
    height: var(--spacing-touch-target);
    margin-left: -8px;
  }
  .info__body {
    padding-left: var(--safe-left);
    padding-right: var(--safe-right);
  }
  /* 窄屏上「设为管理员 + 移出」两个按钮并排时行会挤，改为允许换行 */
  .member {
    flex-wrap: wrap;
  }
  .member__role,
  .member__remove {
    padding: 6px 8px;
  }
}
</style>
