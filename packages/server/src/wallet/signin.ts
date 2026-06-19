// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/agent)

// =============================================================================
// Sign-in-with-wallet flow.
//
// 1. Client calls GET  /api/wallet/nonce?address=...&kind=...
//    Server returns { nonce, message, expiresAt }. The message is a
//    human-readable string the user signs in their wallet:
//
//      xspace-agent: sign in
//      address: <addr>
//      nonce: <hex>
//      issued: <iso>
//
// 2. Client signs `message` with the wallet:
//      - Solana (Phantom): signMessage(utf8Bytes(message)) → 64-byte sig
//      - EVM   (MetaMask): personal_sign(message)          → 0x... hex
//
// 3. Client calls POST /api/wallet/session { address, kind, signature, nonce }.
//    Server verifies the signature against the nonce, mints a session token
//    (HMAC-SHA256, no JWT lib needed), and returns it.
//
// Nonces are single-use and stored in-memory with a TTL. For multi-instance
// deploys, swap the nonce store for Redis without changing the surface.
// =============================================================================

import { createHmac, randomBytes, timingSafeEqual } from 'crypto'

import { ed25519 } from '@noble/curves/ed25519'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import bs58 from 'bs58'

import type { NonceChallenge, WalletNetworkKind, WalletSessionClaims } from './types'
import { normalizeAddress } from './ledger'

const NONCE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60 // 7 days

export class InvalidSignatureError extends Error {
  readonly code = 'INVALID_SIGNATURE' as const
}

export class NonceNotFoundError extends Error {
  readonly code = 'NONCE_NOT_FOUND' as const
}

export class SessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED' as const
}

export class InvalidSessionError extends Error {
  readonly code = 'INVALID_SESSION' as const
}

export interface SessionManagerConfig {
  /** HMAC secret for session tokens — required, must be 32+ chars in prod. */
  secret: string
  /** Override TTL (seconds). Defaults to 7 days. */
  sessionTtlSeconds?: number
  /** Override nonce TTL (ms). Defaults to 5 min. */
  nonceTtlMs?: number
}

export class WalletSessionManager {
  private readonly secret: Buffer
  private readonly sessionTtl: number
  private readonly nonceTtl: number
  private readonly nonces = new Map<string, NonceChallenge>()
  private gcTimer: NodeJS.Timeout | null = null

  constructor(config: SessionManagerConfig) {
    if (!config.secret || config.secret.length < 16) {
      throw new Error('WalletSessionManager: secret must be at least 16 characters')
    }
    this.secret = Buffer.from(config.secret, 'utf8')
    this.sessionTtl = config.sessionTtlSeconds ?? SESSION_TTL_SECONDS
    this.nonceTtl = config.nonceTtlMs ?? NONCE_TTL_MS
  }

  /** Start a background sweep for expired nonces. Idempotent. */
  start(): void {
    if (this.gcTimer) return
    this.gcTimer = setInterval(() => this.gcNonces(), 60_000)
    if (typeof this.gcTimer.unref === 'function') this.gcTimer.unref()
  }

  stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer)
    this.gcTimer = null
  }

  // ── Nonce issuance ──────────────────────────────────────────────────────

  createChallenge(address: string, kind: WalletNetworkKind): NonceChallenge {
    const norm = normalizeAddress(address, kind)
    const nonce = randomBytes(16).toString('hex')
    const issued = new Date().toISOString()
    const message =
      `xspace-agent: sign in\n` +
      `address: ${norm}\n` +
      `nonce: ${nonce}\n` +
      `issued: ${issued}`
    const challenge: NonceChallenge = {
      nonce,
      address: norm,
      kind,
      message,
      expiresAt: Date.now() + this.nonceTtl,
    }
    this.nonces.set(this.nonceKey(norm, nonce), challenge)
    return challenge
  }

  // ── Sign-in (verify + mint session) ─────────────────────────────────────

  /**
   * Verifies the signature against the previously-issued nonce and returns a
   * fresh session token. The nonce is consumed (single-use) regardless of
   * outcome — a failed attempt forces the client to request a new one.
   */
  signIn(args: {
    address: string
    kind: WalletNetworkKind
    nonce: string
    signature: string
  }): { token: string; claims: WalletSessionClaims } {
    const norm = normalizeAddress(args.address, args.kind)
    const key = this.nonceKey(norm, args.nonce)
    const challenge = this.nonces.get(key)

    // Single-use — burn the nonce eagerly.
    this.nonces.delete(key)

    if (!challenge) throw new NonceNotFoundError('nonce not found or expired')
    if (challenge.expiresAt < Date.now()) throw new NonceNotFoundError('nonce expired')

    const ok =
      args.kind === 'solana'
        ? verifySolana(challenge.message, args.signature, norm)
        : verifyEvm(challenge.message, args.signature, norm)
    if (!ok) throw new InvalidSignatureError('signature does not match address')

    return this.mintSession(norm, args.kind)
  }

  /** Mint a session for an address without requiring a fresh signature.
   * Useful in tests; production callers should always go through `signIn()`. */
  mintSession(address: string, kind: WalletNetworkKind): {
    token: string
    claims: WalletSessionClaims
  } {
    const norm = normalizeAddress(address, kind)
    const now = Math.floor(Date.now() / 1000)
    const claims: WalletSessionClaims = {
      sub: norm,
      kind,
      iat: now,
      exp: now + this.sessionTtl,
    }
    const token = this.encodeToken(claims)
    return { token, claims }
  }

  // ── Verification ────────────────────────────────────────────────────────

  /** Decode + verify a session token. Throws on tampering or expiry. */
  verifyToken(token: string): WalletSessionClaims {
    const parts = token.split('.')
    if (parts.length !== 2) throw new InvalidSessionError('malformed token')
    const [body, mac] = parts
    const expectedMac = this.macFor(body)
    const got = b64urlToBuf(mac)
    if (got.length !== expectedMac.length || !timingSafeEqual(got, expectedMac)) {
      throw new InvalidSessionError('bad token signature')
    }
    let claims: WalletSessionClaims
    try {
      claims = JSON.parse(b64urlToBuf(body).toString('utf8')) as WalletSessionClaims
    } catch {
      throw new InvalidSessionError('bad token payload')
    }
    if (!claims.sub || !claims.kind || !claims.exp) {
      throw new InvalidSessionError('missing claims')
    }
    if (claims.exp * 1000 < Date.now()) {
      throw new SessionExpiredError('session expired')
    }
    return claims
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private encodeToken(claims: WalletSessionClaims): string {
    const body = bufToB64url(Buffer.from(JSON.stringify(claims), 'utf8'))
    const mac = this.macFor(body)
    return `${body}.${bufToB64url(mac)}`
  }

  private macFor(body: string): Buffer {
    return createHmac('sha256', this.secret).update(body).digest()
  }

  private nonceKey(address: string, nonce: string): string {
    return `${address}:${nonce}`
  }

  private gcNonces(): void {
    const now = Date.now()
    for (const [k, v] of this.nonces) {
      if (v.expiresAt < now) this.nonces.delete(k)
    }
  }
}

// =============================================================================
// Signature verification
// =============================================================================

/**
 * Solana: signature is 64 bytes (base58), public key is the address (base58).
 * The signed payload is the raw UTF-8 bytes of the message.
 */
export function verifySolana(message: string, signature: string, address: string): boolean {
  try {
    const sigBytes = bs58.decode(signature)
    const pubKey = bs58.decode(address)
    if (sigBytes.length !== 64 || pubKey.length !== 32) return false
    const msgBytes = new TextEncoder().encode(message)
    return ed25519.verify(sigBytes, msgBytes, pubKey)
  } catch {
    return false
  }
}

/**
 * EVM `personal_sign` verification.
 *
 *   prefixed = "\x19Ethereum Signed Message:\n" + len(message) + message
 *   digest   = keccak256(prefixed)
 *   signer   = ecrecover(digest, r || s || v)
 *
 * Signature is 65 bytes: r (32) || s (32) || v (1).
 */
export function verifyEvm(message: string, signature: string, address: string): boolean {
  try {
    const hex = signature.startsWith('0x') ? signature.slice(2) : signature
    if (hex.length !== 130) return false
    const sigBytes = hexToBytes(hex)
    const r = sigBytes.slice(0, 32)
    const s = sigBytes.slice(32, 64)
    let v = sigBytes[64]
    // EIP-155 historically used 27/28; some wallets emit 0/1.
    if (v >= 27) v -= 27
    if (v !== 0 && v !== 1) return false

    const msgBytes = new TextEncoder().encode(message)
    const prefix = new TextEncoder().encode(
      `\x19Ethereum Signed Message:\n${msgBytes.length}`,
    )
    const preimage = new Uint8Array(prefix.length + msgBytes.length)
    preimage.set(prefix, 0)
    preimage.set(msgBytes, prefix.length)
    const digest = keccak_256(preimage)

    const sig = new secp256k1.Signature(bytesToBigInt(r), bytesToBigInt(s)).addRecoveryBit(v)
    const recovered = sig.recoverPublicKey(digest).toRawBytes(false) // 65 bytes, leading 0x04
    const pubXY = recovered.slice(1)
    const addressBytes = keccak_256(pubXY).slice(-20)
    const recoveredAddress = '0x' + bytesToHex(addressBytes)
    return recoveredAddress.toLowerCase() === address.toLowerCase()
  } catch {
    return false
  }
}

// ── Encoding helpers ──────────────────────────────────────────────────────

function bufToB64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function b64urlToBuf(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  return Buffer.from(padded, 'base64')
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n
  for (const x of b) v = (v << 8n) | BigInt(x)
  return v
}
