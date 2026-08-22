// Minimal host-side DSH plugin (Cordis): exports name + apply(ctx).
export const name = 'dsh-desktop-test-plugin'

export function apply(ctx) {
  console.log('[dsh-desktop-test-plugin] loaded OK — apply() called')
  ctx.effect(() => {
    console.log('[dsh-desktop-test-plugin] disposed')
  })
}
