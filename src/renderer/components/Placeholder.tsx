export function Placeholder({ title }: { title: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <h1 className="text-2xl font-semibold text-accent">{title}</h1>
    </div>
  )
}
