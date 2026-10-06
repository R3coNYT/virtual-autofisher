export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export type Boost = { name: string; endsAt: number; by?: string }
export type CatchItem = { name: string; count: number }
export type RareCounts = { gold: number; emerald: number; lava: number; diamond: number }

/** 'stopping': graceful stop under way (fishing stopped, final /profile and /quests in flight). */
export type EngineState = 'idle' | 'connecting' | 'running' | 'paused' | 'resting' | 'stopping' | 'captcha' | 'error'
export type PauseReason = 'user' | 'network' | 'noResponse' | 'exception'
/** Detail sent with each engine state: pause/error/stop reason, captcha content. */
export type EngineInfo = {
  /** paused: a PauseReason code; error / idle (session limit): a message for the user. */
  reason?: string
  captchaImageUrl?: string
  captchaText?: string
  /** captcha: the bot accepted the answer, the engine resumes in a few seconds. */
  captchaSolved?: boolean
}

export type SelfUser = { id: string; username: string; avatarUrl: string }
export type GuildInfo = { id: string; name: string; iconUrl: string | null; hasVirtualFisher: boolean }
export type ChannelInfo = { id: string; name: string; parentName: string | null }

export type SlashCommandInfo = {
  name: string
  id: string
  version: string
  /** `choiceNames[i]` is the display label of `choices[i]` (the value sent). */
  options: { name: string; type: number; required: boolean; choices?: string[]; choiceNames?: string[] }[]
}

export type BotMessage = {
  id: string
  channelId: string
  content: string
  embeds: {
    title?: string
    description?: string
    fields: { name: string; value: string }[]
    imageUrl?: string
    footer?: string
  }[]
  ephemeral: boolean
  isEdit: boolean
  interactionUserId?: string
}

export type GameEvent =
  | {
      kind: 'catch'
      items: CatchItem[]
      xp?: number
      levelUp?: number
      treasure?: string[]
      /** Names of the quests completed by this catch (line after "QUEST COMPLETE"), e.g. "Daily Level-ups Tier 3". */
      questsCompleted?: string[]
      raw: string
    }
  | { kind: 'sell'; earned: number; xp?: number }
  | {
      kind: 'inventory'
      balance: number
      level: number
      xpToNext?: number
      rod?: string
      biome?: string
      bait?: { name: string; count: number }
      rare: { gold: number; emerald: number; lava: number; diamond: number }
      /** "Fish Value: $N": what the fish in the inventory would sell for. */
      fishValue?: number
    }
  | {
      kind: 'stats'
      crates?: number
      quests?: number
      trips?: number
      dailyStreak?: number
      totals: Partial<RareCounts>
    }
  /** /boosts. Virtual Fisher's own boosts are named 'Personal' and 'Global' (`by`: current global booster). */
  | { kind: 'boosts'; active: Boost[] }
  /** /boosters: personal boosters owned (0 for "You have no boosters!"). */
  | { kind: 'boosters'; personal: number }
  | { kind: 'purchase'; item: string; amount: number; cost?: number }
  /** `nextInMs`: when the reply states when the next daily is available. */
  | { kind: 'daily'; reward: string; nextInMs?: number }
  | { kind: 'quests'; quests: { label: string; progress: string; done: boolean }[] }
  | { kind: 'cooldown'; waitMs: number }
  | { kind: 'captcha'; imageUrl?: string; text: string }
  | { kind: 'captchaSolved' }
  | { kind: 'captchaFailed'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'unknown'; title?: string; text: string }

export type LogEntry = {
  id: number
  at: number
  type: 'catch' | 'trade' | 'system' | 'error' | 'unknown'
  text: string
  highlight?: boolean
  /** Set on the "Reached level N!" entry (structured, for notifications). */
  levelUp?: number
}

export type GameSnapshot = {
  account: {
    balance: number | null
    level: number | null
    xpToNext: number | null
    rod: string | null
    biome: string | null
    bait: { name: string; count: number } | null
    /** Sell value of the fish inventory (last /profile), null when unknown. */
    fishValue: number | null
    rare: RareCounts
    totals: Partial<RareCounts> & { crates?: number; quests?: number; trips?: number; dailyStreak?: number }
    /** Personal boosters owned (last /boosters), null when unknown. */
    personalBoosters: number | null
  }
  boosts: Boost[]
  quests: { label: string; progress: string; done: boolean }[]
  session: {
    startedAt: number | null
    catches: number
    fishBySpecies: Record<string, number>
    moneyEarned: number
    xpEarned: number
    sells: number
    captchas: number
    commandsSent: number
    rareCaught: RareCounts
    /** Fish value of the first /profile of the session (null until then). */
    fishValueStart: number | null
    /** (latest fish value - fishValueStart) + money earned from sells; null before the first /profile. */
    valueGained: number | null
  }
  nextFishAt: number | null
  nextDailyAt: number | null
  log: LogEntry[]
}

/** Account values kept between sessions and app restarts (state.json). */
export type PersistedAccount = Pick<
  GameSnapshot['account'],
  'balance' | 'fishValue' | 'level' | 'xpToNext' | 'rod' | 'biome' | 'bait' | 'rare' | 'totals' | 'personalBoosters'
>

export type SessionSummary = GameSnapshot['session'] & { endedAt: number }

export type Config = {
  version: number
  tokenEncrypted?: string
  target: { guildId: string; channelId: string } | null
  fishing: { baseCooldownSec: number; jitterSec: number; minGapSec: number }
  sell: { enabled: boolean; mode: 'catches' | 'minutes'; every: number }
  buffs: { enabled: boolean; lengthMin: 5 | 20 }
  /** autoPersonal: activate a personal booster (/use) whenever none is active and one is owned. */
  boosters: { autoPersonal: boolean }
  bait: { enabled: boolean; name: string; autoAmount: boolean; amount: number }
  profile: { refreshMin: number }
  daily: { enabled: boolean }
  quests: { enabled: boolean }
  breaks: { enabled: boolean; workMin: number; workJitterMin: number; restMin: number; restJitterMin: number }
  sessionLimitH: number
  notifications: { captcha: boolean; sound: boolean; levelUp: boolean; rareFish: boolean }
  ui: { compactLog: boolean; closeToTray: boolean }
  capture: boolean
}

export const DEFAULT_CONFIG: Config = {
  version: 1,
  target: null,
  fishing: { baseCooldownSec: 3.5, jitterSec: 0.8, minGapSec: 2.5 },
  sell: { enabled: true, mode: 'catches', every: 25 },
  buffs: { enabled: false, lengthMin: 5 },
  boosters: { autoPersonal: false },
  bait: { enabled: false, name: '', autoAmount: true, amount: 0 },
  profile: { refreshMin: 5 },
  daily: { enabled: true },
  quests: { enabled: true },
  breaks: { enabled: false, workMin: 45, workJitterMin: 10, restMin: 5, restJitterMin: 2 },
  sessionLimitH: 0,
  notifications: { captcha: true, sound: true, levelUp: true, rareFish: true },
  ui: { compactLog: false, closeToTray: true },
  capture: false
}
