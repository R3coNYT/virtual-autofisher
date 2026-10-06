import { emojiUrl, parseDiscordMarkdown, type Block, type Span } from '../discordMarkdown'

/** A bot message rendered like Discord does it (Virtual Fisher container: accent bar on the left). */
export function DiscordMessage({ text, accent = 'border-l-red-500' }: { text: string; accent?: string }): JSX.Element {
  const blocks = parseDiscordMarkdown(text)
  return (
    <div className={`rounded-lg border border-white/10 border-l-4 ${accent} bg-[#2b2d31] px-4 py-3 text-[0.9375rem] leading-relaxed text-[#dbdee1]`}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
}

function BlockView({ block }: { block: Block }): JSX.Element {
  if (block.kind === 'blank') return <div className="h-3" aria-hidden />
  const content = block.spans.map((s, i) => <SpanView key={i} span={s} />)
  switch (block.kind) {
    case 'h1':
      return <p className="mb-1 mt-1 text-2xl font-bold text-white">{content}</p>
    case 'h2':
      return <p className="mb-1 mt-1 text-xl font-bold text-white">{content}</p>
    case 'h3':
      return <p className="mb-1 mt-1 text-base font-bold text-white">{content}</p>
    case 'sub':
      return <p className="text-xs text-[#949ba4]">{content}</p>
    default:
      return <p className="break-words">{content}</p>
  }
}

function SpanView({ span }: { span: Span }): JSX.Element {
  switch (span.kind) {
    case 'bold':
      return <strong className="font-bold text-white">{span.text}</strong>
    case 'italic':
      return <em>{span.text}</em>
    case 'code':
      return <code className="rounded bg-[#1e1f22] px-1 py-0.5 font-mono text-[0.85em] text-[#dbdee1]">{span.text}</code>
    case 'emoji':
      return (
        <img
          src={emojiUrl(span.id, span.animated)}
          alt={`:${span.name}:`}
          title={`:${span.name}:`}
          className="mx-0.5 inline-block h-5 w-5 align-text-bottom object-contain"
        />
      )
    default:
      return <>{span.text}</>
  }
}
