<script setup lang="ts">
/**
 * 实时声波：直读 audioEngine.levels（非响应式），rAF 绘制 64 根镜像柱。
 * 录音中为翡翠绿渐变，静默/暂停为暗灰平线。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { audioEngine } from '../services/audio'

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: false })

const canvasRef = ref<HTMLCanvasElement | null>(null)
let raf = 0
let observer: ResizeObserver | null = null

function resize(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = canvas.clientWidth * dpr
  canvas.height = canvas.clientHeight * dpr
}

function draw(): void {
  const canvas = canvasRef.value
  if (canvas) {
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)

      const bars = 64
      const gap = Math.max(2, w * 0.004)
      const bw = (w - gap * (bars - 1)) / bars

      let grad: CanvasGradient | string
      if (props.active) {
        grad = ctx.createLinearGradient(0, 0, w, 0)
        grad.addColorStop(0, '#34d399')
        grad.addColorStop(0.5, '#10b981')
        grad.addColorStop(1, '#059669')
      } else {
        grad = '#3f3f46'
      }
      ctx.fillStyle = grad

      for (let i = 0; i < bars; i++) {
        const v = audioEngine.levels[i]
        const barH = Math.max(canvas.height * 0.03, v * h * 0.94)
        const x = i * (bw + gap)
        const y = (h - barH) / 2
        ctx.beginPath()
        const r = Math.min(bw / 2, 3)
        ctx.roundRect(x, y, bw, barH, r)
        ctx.fill()
      }
    }
  }
  raf = requestAnimationFrame(draw)
}

onMounted(() => {
  resize()
  observer = new ResizeObserver(resize)
  if (canvasRef.value) observer.observe(canvasRef.value)
  raf = requestAnimationFrame(draw)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  observer?.disconnect()
})
</script>

<template>
  <canvas ref="canvasRef" class="h-22 w-full" :class="active ? 'opacity-100' : 'opacity-60'" />
</template>
