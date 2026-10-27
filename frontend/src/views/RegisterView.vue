<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/base/AppButton.vue'
import AppInput from '@/components/base/AppInput.vue'
import AuthShell from '@/components/base/AuthShell.vue'
import { useAuthStore } from '@/stores/auth'
import { toApiError } from '@/api/http'

const auth = useAuthStore()
const router = useRouter()

const username = ref('')
const password = ref('')
const displayName = ref('')
const error = ref('')
const submitting = ref(false)

const usernameError = computed(() => {
  const v = username.value.trim()
  if (!v) return ''
  if (v.length < 3) return '用户名至少 3 个字符'
  if (!/^[a-zA-Z0-9_]+$/.test(v)) return '只能包含字母、数字与下划线'
  return ''
})

const passwordError = computed(() => {
  if (!password.value) return ''
  if (password.value.length < 8) return '密码至少 8 位'
  return ''
})

/**
 * 【契约硬要求】后端 register 的 displayName 为 required 且有 minLength 1，
 * 缺字段或空串都会 400。此处于提交时回填 username —— 理由：username 本身
 * 已由上面的规则保证 3–32 位非空，是合法的 displayName；而让「昵称」变成
 * 必填会平白增加一次注册输入。UI 文案相应改为「留空则使用用户名」。
 */
const effectiveDisplayName = computed(
  () => displayName.value.trim() || username.value.trim(),
)

const canSubmit = computed(
  () =>
    username.value.trim().length >= 3 &&
    !usernameError.value &&
    password.value.length >= 8 &&
    !passwordError.value &&
    effectiveDisplayName.value.length >= 1,
)

const facts = [
  '30 秒完成注册，无需邮箱验证',
  '账号仅用于登录，不绑定任何第三方',
  '密码至少 8 位，服务端加盐存储',
]

async function onSubmit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  error.value = ''
  submitting.value = true
  try {
    // 始终携带 displayName（非空），不依赖后端放宽 schema
    await auth.registerWith({
      username: username.value.trim(),
      password: password.value,
      displayName: effectiveDisplayName.value,
    })
    void router.replace({ name: 'chat-empty' })
  } catch (e) {
    error.value = toApiError(e).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthShell eyebrow="Create account" pitch="两分钟，开始你的第一个对话。" :facts="facts">
    <div class="auth__form">
      <header class="auth__head">
        <h2 class="auth__title">创建账号</h2>
        <p class="auth__sub">注册成功后会自动登录</p>
      </header>

      <AppInput
        v-model="username"
        label="用户名"
        placeholder="字母、数字或下划线，3-32 位"
        :error="usernameError"
      />
      <AppInput v-model="displayName" label="昵称" placeholder="留空则使用用户名" :maxlength="40" />
      <AppInput
        v-model="password"
        label="密码"
        type="password"
        placeholder="至少 8 位"
        :error="passwordError || error"
      />
      <AppButton
        label="注册并登录"
        block
        :loading="submitting"
        :disabled="!canSubmit"
        @click="onSubmit"
      />
      <p class="auth__switch">
        已有账号？
        <RouterLink class="auth__link" :to="{ name: 'login' }">去登录</RouterLink>
      </p>
    </div>
  </AuthShell>
</template>

<style scoped>
.auth__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.auth__head {
  margin-bottom: var(--space-1);
}

.auth__title {
  margin: 0;
  font-size: var(--text-2xl);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  line-height: var(--lh-tight);
  color: var(--app-text);
}

.auth__sub {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  line-height: var(--lh-snug);
  color: var(--app-text-muted);
}

.auth__switch {
  margin: var(--space-1) 0 0;
  text-align: center;
  font-size: var(--text-xs);
  color: var(--app-text-muted);
}

.auth__link {
  color: var(--color-brand-600);
  font-weight: var(--weight-medium);
  text-decoration: none;
  border-bottom: 1px solid color-mix(in srgb, var(--color-brand-500) 32%, transparent);
  transition: border-color var(--dur-fast) var(--ease-both);
}

.auth__link:hover {
  border-bottom-color: var(--color-brand-500);
  color: var(--color-brand-700);
}
</style>
