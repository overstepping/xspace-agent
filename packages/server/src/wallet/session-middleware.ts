// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/agent)

import type { NextFunction, Request, Response } from 'express'

import {
  InvalidSessionError,
  SessionExpiredError,
  type WalletSessionManager,
} from './index'
import type { WalletSessionClaims } from './types'

declare global {
  namespace Express {
    interface Request {
      walletSession?: WalletSessionClaims
    }
  }
}

/**
 * Extract a session token from either:
 *   - `Authorization: Bearer <token>` (preferred)
 *   - `X-Wallet-Session: <token>` (fallback for clients that already use
 *     the Authorization header for an admin API key)
 */
export function extractSessionToken(req: Request): string | null {
  const auth = req.header('authorization') ?? req.header('Authorization')
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (m) return m[1].trim()
  }
  const direct = req.header('x-wallet-session') ?? req.header('X-Wallet-Session')
  return direct?.trim() ?? null
}

/** Strict — rejects when no valid session is present. */
export function requireWalletSession(sessions: WalletSessionManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = extractSessionToken(req)
    if (!token) {
      res.status(401).json({ error: 'wallet session required' })
      return
    }
    try {
      req.walletSession = sessions.verifyToken(token)
      next()
    } catch (err: unknown) {
      if (err instanceof SessionExpiredError) {
        res.status(401).json({ error: 'session expired' })
        return
      }
      if (err instanceof InvalidSessionError) {
        res.status(401).json({ error: 'invalid session' })
        return
      }
      res.status(401).json({ error: 'authentication failed' })
    }
  }
}

/** Loose — attaches `req.walletSession` if a valid token is present, never rejects. */
export function optionalWalletSession(sessions: WalletSessionManager) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractSessionToken(req)
    if (!token) return next()
    try {
      req.walletSession = sessions.verifyToken(token)
    } catch {
      // Silently ignore — the route handler decides what to do.
    }
    next()
  }
}
