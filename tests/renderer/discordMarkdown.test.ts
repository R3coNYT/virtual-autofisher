import { describe, expect, it } from 'vitest'
import { parseDiscordMarkdown } from '../../src/renderer/discordMarkdown'

// The Virtual Fisher text captcha as the backend parser hands it over (raw Discord markdown: bold
// title line, then the description; the Rust parser tests check that the captcha event carries it).
const CAPTCHA_TEXT =
  '**Player\\_One <:crown:123>**\n### Anti-bot\n/verify <result>\nCode: **7CXG**\n\n' +
  'Please use **/verify** `7CXG` to continue playing.\n-# All captchas are case sensitive.'

describe('captcha markdown', () => {
  it('parses headings, subtext, bold, inline code, escapes and custom emoji', () => {
    const blocks = parseDiscordMarkdown(CAPTCHA_TEXT)
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
