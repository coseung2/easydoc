import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildRelayWebSocketUrl,
  getDesktopSession,
  issuePairing,
  revokeRemotePairing,
  type FetchLike,
} from '../src/pairing.ts'

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('issues a pairing, injects desktop alias locally, and refreshes a desktop session', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/pairing/issue')) {
      const body = JSON.parse(String(init?.body)) as { desktopId: string; publicKey: string }
      return jsonResponse({
        pairing: {
          version: 1,
          desktopId: body.desktopId,
          roomId: 'room-1',
          publicKey: body.publicKey,
          pairingToken: 'pairing-token',
          expiresAt: Date.now() + 60_000,
        },
        desktopSecret: 'desktop-secret',
      })
    }
    if (url.endsWith('/pairing/session')) {
      return jsonResponse({
        token: 'session-token',
        peerPublicKey: 'mobile-public-key',
        peerDeviceId: 'phone-1',
      })
    }
    if (url.endsWith('/pairing/revoke')) return jsonResponse({ ok: true })
    return jsonResponse({ error: 'not_found' }, 404)
  }

  const issued = await issuePairing(
    'https://relay.example/',
    { desktopId: 'desktop-1', publicKey: 'desktop-public-key', desktopAlias: '교무실 PC' },
    fetchImpl,
  )
  assert.equal(issued.pairing.desktopAlias, '교무실 PC')
  assert.equal(issued.desktopSecret, 'desktop-secret')

  const session = await getDesktopSession(
    'https://relay.example',
    { roomId: 'room-1', deviceId: 'desktop-1', bootstrapSecret: 'desktop-secret' },
    fetchImpl,
  )
  assert.deepEqual(session, {
    token: 'session-token',
    peerPublicKey: 'mobile-public-key',
    peerDeviceId: 'phone-1',
  })

  await revokeRemotePairing('https://relay.example', 'session-token', fetchImpl)
  const revoke = calls.find((call) => call.url.endsWith('/pairing/revoke'))
  assert.equal(
    (revoke?.init?.headers as Record<string, string>).authorization,
    'Bearer session-token',
  )
})

test('builds the secure relay websocket URL without preserving unrelated path/query state', () => {
  assert.equal(
    buildRelayWebSocketUrl('https://relay.example/base?old=1', 'token value'),
    'wss://relay.example/connect?token=token+value',
  )
  assert.throws(() => buildRelayWebSocketUrl('ftp://relay.example', 'token'), /relay_unavailable/)
})

test('surfaces stable relay error codes', async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ error: 'pairing_invalid' }, 401)
  await assert.rejects(
    () =>
      getDesktopSession(
        'https://relay.example',
        { roomId: 'room-1', deviceId: 'desktop-1', bootstrapSecret: 'bad' },
        fetchImpl,
      ),
    /pairing_invalid/,
  )
})
