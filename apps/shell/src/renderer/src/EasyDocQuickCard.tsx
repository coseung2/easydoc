import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { EasyDocApi, EasyDocPairingView, EasyDocState } from '../../shared/home-api'
import { useI18n } from './locale'

declare global {
  interface Window {
    easyDoc: EasyDocApi
  }
}

function pairingName(pairing: EasyDocState['pairings'][number]): string {
  return pairing.mobileId?.trim() || pairing.deviceId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function EasyDocQuickCard() {
  const { t } = useI18n()
  const [state, setState] = useState<EasyDocState | null>(null)
  const [pairing, setPairing] = useState<EasyDocPairingView | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.easyDoc
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch((error) => console.warn('[easydoc] failed to load state:', error))
    const unsubscribe = window.easyDoc.onStateChanged((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const pairings = state?.pairings ?? []
  const connected = pairings.some((item) => item.connected)
  const status = connected
    ? t('easyDocConnected')
    : pairings.length > 0
      ? t('easyDocWaiting')
      : t('easyDocConnect')

  const createPairing = async () => {
    if (busy) return
    setBusy(true)
    try {
      setPairing(await window.easyDoc.createPairing())
      setManageOpen(false)
    } catch (error) {
      window.alert(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const openCard = () => {
    if (pairings.length > 0) setManageOpen(true)
    else void createPairing()
  }

  const revokePairing = async (roomId: string) => {
    if (busy) return
    setBusy(true)
    try {
      await window.easyDoc.revokePairing(roomId)
      setState(await window.easyDoc.state())
    } catch (error) {
      window.alert(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const chooseReceiveDirectory = async () => {
    if (busy) return
    setBusy(true)
    try {
      await window.easyDoc.chooseReceiveDirectory()
      setState(await window.easyDoc.state())
    } catch (error) {
      window.alert(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const setAutoOpen = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      setState(await window.easyDoc.setAutoOpen(enabled))
    } catch (error) {
      window.alert(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button className="quick-card easydoc-card" onClick={openCard} disabled={busy}>
        <span className="quick-folder easydoc-phone-icon" aria-hidden="true">
          <svg width="17" height="20" viewBox="0 0 17 20" fill="none">
            <rect
              x="2.5"
              y="1.5"
              width="12"
              height="17"
              rx="2.5"
              stroke="currentColor"
              strokeWidth="1.3"
            />
            <path d="M7 15.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </span>
        <span className="quick-text">
          <span className="quick-title-row">
            <span className="quick-title">EasyDoc</span>
            {connected && <span className="easydoc-online-dot" aria-hidden="true" />}
          </span>
          <span className="quick-sub">{status}</span>
        </span>
      </button>

      {pairing && (
        <div className="modal-overlay" role="presentation" onMouseDown={() => setPairing(null)}>
          <div
            className="modal easydoc-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="easydoc-pair-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3 id="easydoc-pair-title">EasyDoc · {t('easyDocConnect')}</h3>
            <p>{t('easyDocPairHelp')}</p>
            <div className="easydoc-qr" aria-hidden="true">
              <QRCodeSVG
                value={`easydoc://pair?payload=${encodeURIComponent(pairing.qrPayload)}`}
                size={240}
                level="L"
                marginSize={4}
              />
            </div>
            <div className="modal-buttons">
              <button className="btn btn-secondary" onClick={() => setPairing(null)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {manageOpen && state && (
        <div className="modal-overlay" role="presentation" onMouseDown={() => setManageOpen(false)}>
          <div
            className="modal easydoc-modal easydoc-manage-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="easydoc-manage-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3 id="easydoc-manage-title">EasyDoc · {t('easyDocManage')}</h3>
            <div className="easydoc-device-list">
              {state.pairings.map((item) => (
                <div className="easydoc-device-row" key={item.roomId}>
                  <span className="easydoc-device-copy">
                    <strong>{pairingName(item)}</strong>
                    <span>{item.connected ? t('easyDocConnected') : t('easyDocWaiting')}</span>
                  </span>
                  <button
                    className="btn btn-secondary easydoc-small-button"
                    disabled={busy}
                    onClick={() => void revokePairing(item.roomId)}
                  >
                    {t('easyDocDisconnect')}
                  </button>
                </div>
              ))}
            </div>

            <div className="easydoc-setting-row">
              <span className="easydoc-setting-copy">
                <strong>{t('saveLocation')}</strong>
                <span title={state.receiveDir}>{state.receiveDir}</span>
              </span>
              <button
                className="btn btn-secondary easydoc-small-button"
                disabled={busy}
                onClick={() => void chooseReceiveDirectory()}
              >
                {t('setChange')}
              </button>
            </div>

            <label className="easydoc-auto-open">
              <input
                type="checkbox"
                checked={state.autoOpen}
                disabled={busy}
                onChange={(event) => void setAutoOpen(event.target.checked)}
              />
              <span>{t('easyDocAutoOpen')}</span>
            </label>

            <div className="modal-buttons easydoc-manage-actions">
              <button
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => void createPairing()}
              >
                {t('easyDocConnect')}
              </button>
              <button className="btn btn-secondary" onClick={() => setManageOpen(false)}>
                {t('cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
