<script setup lang="ts">
/**
 * 个人资料页（ux2-contract §十四-2 / UI-V2 §3）。
 *
 * 契约要求「个人信息包含：头像、账号名称、昵称、uid」四项都必须出现：
 *   头像   —— 点击换图 → `uploadFile` → `PATCH /users/me {avatarUrl:'/api/v1/uploads/<uuid>'}`；
 *   账号名称 —— `username`，**只读**（登录凭据的一部分，改它等于改身份）；
 *   昵称   —— `displayName`，可改；
 *   UID    —— `uid`，**只读**（对外稳定标识），显示成 `#10001` 并支持一键复制；
 * 另加「个人简介」bio（契约 §十 允许 `PATCH /users/me` 带 bio）。
 *
 * v2 追加（UI-V2 §3）：
 *   - `embedded` prop：供移动端上拉抽屉（ProfileSheet）full 态复用，隐藏返回栏；
 *   - 「账号与安全」区块：主题（内联 ThemePicker）+ 退出登录（二次确认 Modal）；
 *   - 「我的动态」入口：跳到访客资料页看自己发布的帖子。
 *
 * 三个实现要点：
 *  1. 头像三点闭环：选图 → 上传 → PATCH。上传成功但 PATCH 失败会留下一个
 *     **孤儿 upload**（没人引用、7 天后由后端清理），此时必须提示「头像未保存」，
 *     不能让用户以为换成功了 —— 页面头像用的是 `auth.user.avatarUrl`，
 *     只有 PATCH 成功并回写 auth store 才会真的变。
 *  2. `auth.user` 是**响应式引用**，PATCH 返回的 User 要整体 `auth.user = next`
 *     而不是改字段（`api.updateMe` 返回的是新对象，字段级 patch 会丢字段）。
 *  3. UID 复制用共享的 `writeClipboardText`（`@/utils/clipboard`）：它内部会先试
 *     `navigator.clipboard`，非安全上下文（http://非 localhost）下退到
 *     `document.execCommand('copy')` 的 textarea 方案 —— 否则内网 http 部署时
 *     按钮点了没反应。降级链全仓库只有那一份实现，页面里不再重复。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppAvatar from '@/components/base/AppAvatar.vue'
import AppButton from '@/components/base/AppButton.vue'
import AppInput from '@/components/base/AppInput.vue'
import AppIcon from '@/components/base/AppIcon.vue'
import AppModal from '@/components/base/AppModal.vue'
import ThemePicker from '@/components/theme/ThemePicker.vue'
import { useAuthStore } from '@/stores/auth'
import { useUiStore, THEME_LABELS } from '@/stores/ui'
import { fetchUserProfile, updateMe } from '@/api/users'
import { uploadFile, UPLOAD_MAX_BYTES } from '@/api/uploads'
import { checkUploadFile, formatBytes } from '@/utils/attachments'
import { writeClipboardText } from '@/utils/clipboard'
import { toApiError } from '@/api/http'
import { goBack as goBackTo } from '@/composables/useBackNavigation'
import { useRouter } from 'vue-router'
import { useBreakpoint } from '@/composables/useBreakpoint'

const props = withDefaults(
  defineProps<{
    /**
     * 嵌入模式（移动端个人信息抽屉 full 态）。
     * true 时隐藏返回栏与页面标题，根容器 `flex: 1`，其余内容完全一致。
     */
    embedded?: boolean
  }>(),
  { embedded: false },
)

const auth = useAuthStore()
const ui = useUiStore()
const router = useRouter()
const { isMobile } = useBreakpoint()

const user = computed(() => auth.user)

/** 表单草稿：本地编辑，点「保存」才提交（不要边打字边打接口）。 */
const displayName = ref('')
const bio = ref('')
const saving = ref(false)
/** 头像选择/上传中。 */
const avatarBusy = ref(false)
const avatarInput = ref<HTMLInputElement | null>(null)

/** 用 user 重置草稿；user 变化（保存成功回写 / 刷新）时同步一次。 */
watch(
  user,
  (u) => {
    displayName.value = u?.displayName ?? ''
    bio.value = u?.bio ?? ''
  },
  { immediate: true },
)

const uidText = computed(() => {
  const uid = user.value?.uid
  // uid=0 是 normalize 的「后端没给」哨兵值，不能显示成 #0 骗人
  return uid && uid > 0 ? `#${uid}` : '—'
})

const displayNameDirty = computed(() => displayName.value.trim() !== (user.value?.displayName ?? ''))
const bioDirty = computed(() => bio.value.trim() !== (user.value?.bio ?? ''))
const dirty = computed(() => displayNameDirty.value || bioDirty.value)
const canSave = computed(() => dirty.value && displayName.value.trim().length > 0 && !saving.value)

const avatarLimitText = formatBytes(UPLOAD_MAX_BYTES)

/** 站内附件头像 `/api/v1/uploads/<uuid>` 由 AppAvatar 内部取 blob 渲染。 */
const avatarSrc = computed(() => user.value?.avatarUrl ?? '')

function goBack(): void {
  goBackTo(router, { name: 'chat-empty' })
}

function pickAvatar(): void {
  if (avatarBusy.value) return
  avatarInput.value?.click()
}

async function onAvatarChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空 value：允许重复选择同一个文件（否则第二次选同一张不会触发 change）
  input.value = ''
  if (!file) return
  const verdict = checkUploadFile(file)
  if (!verdict.ok) {
    ui.toast(verdict.message, 'error')
    return
  }
  if (!file.type.startsWith('image/')) {
    ui.toast('头像必须是图片文件', 'error')
    return
  }
  avatarBusy.value = true
  try {
    const att = await uploadFile(file)
    const next = await updateMe({ avatarUrl: `/api/v1/uploads/${att.id}` })
    auth.user = next
    ui.toast('头像已更新', 'success')
  } catch (err) {
    // 上传成功但 PATCH 失败 = 孤儿附件；提示必须明确「未保存」
    ui.toast(`头像未保存：${toApiError(err).message}`, 'error')
  } finally {
    avatarBusy.value = false
  }
}

async function clearAvatar(): Promise<void> {
  if (avatarBusy.value) return
  avatarBusy.value = true
  try {
    // 契约 §十：空串表示清空头像
    const next = await updateMe({ avatarUrl: '' })
    auth.user = next
    ui.toast('已恢复默认头像', 'info')
  } catch (err) {
    ui.toast(toApiError(err).message, 'error')
  } finally {
    avatarBusy.value = false
  }
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const next = await updateMe({
      displayName: displayName.value.trim(),
      bio: bio.value.trim(),
    })
    auth.user = next
    ui.toast('资料已保存', 'success')
  } catch (err) {
    ui.toast(toApiError(err).message, 'error')
  } finally {
    saving.value = false
  }
}

/** 撤销编辑：把草稿退回 auth store 里的权威值。 */
function resetForm(): void {
  displayName.value = user.value?.displayName ?? ''
  bio.value = user.value?.bio ?? ''
}

/* ── UID 一键复制 ─────────────────────────────────────────────────── */

const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

onBeforeUnmount(() => {
  if (copyTimer !== null) clearTimeout(copyTimer)
})

/**
 * 复制文本。
 *
 * 实现已收敛到 `@/utils/clipboard`：先试 `navigator.clipboard.writeText`
 * （仅安全上下文可用），再退到 textarea + `execCommand('copy')`。
 * 这里保留 `copyText` 这个名字只是为了让两个调用点（UID / 账号名）不变。
 */
const copyText = writeClipboardText

async function copyUid(): Promise<void> {
  const uid = user.value?.uid
  if (!uid || uid <= 0) return
  const ok = await copyText(String(uid))
  if (!ok) {
    ui.toast('复制失败，请手动选择 UID 复制', 'error')
    return
  }
  copied.value = true
  if (copyTimer !== null) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = false
    copyTimer = null
  }, 1_600)
  ui.toast('UID 已复制', 'info')
}

async function copyUsername(): Promise<void> {
  const name = user.value?.username ?? ''
  const ok = await copyText(name)
  ui.toast(ok ? '账号名已复制' : '复制失败', ok ? 'info' : 'error')
}

/* ── v2：我的动态 / 账号与安全 ─────────────────────────────────────── */

/**
 * 自己发布的动态数。
 *
 * 用 `GET /users/:userId` 拿 `postCount`（后端算好的权威值），而不是把广场
 * 首屏列表数一数 —— 后者受分页与缓存影响会骗人。失败时静默保持 0，不打断页面。
 */
const postCount = ref(0)

async function loadPostCount(): Promise<void> {
  const id = auth.userId
  if (!id) return
  try {
    const view = await fetchUserProfile(id)
    postCount.value = view.postCount
  } catch {
    /* 计数是锦上添花，失败不影响资料编辑 */
  }
}

void loadPostCount()

function openMyPosts(): void {
  const id = auth.userId
  if (!id) return
  void router.push({ name: 'user-profile', params: { userId: id } })
}

const themeName = computed(() => THEME_LABELS[ui.theme] ?? '自定义')

/** 主题选择区展开态（内联）。移动端改用全屏浮层。 */
const themeOpen = ref(false)

function toggleThemePanel(): void {
  themeOpen.value = !themeOpen.value
}

/* 退出登录：必须二次确认（UI-V2 §3） */
const logoutOpen = ref(false)

function openLogout(): void {
  logoutOpen.value = true
}

async function confirmLogout(): Promise<void> {
  logoutOpen.value = false
  themeOpen.value = false
  await auth.logout()
  void router.replace({ name: 'login' })
}

defineExpose({ themeOpen, logoutOpen })
</script>

<template>
  <section class="profile" :class="{ 'profile--embedded': props.embedded }">
    <header v-if="!props.embedded" class="profile__head">
      <button
        class="profile__back touch-target"
        type="button"
        :aria-label="isMobile ? '返回会话列表' : '返回'"
        @click="goBack"
      >
        <AppIcon name="back" :size="18" />
      </button>
      <span class="profile__title">个人资料</span>
    </header>

    <div v-if="!user" class="profile__loading">加载中…</div>

    <div v-else class="profile__body">
      <!-- 头像 -->
      <div class="profile__hero">
        <button
          class="profile__avatar-btn"
          type="button"
          :disabled="avatarBusy"
          :aria-label="avatarBusy ? '正在上传头像' : '更换头像'"
          @click="pickAvatar"
        >
          <AppAvatar
            :name="user.displayName"
            :seed="user.id"
            :size="80"
            :radius="16"
            :src="avatarSrc"
          />
          <span class="profile__avatar-mask">{{ avatarBusy ? '上传中…' : '更换' }}</span>
        </button>
        <div class="profile__hero-text">
          <div class="profile__name">{{ user.displayName }}</div>
          <div class="profile__sub">
            账号 <b>{{ user.username }}</b>
            <span class="profile__dot">·</span>
            UID <b class="profile__uid">{{ uidText }}</b>
          </div>
          <div class="profile__hero-actions">
            <AppButton
              label="更换头像"
              tone="ghost"
              size="sm"
              :loading="avatarBusy"
              @click="pickAvatar"
            />
            <AppButton
              v-if="user.avatarUrl"
              label="恢复默认"
              tone="ghost"
              size="sm"
              :disabled="avatarBusy"
              @click="clearAvatar"
            />
          </div>
        </div>
      </div>

      <input
        ref="avatarInput"
        class="profile__file"
        type="file"
        accept="image/*"
        tabindex="-1"
        aria-hidden="true"
        @change="onAvatarChange"
      />
      <p class="profile__hint">支持 JPG / PNG / WebP / GIF，不超过 {{ avatarLimitText }}。</p>

      <!-- 只读身份信息 -->
      <div class="profile__section-title">账号信息</div>
      <div class="profile__kv">
        <span class="profile__k">账号名称</span>
        <span class="profile__v">
          {{ user.username }}
          <button class="profile__copy" type="button" aria-label="复制账号名" @click="copyUsername">
            <AppIcon name="check" :size="12" />
            复制
          </button>
        </span>
        <span class="profile__k">UID</span>
        <span class="profile__v">
          <b class="profile__uid">{{ uidText }}</b>
          <button
            class="profile__copy"
            type="button"
            :aria-label="copied ? 'UID 已复制' : '复制 UID'"
            :data-copied="copied ? '1' : '0'"
            @click="copyUid"
          >
            <AppIcon :name="copied ? 'double-check' : 'check'" :size="12" />
            {{ copied ? '已复制' : '复制' }}
          </button>
          <span class="profile__readonly">不可修改</span>
        </span>
        <span class="profile__k">账号状态</span>
        <span class="profile__v">
          <span class="profile__pill" :class="`profile__pill--${user.status}`">
            {{ user.status === 'banned' ? '已被禁用' : '正常' }}
          </span>
          <span v-if="user.role === 'admin'" class="profile__pill profile__pill--admin">管理员</span>
        </span>
      </div>

      <!-- 可编辑信息 -->
      <div class="profile__section-title">可编辑信息</div>
      <AppInput v-model="displayName" label="昵称" placeholder="请输入昵称" :maxlength="24" />
      <div class="profile__bio">
        <label class="profile__bio-label" for="profile-bio">个人简介</label>
        <textarea
          id="profile-bio"
          v-model="bio"
          class="profile__bio-input"
          placeholder="介绍一下自己（选填）"
          maxlength="120"
          rows="3"
        />
        <span class="profile__bio-count">{{ bio.length }} / 120</span>
      </div>

      <div class="profile__actions">
        <AppButton label="保存" :loading="saving" :disabled="!canSave" @click="save" />
        <AppButton label="撤销" tone="ghost" :disabled="!dirty || saving" @click="resetForm" />
      </div>
      <p v-if="!dirty" class="profile__hint profile__hint--quiet">
        账号名称与 UID 由系统分配，不支持修改。
      </p>

      <!-- 我的动态 -->
      <template v-if="postCount > 0">
        <div class="profile__section-title">我的动态</div>
        <button class="profile__row" type="button" @click="openMyPosts">
          <span class="profile__row-icon"><AppIcon name="compass" :size="18" /></span>
          <span class="profile__row-main">
            <span class="profile__row-label">我发布的动态</span>
            <span class="profile__row-sub">共 {{ postCount }} 条</span>
          </span>
          <span class="profile__row-chev" aria-hidden="true">
            <AppIcon name="expand-more" :size="16" />
          </span>
        </button>
      </template>

      <!-- 账号与安全 -->
      <div class="profile__section-title">账号与安全</div>
      <button
        class="profile__row"
        type="button"
        :aria-expanded="themeOpen"
        aria-controls="profile-theme-panel"
        @click="toggleThemePanel"
      >
        <span class="profile__row-icon"><AppIcon name="sun" :size="18" /></span>
        <span class="profile__row-main">
          <span class="profile__row-label">主题</span>
          <span class="profile__row-sub">{{ themeName }}</span>
        </span>
        <span class="profile__row-chev" :class="{ 'profile__row-chev--open': themeOpen }" aria-hidden="true">
          <AppIcon name="expand-more" :size="16" />
        </span>
      </button>

      <div v-if="themeOpen" id="profile-theme-panel" class="profile__theme" :class="{ 'profile__theme--full': isMobile }">
        <div v-if="isMobile" class="profile__theme-head">
          <span class="profile__theme-title">主题</span>
          <button
            class="profile__theme-close touch-target"
            type="button"
            aria-label="关闭主题选择"
            @click="themeOpen = false"
          >
            <AppIcon name="close" :size="18" />
          </button>
        </div>
        <ThemePicker :compact="isMobile" />
      </div>

      <button class="profile__row profile__row--danger" type="button" @click="openLogout">
        <span class="profile__row-icon"><AppIcon name="logout" :size="18" /></span>
        <span class="profile__row-main">
          <span class="profile__row-label">退出登录</span>
          <span class="profile__row-sub">退出后需要重新输入账号与密码</span>
        </span>
        <span class="profile__row-chev" aria-hidden="true">
          <AppIcon name="expand-more" :size="16" />
        </span>
      </button>

      <p class="profile__hint profile__hint--quiet">AI Trance v2 · 账号数据仅用于站内交流</p>
    </div>

    <!-- 退出登录二次确认（UI-V2 §3 明确要求） -->
    <AppModal title="退出登录" :open="logoutOpen" :width="380" @close="logoutOpen = false">
      <p class="profile__confirm-text">退出后需要重新输入账号与密码才能继续使用，确定要退出吗？</p>
      <template #footer>
        <AppButton label="取消" tone="ghost" @click="logoutOpen = false" />
        <AppButton label="退出登录" tone="danger" @click="confirmLogout" />
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.profile {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--app-panel);
}
/* embedded：抽屉 full 态复用，撑满抽屉高度但内部仍滚动 */
.profile--embedded {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.profile__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--app-border);
}
.profile__back {
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
.profile__back:hover {
  background: var(--app-hover);
}
.profile__title {
  font-size: 14px;
  font-weight: 600;
}
.profile__loading {
  padding: 24px;
  color: var(--app-text-faint);
  font-size: 13px;
}
.profile__body {
  flex: 1;
  overflow-y: auto;
  padding: 22px 24px 36px;
  min-height: 0;
  max-width: 560px;
  width: 100%;
}
.profile__hero {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--app-border);
}
.profile__avatar-btn {
  position: relative;
  display: flex;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  flex: 0 0 auto;
}
.profile__avatar-btn:disabled {
  cursor: default;
}
.profile__avatar-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: rgb(0 0 0 / 0.45);
  color: #fff;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
.profile__avatar-btn:hover .profile__avatar-mask,
.profile__avatar-btn:focus-visible .profile__avatar-mask {
  opacity: 1;
}
.profile__hero-text {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.profile__name {
  font-size: 17px;
  font-weight: 600;
}
.profile__sub {
  font-size: 12px;
  color: var(--app-text-faint);
}
.profile__dot {
  margin: 0 4px;
}
.profile__uid {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
  color: var(--app-text);
}
.profile__hero-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.profile__file {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.profile__hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--app-text-faint);
}
.profile__hint--quiet {
  margin-top: 14px;
}
.profile__section-title {
  margin: 22px 0 10px;
  font-size: 13px;
  color: var(--app-text-muted);
}
.profile__kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 12px 12px;
  font-size: 13px;
  align-items: center;
}
.profile__k {
  color: var(--app-text-faint);
}
.profile__v {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
  word-break: break-all;
}
.profile__copy {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-muted);
  font-family: inherit;
  font-size: 11px;
  line-height: 18px;
  padding: 0 6px;
  cursor: pointer;
}
.profile__copy:hover {
  background: var(--app-hover);
  color: var(--app-text);
}
.profile__copy[data-copied='1'] {
  border-color: var(--color-brand-500);
  color: var(--color-brand-600);
}
.profile__readonly {
  font-size: 11px;
  color: var(--app-text-faint);
}
.profile__pill {
  display: inline-block;
  padding: 0 7px;
  border-radius: 10px;
  font-size: 11px;
  line-height: 18px;
  background: var(--app-hover);
  color: var(--app-text-muted);
}
.profile__pill--active {
  background: color-mix(in srgb, #2f9e6e 14%, transparent);
  color: #2f9e6e;
}
.profile__pill--banned {
  background: color-mix(in srgb, var(--color-danger-500) 14%, transparent);
  color: var(--color-danger-500);
}
.profile__pill--admin {
  background: color-mix(in srgb, var(--color-brand-500) 14%, transparent);
  color: var(--color-brand-600);
}
.profile__bio {
  position: relative;
  margin-top: 14px;
}
.profile__bio-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--app-text-muted);
}
.profile__bio-input {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px 22px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel);
  color: var(--app-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.55;
  resize: vertical;
  min-height: 78px;
}
.profile__bio-input:focus {
  outline: none;
  border-color: var(--color-brand-500);
}
.profile__bio-count {
  position: absolute;
  right: 9px;
  bottom: 7px;
  font-size: 11px;
  color: var(--app-text-faint);
  pointer-events: none;
}
.profile__actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
}

/* ── 行式入口（我的动态 / 主题 / 退出登录） ── */
.profile__row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  min-height: var(--spacing-touch-target);
  padding: 9px 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
  color: var(--app-text);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  margin-bottom: 8px;
  transition: background var(--dur-fast, 0.15s) var(--ease-both, ease);
}
.profile__row:hover {
  background: var(--app-hover);
}
.profile__row--danger .profile__row-label,
.profile__row--danger .profile__row-icon {
  color: var(--color-danger-500);
}
.profile__row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  color: var(--app-text-muted);
}
.profile__row-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.profile__row-label {
  font-size: 13px;
  color: var(--app-text);
}
.profile__row-sub {
  font-size: 11px;
  color: var(--app-text-faint);
}
.profile__row-chev {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  color: var(--app-text-faint);
  transition: transform var(--dur-fast, 0.15s) var(--ease-both, ease);
}
.profile__row-chev--open {
  transform: rotate(180deg);
}
.profile__theme {
  margin: 4px 0 14px;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-alt);
}
/* 移动端：全屏覆盖主题选择器（UI-V2 §3 / T6） */
.profile__theme--full {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet, 160);
  margin: 0;
  border: none;
  border-radius: 0;
  padding: calc(12px + var(--safe-top)) 16px calc(16px + var(--safe-bottom));
  overflow-y: auto;
  background: var(--app-panel);
}
.profile__theme-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.profile__theme-title {
  font-size: 15px;
  font-weight: 600;
}
.profile__theme-close {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--app-text-muted);
  cursor: pointer;
}
.profile__confirm-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text-muted);
}

@media (max-width: 767px) {
  .profile__head {
    padding-top: calc(8px + var(--safe-top));
    padding-left: calc(12px + var(--safe-left));
    padding-right: calc(12px + var(--safe-right));
  }
  .profile__head .profile__back {
    width: var(--spacing-touch-target);
    height: var(--spacing-touch-target);
    margin-left: -8px;
  }
  .profile__body {
    padding: 16px calc(16px + var(--safe-right)) 32px calc(16px + var(--safe-left));
  }
  /* 窄屏：头像与文字上下排，避免昵称/UID 被压成一条窄柱 */
  .profile__hero {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .profile__kv {
    grid-template-columns: 72px 1fr;
  }
  /* 手机输入 16px 防 iOS 聚焦缩放（与 useBreakpoint.MOBILE_INPUT_FONT_SIZE 一致） */
  .profile__bio-input {
    font-size: 16px;
  }
}
</style>
