import { describe, expect, it } from 'vitest'
import { toBotMessage, type LibMessageLike } from '../../src/main/discord/toBotMessage'

const VF = '574652751745777665'
const SELF = '111'
const OTHER = '222'

const make = (over: Partial<LibMessageLike> = {}): LibMessageLike => ({
  id: 'm1',
  channelId: 'c1',
  content: 'hello',
  author: { id: VF },
  embeds: [],
  flags: 0,
  mentions: { users: [] },
  ...over
})

describe('toBotMessage', () => {
  it('rejects messages not authored by Virtual Fisher', () => {
    expect(toBotMessage(make({ author: { id: OTHER }, interaction: { user: { id: SELF } } }), SELF)).toBeNull()
  })

  it('rejects a reply to another player interaction without mention', () => {
    expect(toBotMessage(make({ interaction: { user: { id: OTHER } }, content: 'You may now continue.' }), SELF)).toBeNull()
    expect(toBotMessage(make({ interactionMetadata: { user: { id: OTHER } } }), SELF)).toBeNull()
  })

  it('rejects a message with no interaction, no mention, not ephemeral', () => {
    expect(toBotMessage(make(), SELF)).toBeNull()
  })

  it('accepts a reply to our interaction', () => {
    const r = toBotMessage(make({ interaction: { user: { id: SELF } } }), SELF)
    expect(r).toMatchObject({ id: 'm1', channelId: 'c1', interactionUserId: SELF, ephemeral: false, isEdit: false })
  })

  it('accepts via interactionMetadata and prefers it over interaction', () => {
    expect(toBotMessage(make({ interactionMetadata: { user: { id: SELF } } }), SELF)).not.toBeNull()
    expect(
      toBotMessage(make({ interactionMetadata: { user: { id: OTHER } }, interaction: { user: { id: SELF } } }), SELF)
    ).toBeNull()
  })

  it('accepts when mentions.users contains us', () => {
    expect(toBotMessage(make({ mentions: { users: [{ id: SELF }] } }), SELF)).not.toBeNull()
    expect(toBotMessage(make({ mentions: { users: new Map([[SELF, { id: SELF }]]) } }), SELF)).not.toBeNull()
  })

  it('accepts when content mentions us, in both forms', () => {
    expect(toBotMessage(make({ content: `<@${SELF}> caught` }), SELF)).not.toBeNull()
    expect(toBotMessage(make({ content: `<@!${SELF}> caught` }), SELF)).not.toBeNull()
    expect(toBotMessage(make({ content: `<@${OTHER}> caught` }), SELF)).toBeNull()
  })

  it('flag 64 means ephemeral and is accepted', () => {
    expect(toBotMessage(make({ flags: 64 }), SELF)?.ephemeral).toBe(true)
    expect(toBotMessage(make({ flags: { bitfield: 64 | 1 } }), SELF)?.ephemeral).toBe(true)
  })

  it('maps embeds including image and footer', () => {
    const r = toBotMessage(
      make({
        interaction: { user: { id: SELF } },
        embeds: [
          {
            title: 'T',
            description: 'D',
            fields: [{ name: 'n', value: 'v' }],
            image: { url: 'http://img/x.png' },
            footer: { text: 'foot' }
          },
          { fields: [] }
        ]
      }),
      SELF
    )
    expect(r?.embeds[0]).toEqual({
      title: 'T',
      description: 'D',
      fields: [{ name: 'n', value: 'v' }],
      imageUrl: 'http://img/x.png',
      footer: 'foot'
    })
    expect(r?.embeds[1].fields).toEqual([])
    expect(r?.embeds[1].imageUrl).toBeUndefined()
  })

  it('applies the same rule to edits and sets isEdit', () => {
    expect(toBotMessage(make({ interaction: { user: { id: OTHER } } }), SELF, true)).toBeNull()
    expect(toBotMessage(make({ interaction: { user: { id: SELF } } }), SELF, true)?.isEdit).toBe(true)
  })

  it('does not accept a foreign captchaSolved message', () => {
    const foreign = make({
      interaction: { user: { id: OTHER } },
      embeds: [{ title: 'Captcha solved', description: 'You may now continue.', fields: [] }]
    })
    expect(toBotMessage(foreign, SELF)).toBeNull()
  })

  it('rejects a bare self id in content without mention syntax', () => {
    expect(toBotMessage(make({ content: `user ${SELF} fished` }), SELF)).toBeNull()
  })

  it('accepts another user interaction when we are mentioned, keeping their id', () => {
    const r = toBotMessage(make({ interaction: { user: { id: OTHER } }, mentions: { users: [{ id: SELF }] } }), SELF)
    expect(r?.interactionUserId).toBe(OTHER)
  })
})
