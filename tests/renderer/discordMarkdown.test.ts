import { describe, expect, it } from 'vitest'
import { parseDiscordMarkdown } from '../../src/renderer/discordMarkdown'
import { rawText } from '../../src/main/parser/text'
import { parseMessage } from '../../src/main/parser'
import type { BotMessage } from '../../src/shared/types'

// The Virtual Fisher text captcha, as converted by componentsToEmbeds (title = bold first line).
const CAPTCHA: BotMessage = {
  id: '1',
  channelId: 'c1',
  content: '',
  ephemeral: false,
  isEdit: false,
  embeds: [
    {
      title: 'Player\\_One <:crown:123>',
      description:
        '### Anti-bot\n/verify <result>\nCode: **7CXG**\n\nPlease use **/verify** `7CXG` to continue playing.\n-# All captchas are case sensitive.',
      fields: []
    }
  ]
}

describe('captcha markdown', () => {
  it('the captcha event carries the raw Discord markdown for display', () => {
    const e = parseMessage(CAPTCHA)
    expect(e.kind).toBe('captcha')
    if (e.kind !== 'captcha') return
    expect(e.text).toBe(rawText(CAPTCHA))
    expect(e.text).toContain('Code: **7CXG**')
    expect(e.text.startsWith('**Player\\_One <:crown:123>**')).toBe(true)
  })

  it('parses headings, subtext, bold, inline code, escapes and custom emoji', () => {
    const blocks = parseDiscordMarkdown(rawText(CAPTCHA))
    expect(blocks[0]).toEqual({
      kind: 'p',
      spans: [{ kind: 'bold', text: 'Player_One ' }, { kind: 'emoji', id: '123', name: 'crown', animated: false }]
    })
    expect(blocks[1]).toEqual({ kind: 'h3', spans: [{ kind: 'text', text: 'Anti-bot' }] })
    expect(blocks[2]).toEqual({ kind: 'p', spans: [{ kind: 'text', text: '/verify <result>' }] })
    expect(blocks[3]).toEqual({ kind: 'p', spans: [{ kind: 'text', text: 'Code: ' }, { kind: 'bold', text: '7CXG' }] })
    expect(blocks[4]).toEqual({ kind: 'blank' })
    expect(blocks[5]).toEqual({
      kind: 'p',
      spans: [
        { kind: 'text', text: 'Please use ' },
        { kind: 'bold', text: '/verify' },
        { kind: 'text', text: ' ' },
        { kind: 'code', text: '7CXG' },
        { kind: 'text', text: ' to continue playing.' }
      ]
    })
    expect(blocks[6]).toEqual({ kind: 'sub', spans: [{ kind: 'text', text: 'All captchas are case sensitive.' }] })
  })

  it('italic, animated emoji and unclosed markers stay readable', () => {
    expect(parseDiscordMarkdown('*hi* <a:spin:9> **open')).toEqual([
      {
        kind: 'p',
        spans: [
          { kind: 'italic', text: 'hi' },
          { kind: 'text', text: ' ' },
          { kind: 'emoji', id: '9', name: 'spin', animated: true },
          { kind: 'text', text: ' **open' }
        ]
      }
    ])
  })
})
