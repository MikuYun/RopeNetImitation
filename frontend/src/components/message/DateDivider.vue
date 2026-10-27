<script setup lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <div class="divider">
    <span class="divider__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.divider {
  display: flex;
  justify-content: center;
  margin: 16px 0 12px;
}
.divider__label {
  font-size: 11px;
  color: var(--app-text-faint);
  padding: 2px 8px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--app-text) 5%, transparent);
}
</style>
