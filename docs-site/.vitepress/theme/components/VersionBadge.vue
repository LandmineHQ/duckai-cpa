<template>
  <span class="version-badge">
    <span class="dot" aria-hidden="true"></span>
    <slot>v2.64</slot>
  </span>
</template>

<style scoped>
.version-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  padding: 2px 9px;
  border: 1px solid var(--vp-c-brand-soft);
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 0.76rem;
  font-weight: 600;
  vertical-align: middle;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
}
</style>
