<script setup lang="ts">
/** 登录。原创视觉：不使用任何第三方名称、logo 或专有配色。 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '@/components/base/AppButton.vue'
import AppInput from '@/components/base/AppInput.vue'
import AuthShell from '@/components/base/AuthShell.vue'
import { useAuthStore } from '@/stores/auth'
import { toApiError } from '@/api/http'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')
const error = ref('')
const submitting = ref(false)

const canSubmit = computed(() => username.value.trim().length > 0 && password.value.length > 0)

const facts = [
  '消息按会话隔离，断线自动重连',
  '支持群聊、在线状态与已读回执',
  '亮色 / 深色主题随系统切换',
]

async function onSubmit(): Promise<void> {
  if (!canSubmit.value || submitting.value) return
  error.value = ''
  submitting.value = true
  try {
    await auth.loginWith({ username: username.value.trim(), password: password.value })
    const next = route.query['next']
    // 环回保护：next 指向登录页时忽略
    if (typeof next === 'string' && next && !next.startsWith('/login')) {
      void router.replace(next)
    } else {
      void router.replace({ name: 'chat-empty' })
    }
  } catch (e) {
    error.value = toApiError(e).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <AuthShell eyebrow="Sign in" pitch="回到你的对话里。" :facts="facts">
    <div class="auth__form">
      <header class="auth__head">
        <h2 class="auth__title">登录</h2>
        <p class="auth__sub">使用你的账号名或 UID（如 10001）继续</p>
      </header>

      <AppInput
        v-model="username"
        label="账号名或 UID"
        placeholder="请输入用户名或 UID（如 10001）"
        hint="可用 UID 登录：在个人信息页可查到自己的 UID"
        @enter="onSubmit"
      />
      <AppInput
        v-model="password"
        label="密码"
        type="password"
        placeholder="请输入密码"
        :error="error"
        @enter="onSubmit"
      />
      <AppButton label="登录" block :loading="submitting" :disabled="!canSubmit" @click="onSubmit" />
      <p class="auth__switch">
        还没有账号？
        <RouterLink class="auth__link" :to="{ name: 'register' }">注册一个</RouterLink>
      </p>
    </div>
  </AuthShell>
</template>

<style scoped>
.auth__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
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
