import { describe, expect, it } from 'vitest'
import { welcomeReply, WELCOME_SETUP_URL, WELCOME_SHOW_TOKEN_COMMAND } from './welcome-chat'

describe('welcomeReply', () => {
  it('greets a hello without pretending to be a real agent', () => {
    const reply = welcomeReply('hi there')
    expect(reply).toMatch(/local preview/i)
    expect(reply).not.toMatch(/error/i)
  })

  it('points setup-related questions at the steps, the token command, and the guide', () => {
    const reply = welcomeReply('how do I connect my server?')
    expect(reply).toContain(WELCOME_SHOW_TOKEN_COMMAND)
    expect(reply).toContain(WELCOME_SETUP_URL)
  })

  it('falls back to a setup nudge for anything else', () => {
    const reply = welcomeReply('write me a poem')
    expect(reply).toMatch(/can't run a real agent turn/i)
    expect(reply).toContain(WELCOME_SETUP_URL)
  })
})
