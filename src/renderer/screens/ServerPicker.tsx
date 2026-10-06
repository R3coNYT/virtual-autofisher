import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ArrowLeft, Check, Hash, Loader2, Search } from 'lucide-react'
import type { ChannelInfo, GuildInfo } from '../../shared/types'
import { Background } from '../components/Background'
import { useStore } from '../store'
import { cleanError, focusRing, primaryButton } from '../ui'

function GuildIcon({ guild, size }: { guild: GuildInfo; size: 'lg' | 'sm' }): JSX.Element {
  const dim = size === 'lg' ? 'h-14 w-14 text-lg' : 'h-9 w-9 text-sm'
  if (guild.iconUrl) return <img src={guild.iconUrl} alt="" className={`${dim} shrink-0 rounded-2xl object-cover`} />
  const initials = guild.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <span className={`${dim} flex shrink-0 items-center justify-center rounded-2xl bg-white/10 font-semibold text-slate-300`}>
      {initials || '?'}
    </span>
  )
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1">{message}</span>
      <button type="button" onClick={onRetry} className={`rounded-md px-2 py-1 font-medium text-white hover:bg-white/10 ${focusRing}`}>
        Réessayer
      </button>
    </div>
  )
}

export default function ServerPicker(): JSX.Element {
  const user = useStore((s) => s.user)
  const [guilds, setGuilds] = useState<GuildInfo[] | null>(null)
  const [guildError, setGuildError] = useState<string | null>(null)
  const [guild, setGuild] = useState<GuildInfo | null>(null)
  const [channels, setChannels] = useState<ChannelInfo[] | null>(null)
  const [channelError, setChannelError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [channelId, setChannelId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const channelReq = useRef(0)

  const loadGuilds = (): void => {
    setGuildError(null)
    setGuilds(null)
    window.api.guilds
      .list()
      .then(setGuilds)
      .catch((e) => setGuildError(cleanError(e)))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadGuilds, [])

  const loadChannels = (g: GuildInfo): void => {
    const req = ++channelReq.current
    setChannelError(null)
    setChannels(null)
    window.api.channels
      .list(g.id)
      .then((list) => req === channelReq.current && setChannels(list))
      .catch((e) => req === channelReq.current && setChannelError(cleanError(e)))
  }

  function chooseGuild(g: GuildInfo): void {
    setGuild(g)
    setQuery('')
    setChannelId(null)
    setSaveError(null)
    loadChannels(g)
  }

  function back(): void {
    channelReq.current++
    setGuild(null)
    setChannels(null)
    setChannelError(null)
  }

  const sortedGuilds = useMemo(
    () =>
      guilds
        ? [...guilds].sort(
            (a, b) => Number(b.hasVirtualFisher) - Number(a.hasVirtualFisher) || a.name.localeCompare(b.name)
          )
        : null,
    [guilds]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '')
    return (channels ?? []).filter((c) => c.name.toLowerCase().includes(q))
  }, [channels, query])

  async function confirm(): Promise<void> {
    if (!guild || !channelId) return
    setSaving(true)
    setSaveError(null)
    try {
      await window.api.target.set(guild.id, channelId)
      const s = useStore.getState()
      s.setTarget({ guildId: guild.id, channelId })
      s.setTargetNames({
        guildId: guild.id,
        channelId,
        guildName: guild.name,
        channelName: channels?.find((c) => c.id === channelId)?.name ?? channelId
      })
      s.goto('dashboard')
    } catch (e) {
      setSaveError(cleanError(e))
      setSaving(false)
    }
  }

  return (
    <Background>
      <main className="mx-auto flex min-h-full max-w-3xl flex-col gap-6 px-6 py-10">
        <header>
          <h1 className="text-xl font-semibold tracking-tight text-white">
            {guild ? 'Choisissez un salon' : 'Choisissez un serveur'}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {guild
              ? `Les commandes seront envoyées dans le salon choisi de ${guild.name}.`
              : `${user ? `${user.username}, s` : 'S'}électionnez le serveur où se trouve Virtual Fisher.`}
          </p>
        </header>

        {!guild && (
          <>
            {guildError && <ErrorBox message={guildError} onRetry={loadGuilds} />}
            {!guildError && !sortedGuilds && (
              <div className="flex items-center gap-2 text-sm text-slate-400" role="status">
                <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden /> Chargement des serveurs…
              </div>
            )}
            {sortedGuilds && sortedGuilds.length === 0 && (
              <p className="rounded-xl border border-white/10 bg-white/5 p-5 text-sm text-slate-400">
                Aucun serveur trouvé sur ce compte.
              </p>
            )}
            {sortedGuilds && sortedGuilds.length > 0 && (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {sortedGuilds.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      disabled={!g.hasVirtualFisher}
                      onClick={() => chooseGuild(g)}
                      className={`flex h-full w-full flex-col items-center gap-3 rounded-2xl border p-4 text-center backdrop-blur transition ${focusRing} ${
                        g.hasVirtualFisher
                          ? 'border-white/10 bg-white/5 hover:-translate-y-0.5 hover:border-accent/40 hover:bg-white/10'
                          : 'cursor-not-allowed border-white/5 bg-white/[0.02] opacity-40 grayscale'
                      }`}
                    >
                      <GuildIcon guild={g} size="lg" />
                      <span className="line-clamp-2 break-words text-sm font-medium text-white">{g.name}</span>
                      {g.hasVirtualFisher ? (
                        <span className="rounded-full bg-turquoise/15 px-2 py-0.5 text-[11px] font-medium text-turquoise">
                          Virtual Fisher
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-500">Virtual Fisher absent</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {guild && (
          <section className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={back}
                aria-label="Retour aux serveurs"
                className={`rounded-xl border border-white/10 bg-white/5 p-2 text-slate-300 transition hover:bg-white/10 hover:text-white ${focusRing}`}
              >
                <ArrowLeft className="h-4 w-4" aria-hidden />
              </button>
              <GuildIcon guild={guild} size="sm" />
              <span className="font-medium text-white">{guild.name}</span>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher un salon"
                aria-label="Rechercher un salon"
                className={`w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-10 pr-3.5 text-sm text-white placeholder:text-slate-500 transition hover:border-white/20 focus:border-accent/60 ${focusRing}`}
              />
            </div>

            {channelError && <ErrorBox message={channelError} onRetry={() => loadChannels(guild)} />}
            {!channelError && !channels && (
              <div className="flex items-center gap-2 text-sm text-slate-400" role="status">
                <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden /> Chargement des salons…
              </div>
            )}
            {channels && (
              <ul
                aria-label="Salons"
                className="max-h-[22rem] divide-y divide-white/5 overflow-y-auto rounded-2xl border border-white/10 bg-white/5 backdrop-blur"
              >
                {filtered.length === 0 && <li className="p-5 text-sm text-slate-400">Aucun salon ne correspond.</li>}
                {filtered.map((c) => {
                  const selected = c.id === channelId
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => setChannelId(c.id)}
                        aria-pressed={selected}
                        className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                          selected ? 'bg-accent/15 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        <Hash className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                        <span className="flex-1 truncate">{c.name}</span>
                        {c.parentName && <span className="truncate text-xs text-slate-500">{c.parentName}</span>}
                        {selected && <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            {saveError && (
              <p role="alert" className="text-sm text-red-300">
                {saveError}
              </p>
            )}
            <div className="flex justify-end">
              <button type="button" onClick={() => void confirm()} disabled={!channelId || saving} className={primaryButton}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Utiliser ce salon
              </button>
            </div>
          </section>
        )}
      </main>
    </Background>
  )
}
