import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const CALLBACK_PATH = '/auth/callback'

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '::1' || /^(?:::ffff:)?127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(address ?? '')
}

function matchesState(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface CallbackServer {
  redirectUri: string
  close(): Promise<void>
}

export async function openCallbackServer(options: {
  port: number
  state: string
  onCode(code: string): void
  onDenied(): void
}): Promise<CallbackServer> {
  const servers: Server[] = []
  let consumed = false
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            server.closeAllConnections()
          }),
      ),
    ).then(() => undefined)
    return closing
  }
  const respond = (response: ServerResponse, status: number, text: string) => {
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'close',
    })
    response.end(text)
  }
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      respond(response, 403, 'Local sign-in callbacks only.')
      return
    }
    if (request.method !== 'GET') {
      respond(response, 405, 'Method not allowed.')
      return
    }
    if (!request.url || request.url.length > 8192) {
      respond(response, 400, 'Invalid sign-in callback.')
      return
    }
    let url: URL
    try {
      url = new URL(request.url, 'http://localhost')
    } catch {
      respond(response, 400, 'Invalid sign-in callback.')
      return
    }
    if (url.pathname !== CALLBACK_PATH) {
      respond(response, 404, 'Not found.')
      return
    }
    const states = url.searchParams.getAll('state')
    if (states.length !== 1 || !matchesState(states[0], options.state)) {
      respond(response, 400, 'Invalid sign-in callback.')
      return
    }
    if (consumed) {
      respond(response, 409, 'This sign-in callback was already received.')
      return
    }
    if (url.searchParams.has('error')) {
      consumed = true
      respond(response, 400, 'Sign-in was not completed. Return to GenOffice.')
      setImmediate(options.onDenied)
      return
    }
    const codes = url.searchParams.getAll('code')
    if (codes.length !== 1 || !codes[0].trim() || codes[0].length > 4096) {
      respond(response, 400, 'Invalid sign-in callback.')
      return
    }
    consumed = true
    respond(response, 200, 'Sign-in response received. Return to GenOffice.')
    setImmediate(() => options.onCode(codes[0]))
  }
  const listen = async (host: string, port: number): Promise<Server> => {
    const server = createServer(handle)
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen({ host, port, ipv6Only: host === '::1' }, () => {
        server.off('error', onError)
        resolve()
      })
    })
    return server
  }
  try {
    const primary = await listen('127.0.0.1', options.port)
    const port = (primary.address() as AddressInfo).port
    try {
      await listen('::1', port)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // An occupied IPv6 port must fail: localhost may route the callback there first.
      if (!['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(code ?? '')) throw error
    }
    return { redirectUri: `http://localhost:${port}${CALLBACK_PATH}`, close }
  } catch (error) {
    await close()
    throw error
  }
}
