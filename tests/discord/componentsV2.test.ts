import { describe, expect, it } from 'vitest'
import { toBotMessage, type LibMessageLike } from '../../src/main/discord/toBotMessage'
import { parseMessage } from '../../src/main/parser'

// Virtual Fisher now answers with Discord "Components V2": no content, no embeds,
// the text lives in a CONTAINER of TEXT_DISPLAY components (shapes as built by the library).
const VF = '574652751745777665'
const SELF = '111'

const text = (content: string) => ({ type: 'TEXT_DISPLAY', content })
const sep = { type: 'SEPARATOR' }
const buttons = { type: 'ACTION_ROW', components: [{ type: 'BUTTON', label: 'Return' }] }
const container = (...components: unknown[]) => ({ type: 'CONTAINER', components })

const v2 = (components: unknown[]): LibMessageLike => ({
  id: 'm1',
  channelId: 'c1',
  content: '',
  author: { id: VF },
  embeds: [],
  flags: 32768,
  interaction: { user: { id: SELF } },
  mentions: { users: [] },
  components: components as LibMessageLike['components']
})

const CATCH = v2([
  container(
    text('**Player One**\n**You caught:**\n2 <:squid:1> Squid\n19 <:turtle:2> Turtle\n1 <:dolphin:3> Dolphin\n+17,518 XP\nGlobal boost by **Messor**!'),
    sep,
    { type: 'ACTION_ROW', components: [{ type: 'BUTTON', label: 'Fish Again' }, { type: 'BUTTON', label: 'Sell' }] }
  )
])

const INVENTORY = v2([
  container(
    text('### Inventory of Player_One'),
    text(
      'Clan: **Clan**\nBalance: **$136,570,161**.\n**Level 154**, 764,946/1,062,500 XP to next level.\n' +
        'Currently using <:rod:4> **Superium Rod**.\nCurrent biome: <:ocean:5> **Ocean**\nBait: <:bait:6> **Magic Bait** (34,422)'
    ),
    text('**Fish Inventory**\n**36** <:squid:1> Squid\n**456** <:turtle:2> Turtle\nFish Value: **$22,751,781**'),
    text('**Exotic Fish**\n**2,315** <:g:7> Gold Fish\n**849** <:e:8> Emerald Fish\n**5** <:l:9> Lava Fish\n**39** <:d:10> Diamond Fish'),
    sep,
    buttons
  )
])

const QUESTS = v2([
  container(
    text('**Quest List**\nQuests have multiple tiers, so keep fishing to get maximum rewards!'),
    text(
      '**Daily Level-ups** - 2/3\n*Level up 3 time(s)*\n**Daily Fishing** - 3002/5000\n*Catch 5000 fish.*\n' +
        '**Daily Artifact Hunter** - 17/25\n*Find 25 chests.*\n\n**SPECIAL DAILY QUEST**:\n**Pet Locator** - 0/1\n*Find a pet.*\n\nQuests reset in **10h 42m**'
    ),
    buttons
  )
])

describe('Components V2 messages', () => {
  it('toBotMessage turns a V2 container into a synthetic embed with title and text', () => {
    const bm = toBotMessage(INVENTORY, SELF)!
    expect(bm.embeds).toHaveLength(1)
    expect(bm.embeds[0].title).toBe('Inventory of Player_One')
    expect(bm.embeds[0].description).toContain('Balance: **$136,570,161**.')
    expect(bm.embeds[0].description).not.toContain('Inventory of')
  })

  it('takes the image of a media gallery or thumbnail (captcha)', () => {
    const bm = toBotMessage(
      v2([container(text('Please solve the captcha with /verify'), { type: 'MEDIA_GALLERY', items: [{ media: { url: 'https://media.discordapp.net/c.png' } }] })]),
      SELF
    )!
    expect(bm.embeds[0].imageUrl).toBe('https://media.discordapp.net/c.png')
    expect(parseMessage(bm).kind).toBe('captcha')
  })

  it('parses a V2 catch with "N Name" lines', () => {
    const e = parseMessage(toBotMessage(CATCH, SELF)!)
    expect(e).toMatchObject({
      kind: 'catch',
      items: [
        { name: 'Squid', count: 2 },
        { name: 'Turtle', count: 19 },
        { name: 'Dolphin', count: 1 }
      ],
      xp: 17518
    })
  })

  it('parses a V2 inventory', () => {
    const e = parseMessage(toBotMessage(INVENTORY, SELF)!)
    expect(e).toMatchObject({
      kind: 'inventory',
      balance: 136570161,
      level: 154,
      xpToNext: 1062500 - 764946,
      rod: 'Superium Rod',
      biome: 'Ocean',
      bait: { name: 'Magic Bait', count: 34422 },
      rare: { gold: 2315, emerald: 849, lava: 5, diamond: 39 }
    })
  })

  it('parses a V2 quest list', () => {
    const e = parseMessage(toBotMessage(QUESTS, SELF)!)
    expect(e.kind).toBe('quests')
    if (e.kind !== 'quests') return
    expect(e.quests).toEqual([
      { label: 'Daily Level-ups', progress: '2/3', done: false },
      { label: 'Daily Fishing', progress: '3002/5000', done: false },
      { label: 'Daily Artifact Hunter', progress: '17/25', done: false },
      { label: 'Pet Locator', progress: '0/1', done: false }
    ])
  })
})
