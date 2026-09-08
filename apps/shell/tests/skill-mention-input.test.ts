// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillMentionTextarea } from '../../../packages/ui/src/SkillMentionTextarea'
import type { UserSkillDefinition } from '@genoffice/agent-core'

const catalog: UserSkillDefinition[] = [
  {
    id: 'letter.v1',
    name: '공문 작성',
    description: 'Formal correspondence',
    content: 'Do not invent facts.',
    apps: ['docs'],
  },
  {
    id: 'report',
    name: 'Report',
    description: 'Summarize sources',
    content: 'Read sources first.',
  },
  {
    id: 'sheets-only',
    name: 'Sheet',
    description: '',
    content: 'Spreadsheet workflow',
    apps: ['sheets'],
  },
]
let root: Root
let host: HTMLDivElement
let input: HTMLTextAreaElement
const send = vi.fn()
const stop = vi.fn()
async function mount(load = async () => catalog) {
  function Harness() {
    const [value, setValue] = useState('')
    return createElement(SkillMentionTextarea, {
      value,
      onValueChange: setValue,
      skillApp: 'docs',
      loadSkills: load,
      onKeyDown: (event) => {
        if (event.key === 'Enter') send()
        if (event.key === 'Escape') stop()
      },
    })
  }
  await act(async () => {
    root.render(createElement(Harness))
  })
  input = host.querySelector('textarea')!
  await act(async () => {
    input.focus()
  })
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.setSelectionRange(value.length, value.length)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(value: string, options: KeyboardEventInit = {}) {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options }),
    )
  })
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  document.documentElement.lang = 'en'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  send.mockReset()
  stop.mockReset()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('skill mention input', () => {
  it('finds a Korean title and inserts the exact id without sending', async () => {
    await mount()
    await type('@공문')
    expect(host.querySelector('[role="option"]')?.textContent).toContain('@letter.v1')
    await key('Enter')
    expect(input.value).toBe('@letter.v1 ')
    expect(send).not.toHaveBeenCalled()
    await key('Enter')
    expect(send).toHaveBeenCalledOnce()
  })
  it('filters by editor and selects with arrows and Tab', async () => {
    await mount()
    await type('@')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2)
    await key('ArrowDown')
    await key('Tab')
    expect(input.value).toBe('@report ')
  })
  it('selects by mouse and preserves the remaining instruction', async () => {
    await mount()
    await type('@rep summarize this')
    await act(async () => {
      input.setSelectionRange(4, 4)
      input.dispatchEvent(new Event('select', { bubbles: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const option = host.querySelector<HTMLButtonElement>('[role="option"]')
    expect(option).not.toBeNull()
    await act(async () => {
      option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      option!.click()
    })
    expect(input.value).toBe('@report summarize this')
  })
  it('ignores email addresses and fenced code', async () => {
    await mount()
    await type('user@rep')
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    await type('```\n@rep')
    expect(host.querySelector('[role="listbox"]')).toBeNull()
  })
  it('dismisses completion before allowing Escape to reach the stop handler', async () => {
    await mount()
    await type('@rep')
    await key('Escape')
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(stop).not.toHaveBeenCalled()
    await key('Escape')
    expect(stop).toHaveBeenCalledOnce()
  })
  it('never sends or selects on Korean IME Enter', async () => {
    await mount()
    await type('@공')
    await key('Enter', { isComposing: true })
    await key('Enter', { keyCode: 229 })
    expect(input.value).toBe('@공')
    expect(send).not.toHaveBeenCalled()
  })
  it('distinguishes discovery errors from an empty match', async () => {
    await mount(async () => {
      throw new Error('read failed')
    })
    await type('@')
    expect(host.textContent).toContain('Could not load skills')
  })
})
