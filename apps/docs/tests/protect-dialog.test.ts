// Protect Document dialog (Review > Protect): the dialog turns form state into
// a diff (ProtectDialogResult) — untouched sections must stay undefined, and
// removing a password-protected restriction must verify the password first.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { hashProtectionPassword, verifyProtectionPassword } from '@genoffice/docx-engine'
import { ProtectDialog, type ProtectDialogResult } from '../src/renderer/components/ProtectDialog'

const { protectionJobs } = vi.hoisted(() => ({ protectionJobs: new Set<Promise<unknown>>() }))

vi.mock('@genoffice/docx-engine', async (importOriginal) => {
  const engine = await importOriginal<typeof import('@genoffice/docx-engine')>()
  const track = <T>(job: Promise<T>): Promise<T> => {
    protectionJobs.add(job)
    void job.then(
      () => protectionJobs.delete(job),
      () => protectionJobs.delete(job),
    )
    return job
  }
  return {
    ...engine,
    hashProtectionPassword: (...args: Parameters<typeof engine.hashProtectionPassword>) =>
      track(engine.hashProtectionPassword(...args)),
    verifyProtectionPassword: (...args: Parameters<typeof engine.verifyProtectionPassword>) =>
      track(engine.verifyProtectionPassword(...args)),
  }
})

const mountedDialogs = new Set<() => Promise<void>>()
afterEach(async () => {
  for (const cleanup of mountedDialogs) await cleanup()
})

type Props = Parameters<typeof ProtectDialog>[0]

const DEFAULTS: Omit<Props, 'onApply' | 'onCancel'> = {
  encrypted: false,
  writeProtection: null,
  protection: null,
  removePersonalInfo: false,
}

async function mount(partial: Partial<Props>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const onApply = vi.fn<(result: ProtectDialogResult) => void>()
  const onCancel = vi.fn()
  let root: Root
  await act(async () => {
    root = createRoot(host)
    root.render(createElement(ProtectDialog, { ...DEFAULTS, onApply, onCancel, ...partial }))
  })
  const passwordInputs = () => [
    ...host.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ]
  const setValue = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  const click = async (el: Element) => {
    await act(async () => {
      ;(el as HTMLElement).click()
    })
  }
  // Await the real crypto work rather than imposing a second wall-clock timeout.
  // Default 100,000-round hashing can exceed a polling deadline under suite contention.
  const submit = async (done: () => boolean) => {
    await click(host.querySelector('.btn-primary')!)
    await act(async () => {
      while (protectionJobs.size) await Promise.all([...protectionJobs])
    })
    expect(done()).toBe(true)
  }
  const applied = () => onApply.mock.calls.length > 0
  const errorShown = () => host.querySelector('.fld-error') !== null
  const cleanup = async () => {
    await act(async () => root.unmount())
    host.remove()
    mountedDialogs.delete(cleanup)
  }
  mountedDialogs.add(cleanup)
  return {
    host,
    onApply,
    onCancel,
    passwordInputs,
    setValue,
    click,
    submit,
    applied,
    errorShown,
    cleanup,
  }
}

describe('ProtectDialog', () => {
  it('submitting untouched state yields an all-undefined diff (even when passwords exist)', async () => {
    const wp = await hashProtectionPassword('modify-pw', 1000)
    const d = await mount({ encrypted: true, writeProtection: wp })
    await d.submit(d.applied)
    expect(d.onApply).toHaveBeenCalledWith({})
    await d.cleanup()
  })

  it('clearing the open-password field of an encrypted document requests removal', async () => {
    const d = await mount({ encrypted: true })
    const [open, openConfirm] = d.passwordInputs()
    await d.setValue(open, '')
    await d.setValue(openConfirm, '')
    await d.submit(d.applied)
    expect(d.onApply).toHaveBeenCalledWith({ openPassword: null })
    await d.cleanup()
  })

  it('mismatched confirmation blocks the submit', async () => {
    const d = await mount({})
    const [open, openConfirm] = d.passwordInputs()
    await d.setValue(open, 'abc')
    await d.setValue(openConfirm, 'abd')
    await d.submit(d.errorShown)
    expect(d.onApply).not.toHaveBeenCalled()
    await d.cleanup()
  })

  it('setting a modify password produces verifiable writeProtection credentials', async () => {
    const d = await mount({})
    const [, , modify, modifyConfirm] = d.passwordInputs()
    await d.setValue(modify, 'to-modify')
    await d.setValue(modifyConfirm, 'to-modify')
    await d.submit(d.applied)
    const result = d.onApply.mock.calls[0][0]
    expect(result.openPassword).toBeUndefined()
    expect(result.writeProtection?.hash).toBeTruthy()
    expect(result.writeProtection?.spinCount).toBe(100000)
    expect(await verifyProtectionPassword('to-modify', result.writeProtection!)).toBe(true)
    await d.cleanup()
  })

  it('enabling a comments restriction without password enforces mode only', async () => {
    const d = await mount({})
    const [enable] = d.host.querySelectorAll('input[type="checkbox"]')
    await d.click(enable)
    const radios = d.host.querySelectorAll('input[type="radio"]')
    await d.click(radios[1]) // trackedChanges, comments, readOnly, forms
    await d.submit(d.applied)
    expect(d.onApply).toHaveBeenCalledWith({
      protection: { edit: 'comments', enforced: true },
    })
    await d.cleanup()
  })

  it('removing a password-protected restriction requires the correct password', async () => {
    const creds = await hashProtectionPassword('lock-pw', 1000)
    const d = await mount({ protection: { edit: 'readOnly', enforced: true, ...creds } })
    const [enable] = d.host.querySelectorAll('input[type="checkbox"]')
    await d.click(enable) // uncheck → unlock-password field appears
    const unlock = d.passwordInputs().at(-1)!
    await d.setValue(unlock, 'wrong')
    await d.submit(d.errorShown)
    expect(d.onApply).not.toHaveBeenCalled()

    await d.setValue(d.passwordInputs().at(-1)!, 'lock-pw')
    await d.submit(d.applied)
    expect(d.onApply).toHaveBeenCalledWith({ protection: null })
    await d.cleanup()
  })

  it('changing only the mode of an unlocked restriction keeps the existing hash', async () => {
    const creds = await hashProtectionPassword('lock-pw', 1000)
    const d = await mount({ protection: { edit: 'readOnly', enforced: true, ...creds } })
    const radios = d.host.querySelectorAll('input[type="radio"]')
    await d.click(radios[0]) // switch readOnly → trackedChanges
    await d.setValue(d.passwordInputs().at(-1)!, 'lock-pw')
    await d.submit(d.applied)
    const result = d.onApply.mock.calls[0][0]
    expect(result.protection).toMatchObject({ edit: 'trackedChanges', enforced: true })
    expect(result.protection?.hash).toBe(creds.hash)
    await d.cleanup()
  })

  it('toggling privacy reports only the privacy change', async () => {
    const d = await mount({})
    const checkboxes = d.host.querySelectorAll('input[type="checkbox"]')
    await d.click(checkboxes[checkboxes.length - 1])
    await d.submit(d.applied)
    expect(d.onApply).toHaveBeenCalledWith({ removePersonalInfo: true })
    await d.cleanup()
  })
})
