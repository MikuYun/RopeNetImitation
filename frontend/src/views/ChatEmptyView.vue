<script setup lang="ts">
/**
 * 未选中会话时的中栏空态。
 *
 * 视觉：整块画布铺 `--chat-canvas` 的柔光背景，中间是 AppEmpty 的几何插画，
 * 下方补三条「引导入口」提示（纯文案徽章，不新增可点击元素，避免抢焦点 /
 * 干扰 e2e 的 .btn 顺序契约）。
 */
import AppEmpty from '@/components/base/AppEmpty.vue'

const tips = ['左侧选择会话', '切换「联系人」添加好友', '点加号发起群聊']
</script>

<template>
  <section class="blank">
    <span class="blank__glow" aria-hidden="true" />
    <div class="blank__inner">
      <AppEmpty
        icon="chat"
        title="选择一个会话开始聊天"
        description="左侧是会话列表。也可以切换到「联系人」添加好友，或点会话列表右上角的加号发起群聊"
      />
      <ul class="blank__tips" aria-label="快速上手">
        <li v-for="t in tips" :key="t" class="blank__tip">{{ t }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.blank {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
  background: var(--chat-canvas);
  background-image: var(--chat-canvas-image);
}

/* 中央一团极淡的品牌柔光，让大面积画布不平 */
.blank__glow {
  position: absolute;
  left: 50%;
  top: 44%;
  width: min(620px, 92%);
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  border-radius: var(--radius-full);
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--color-brand-400) 16%, transparent),
    transparent 78%
  );
  filter: blur(6px);
  pointer-events: none;
}

.blank__inner {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  max-width: 520px;
  padding: var(--space-6) var(--space-4);
  text-align: center;
}

.blank__tips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.blank__tip {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--app-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--app-panel) 72%, transparent);
  font-size: var(--text-2xs);
  line-height: var(--lh-snug);
  color: var(--app-text-muted);
  white-space: nowrap;
  backdrop-filter: blur(2px);
}

@media (max-width: 480px) {
  .blank__inner {
    gap: var(--space-4);
    padding: var(--space-4) var(--space-3);
  }
  .blank__tip {
    font-size: var(--text-2xs);
  }
}
</style>
