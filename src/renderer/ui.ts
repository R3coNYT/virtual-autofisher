/** Shared Tailwind class strings. */
export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ocean'

export const primaryButton = `inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-accent to-turquoise px-5 py-2.5 text-sm font-semibold text-ocean transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100 ${focusRing}`

export function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const msg = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
  return msg || 'Une erreur est survenue. Réessayez.'
}
