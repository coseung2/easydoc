import { isPairingPayload, type PairingPayload } from '@easydoc/protocol'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type PairingIssue = {
  pairing: PairingPayload
  desktopSecret: string
}

export type DesktopSession = {
  token: string
  peerPublicKey: string
  peerDeviceId?: string
}

function relayUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/u, '')}${path}`
}

async function parseError(response: Response): Promise<Error> {
  let code = `relay_http_${response.status}`
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) code = body.error
  } catch {
    // Keep the stable HTTP-derived fallback when the relay returns no JSON body.
  }
  return new Error(code)
}

async function postJson<T>(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  bearerToken?: string,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as T
}

export async function issuePairing(
  relayBaseUrl: string,
  input: { desktopId: string; publicKey: string; desktopAlias: string },
  fetchImpl: FetchLike = fetch,
): Promise<PairingIssue> {
  const body = await postJson<{ pairing?: unknown; desktopSecret?: unknown }>(
    fetchImpl,
    relayUrl(relayBaseUrl, '/pairing/issue'),
    { desktopId: input.desktopId, publicKey: input.publicKey },
  )
  if (
    !isPairingPayload(body.pairing) ||
    typeof body.desktopSecret !== 'string' ||
    !body.desktopSecret
  ) {
    throw new Error('pairing_invalid')
  }
  if (body.pairing.desktopId !== input.desktopId || body.pairing.publicKey !== input.publicKey) {
    throw new Error('pairing_invalid')
  }
  return {
    pairing: { ...body.pairing, desktopAlias: input.desktopAlias },
    desktopSecret: body.desktopSecret,
  }
}

export async function getDesktopSession(
  relayBaseUrl: string,
  input: { roomId: string; deviceId: string; bootstrapSecret: string },
  fetchImpl: FetchLike = fetch,
): Promise<DesktopSession> {
  const body = await postJson<{
    token?: unknown
    peerPublicKey?: unknown
    peerDeviceId?: unknown
  }>(fetchImpl, relayUrl(relayBaseUrl, '/pairing/session'), {
    roomId: input.roomId,
    role: 'desktop',
    deviceId: input.deviceId,
    bootstrapSecret: input.bootstrapSecret,
  })
  if (typeof body.token !== 'string' || !body.token || typeof body.peerPublicKey !== 'string') {
    throw new Error('pairing_invalid')
  }
  return {
    token: body.token,
    peerPublicKey: body.peerPublicKey,
    peerDeviceId: typeof body.peerDeviceId === 'string' ? body.peerDeviceId : undefined,
  }
}

export async function revokeRemotePairing(
  relayBaseUrl: string,
  sessionToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  await postJson<Record<string, unknown>>(
    fetchImpl,
    relayUrl(relayBaseUrl, '/pairing/revoke'),
    {},
    sessionToken,
  )
}

export function buildRelayWebSocketUrl(relayBaseUrl: string, token: string): string {
  const url = new URL(relayBaseUrl)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else throw new Error('relay_unavailable')
  url.pathname = '/connect'
  url.search = new URLSearchParams({ token }).toString()
  url.hash = ''
  return url.toString()
}
