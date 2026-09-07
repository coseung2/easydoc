export type EasyDocReceiverSettings = {
  relayBaseUrl: string
  receiveDir: string
  desktopAlias: string
  autoOpen: boolean
}

export type StoredDesktopPairing = {
  version: 1
  deviceId: string
  roomId: string
  publicKey: string
  desktopAlias: string
  mobileId?: string
}

export type PairingView = {
  qrPayload: string
  expiresAt: number
  roomId: string
}

export type PairingSummary = {
  roomId: string
  deviceId: string
  mobileId?: string
  authorized: boolean
  connected: boolean
  error?: string
}

export type ReceiverSnapshot = {
  settings: EasyDocReceiverSettings
  pairings: PairingSummary[]
}

export type FileReceivedEvent = {
  roomId: string
  path: string
  filename: string
  size: number
  mime: string
}

export type TransferProgressEvent = {
  roomId: string
  transferId: string
  filename: string
  receivedBytes: number
  totalBytes: number
}
