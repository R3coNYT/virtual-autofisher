import type { ReactNode } from 'react'

/** Ocean backdrop with soft cyan/turquoise glows; children are laid out above it. */
export function Background({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="relative h-full overflow-y-auto bg-ocean">
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-accent/10 blur-3xl" />
        <div className="absolute -bottom-48 -right-32 h-[30rem] w-[30rem] rounded-full bg-turquoise/10 blur-3xl" />
      </div>
      <div className="relative min-h-full">{children}</div>
    </div>
  )
}
