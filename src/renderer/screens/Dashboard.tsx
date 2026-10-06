import { Background } from '../components/Background'
import { BoostChips } from '../components/BoostChips'
import { CatchLog } from '../components/CatchLog'
import { CommandBar } from '../components/CommandBar'
import { CooldownRing } from '../components/CooldownRing'
import { RareFishGrid } from '../components/RareFishGrid'
import { SidePanel } from '../components/SidePanel'
import { StatCard } from '../components/StatCard'
import { TopBar } from '../components/TopBar'
import { catchesPerHour, formatMoney, xpProgress } from '../format'
import { useStore } from '../store'
import { useNow } from '../useNow'

function signed(n: number): string {
  return `${n >= 0 ? '+' : '−'}${formatMoney(Math.abs(n))}`
}

export default function Dashboard(): JSX.Element {
  const game = useStore((s) => s.game)
  const log = useStore((s) => s.log)
  const compact = useStore((s) => s.config.ui.compactLog)
  const baseCooldownSec = useStore((s) => s.config.fishing.baseCooldownSec)
  const now = useNow()
  const { account, session } = game
  const xp = xpProgress(account.level, account.xpToNext)
  const rate = catchesPerHour(session.catches, session.startedAt, now)

  return (
    <Background>
      <div className="flex h-full min-h-[40rem] flex-col">
        <TopBar />
        <main className="flex min-h-0 flex-1 flex-col gap-4 p-5">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard label="Solde" value={formatMoney(account.balance)} sub={`${signed(session.moneyEarned)} cette session`} />
            <StatCard
              label="Niveau"
              value={account.level ?? '—'}
              sub={account.xpToNext != null ? `${account.xpToNext.toLocaleString('fr-FR')} XP restants` : undefined}
            >
              {xp != null && (
                <div
                  role="progressbar"
                  aria-label="Progression d'XP (estimée)"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(xp * 100)}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
                >
                  <div className="h-full rounded-full bg-gradient-to-r from-accent to-turquoise" style={{ width: `${xp * 100}%` }} />
                </div>
              )}
            </StatCard>
            <StatCard label="Prises" value={session.catches} sub={rate != null ? `${rate} / h` : '— / h'} />
            <StatCard
              label="Prochain /fish"
              value=""
              aside={<CooldownRing nextFishAt={game.nextFishAt} fallbackMs={baseCooldownSec * 1000} />}
            />
          </div>
          <BoostChips boosts={game.boosts} />
          <RareFishGrid game={game} />
          <div className="grid min-h-[16rem] flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
            <CatchLog log={log} compact={compact} />
            <SidePanel game={game} />
          </div>
          <CommandBar />
        </main>
      </div>
    </Background>
  )
}
