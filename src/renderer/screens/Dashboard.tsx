import { Background } from '../components/Background'
import { BoostChips } from '../components/BoostChips'
import { CatchLog } from '../components/CatchLog'
import { CommandBar } from '../components/CommandBar'
import { CooldownRing } from '../components/CooldownRing'
import { RareFishGrid } from '../components/RareFishGrid'
import { SidePanel } from '../components/SidePanel'
import { StatCard } from '../components/StatCard'
import { TopBar } from '../components/TopBar'
import { catchesPerHour, formatMoney } from '../format'
import { useStore } from '../store'
import { useNow } from '../useNow'

function signed(n: number): string {
  return `${n >= 0 ? '+' : '−'}${formatMoney(Math.abs(n))}`
}

function RateCard({ catches, startedAt }: { catches: number; startedAt: number | null }): JSX.Element {
  const now = useNow()
  const rate = catchesPerHour(catches, startedAt, now)
  return <StatCard label="Prises" value={catches} sub={rate != null ? `${rate} / h` : '— / h'} />
}

export default function Dashboard(): JSX.Element {
  const account = useStore((s) => s.game.account)
  const session = useStore((s) => s.game.session)
  const nextFishAt = useStore((s) => s.game.nextFishAt)
  const nextDailyAt = useStore((s) => s.game.nextDailyAt)
  const boosts = useStore((s) => s.game.boosts)
  const quests = useStore((s) => s.game.quests)
  const log = useStore((s) => s.log)
  const compact = useStore((s) => s.config.ui.compactLog)
  const baseCooldownSec = useStore((s) => s.config.fishing.baseCooldownSec)

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
              sub={
                account.xpToNext != null
                  ? `${account.xpToNext.toLocaleString('fr-FR')} XP avant le niveau ${(account.level ?? 0) + 1}`
                  : undefined
              }
            />
            <RateCard catches={session.catches} startedAt={session.startedAt} />
            <StatCard
              label="Prochain /fish"
              aside={<CooldownRing nextFishAt={nextFishAt} fallbackMs={baseCooldownSec * 1000} />}
            />
          </div>
          <BoostChips boosts={boosts} />
          <RareFishGrid session={session.rareCaught} total={account.rare} />
          <div className="grid min-h-[16rem] flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
            <CatchLog log={log} compact={compact} />
            <SidePanel account={account} quests={quests} nextDailyAt={nextDailyAt} />
          </div>
          <CommandBar />
        </main>
      </div>
    </Background>
  )
}
