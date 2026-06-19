// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/agent)

// =============================================================================
// /api/wallet — prepaid agent-wallet endpoints.
//
//   GET  /api/wallet/info                Public — config (deposit min/max, networks)
//   GET  /api/wallet/nonce               Public — request a sign-in challenge
//   POST /api/wallet/session             Public — exchange a signed nonce for a session
//   GET  /api/wallet/me                  Auth   — current balance + recent tx
//   GET  /api/wallet/balance             Auth   — balance only
//   GET  /api/wallet/history             Auth   — transaction history
//   POST /api/wallet/deposit             Auth + x402 — credit the prepaid balance
//   POST /api/wallet/withdraw            Auth   — pay out to the user's wallet
// =============================================================================

import { Router } from 'express'
import { z } from 'zod'

import { getAppLogger } from 'xspace-agent'

import {
  loadX402ConfigFromEnv,
  x402Gate,
  type X402Network,
} from '../x402'
import {
  AgentWalletLedger,
  WalletSessionManager,
  InvalidSignatureError,
  NonceNotFoundError,
  loadTreasuriesFromEnv,
  type Treasury,
  type WalletNetworkKind,
} from '../wallet'
import { requireWalletSession } from '../wallet/session-middleware'

// ── Validation schemas ─────────────────────────────────────────────────────

const NonceQuerySchema = z.object({
  address: z.string().trim().min(1).max(100),
  kind: z.enum(['solana', 'evm']),
})

const SessionBodySchema = z.object({
  address: z.string().trim().min(1).max(100),
  kind: z.enum(['solana', 'evm']),
  nonce: z.string().trim().min(8).max(128),
  signature: z.string().trim().min(8).max(512),
})

const DepositQuerySchema = z.object({
  amountUsd: z.coerce.number().int().min(1).max(1000),
})

const WithdrawBodySchema = z.object({
  amountUsd: z.number().positive().max(10_000),
  destination: z.string().trim().min(1).max(100).optional(),
})

const HistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

// ── Config ─────────────────────────────────────────────────────────────────

export interface WalletConfig {
  /** Minimum single deposit in USD. Default $5. */
  minDepositUsd: number
  /** Maximum single deposit in USD. Default $100 (safety cap for the demo). */
  maxDepositUsd: number
  /** Allowed deposit amounts in USD. If unset, any value within min/max is allowed. */
  allowedDepositTiers?: number[]
}

export function loadWalletConfigFromEnv(): WalletConfig {
  const min = Number(process.env.WALLET_DEPOSIT_MIN_USD ?? '5')
  const max = Number(process.env.WALLET_DEPOSIT_MAX_USD ?? '100')
  const tiersRaw = process.env.WALLET_DEPOSIT_TIERS
  const tiers = tiersRaw
    ? tiersRaw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
    : [5, 10, 25, 50]
  return { minDepositUsd: min, maxDepositUsd: max, allowedDepositTiers: tiers }
}

const USDC_DECIMALS = 6n
function usdToMicros(usd: number): string {
  // Multiply through bigint to avoid float drift.
  const cents = BigInt(Math.round(usd * 100))
  return (cents * 10n ** (USDC_DECIMALS - 2n)).toString()
}

function microsToUsd(micros: string): number {
  return Number(BigInt(micros)) / 1_000_000
}

// ── Router factory ─────────────────────────────────────────────────────────

export interface WalletRouterDeps {
  ledger: AgentWalletLedger
  sessions: WalletSessionManager
  walletConfig: WalletConfig
  /** Pre-built treasuries (may be empty — withdrawals will then 503). */
  treasuries: Treasury[]
}

export function createWalletRouter(deps: WalletRouterDeps): Router {
  const router = Router()
  const log = getAppLogger('wallet-router')

  const x402Config = loadX402ConfigFromEnv()
  const treasuriesByNetwork = new Map<X402Network, Treasury>()
  for (const t of deps.treasuries) treasuriesByNetwork.set(t.network, t)

  // ── GET /api/wallet/info — Public config ────────────────────────────────

  router.get('/info', (_req, res) => {
    res.json({
      enabled: Boolean(x402Config),
      minDepositUsd: deps.walletConfig.minDepositUsd,
      maxDepositUsd: deps.walletConfig.maxDepositUsd,
      depositTiers: deps.walletConfig.allowedDepositTiers,
      networks: x402Config?.networks ?? [],
      withdrawalNetworks: Array.from(treasuriesByNetwork.keys()),
      currency: 'USDC',
    })
  })

  // ── GET /api/wallet/nonce ───────────────────────────────────────────────

  router.get('/nonce', (req, res) => {
    const parsed = NonceQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', issues: parsed.error.flatten() })
      return
    }
    const challenge = deps.sessions.createChallenge(parsed.data.address, parsed.data.kind)
    res.json({
      nonce: challenge.nonce,
      message: challenge.message,
      address: challenge.address,
      kind: challenge.kind,
      expiresAt: challenge.expiresAt,
    })
  })

  // ── POST /api/wallet/session ────────────────────────────────────────────

  router.post('/session', async (req, res) => {
    const parsed = SessionBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.flatten() })
      return
    }
    try {
      const { token, claims } = deps.sessions.signIn({
        address: parsed.data.address,
        kind: parsed.data.kind,
        nonce: parsed.data.nonce,
        signature: parsed.data.signature,
      })
      // Ensure a ledger row exists so the user can see a zero balance immediately.
      await deps.ledger.getOrCreate(claims.sub, claims.kind)
      res.json({
        token,
        expiresAt: claims.exp * 1000,
        address: claims.sub,
        kind: claims.kind,
      })
    } catch (err: unknown) {
      if (err instanceof NonceNotFoundError) {
        res.status(400).json({ error: 'nonce expired — request a new one' })
        return
      }
      if (err instanceof InvalidSignatureError) {
        res.status(401).json({ error: 'invalid signature' })
        return
      }
      throw err
    }
  })

  // ── Authenticated subroutes ─────────────────────────────────────────────

  const auth = requireWalletSession(deps.sessions)

  router.get('/me', auth, async (req, res) => {
    const session = req.walletSession!
    const entry = await deps.ledger.getOrCreate(session.sub, session.kind)
    res.json(shapeEntryForResponse(entry, 25))
  })

  router.get('/balance', auth, async (req, res) => {
    const session = req.walletSession!
    const entry = await deps.ledger.getOrCreate(session.sub, session.kind)
    res.json({
      address: entry.address,
      kind: entry.kind,
      balanceUsdcMicros: entry.balanceUsdcMicros,
      balanceUsd: microsToUsd(entry.balanceUsdcMicros),
    })
  })

  router.get('/history', auth, async (req, res) => {
    const session = req.walletSession!
    const parsed = HistoryQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', issues: parsed.error.flatten() })
      return
    }
    const limit = parsed.data.limit ?? 50
    const entry = await deps.ledger.getOrCreate(session.sub, session.kind)
    res.json({
      address: entry.address,
      kind: entry.kind,
      transactions: entry.transactions.slice(0, limit),
    })
  })

  // ── POST /api/wallet/deposit?amountUsd=5 ────────────────────────────────
  //
  // This route is double-gated:
  //   1. Wallet session — identifies whose balance to credit.
  //   2. x402            — collects USDC, returning 402 + requirements if absent.
  //
  // On successful settlement we credit the ledger, then echo the receipt.

  if (!x402Config) {
    router.post('/deposit', (_req, res) => {
      res.status(503).json({
        error: 'x402 not configured',
        hint: 'set SOLANA_RECIPIENT_ADDRESS + CDP_API_KEY_* and/or EVM_RECIPIENT_ADDRESS in .env',
      })
    })
  } else {
    const depositGate = x402Gate(x402Config, {
      resolveRequirements: (req) => {
        const q = DepositQuerySchema.safeParse(req.query)
        if (!q.success) {
          return { reject: { reason: 'amountUsd query param required (integer ≥1)' } }
        }
        const amount = q.data.amountUsd
        if (amount < deps.walletConfig.minDepositUsd) {
          return {
            reject: {
              reason: `minimum deposit is $${deps.walletConfig.minDepositUsd}`,
            },
          }
        }
        if (amount > deps.walletConfig.maxDepositUsd) {
          return {
            reject: {
              reason: `maximum deposit is $${deps.walletConfig.maxDepositUsd}`,
            },
          }
        }
        if (
          deps.walletConfig.allowedDepositTiers &&
          deps.walletConfig.allowedDepositTiers.length > 0 &&
          !deps.walletConfig.allowedDepositTiers.includes(amount)
        ) {
          return {
            reject: {
              reason: `amount must be one of: ${deps.walletConfig.allowedDepositTiers.join(', ')}`,
            },
          }
        }
        return { priceUsdc: usdToMicros(amount), description: `Top up agent wallet ($${amount})` }
      },
    })

    router.post('/deposit', auth, depositGate, async (req, res) => {
      const session = req.walletSession!
      const payment = req.x402!
      const amountUsdcMicros = payment.amount

      try {
        const entry = await deps.ledger.credit({
          address: session.sub,
          kind: session.kind,
          amountUsdcMicros,
          network: payment.network,
          txHash: payment.txHash,
        })
        log.info(
          {
            address: session.sub,
            amountUsdcMicros,
            txHash: payment.txHash,
            network: payment.network,
          },
          'deposit credited',
        )
        res.status(200).json({
          ok: true,
          credited: amountUsdcMicros,
          creditedUsd: microsToUsd(amountUsdcMicros),
          balance: shapeBalance(entry),
          tx: {
            network: payment.network,
            txHash: payment.txHash,
            asset: payment.asset,
            payer: payment.payer,
          },
        })
      } catch (err: any) {
        // The x402 settlement already succeeded on-chain; if our ledger write
        // fails we want to be loud about it so an operator can manually
        // reconcile.
        log.error(
          {
            err: err.message,
            address: session.sub,
            txHash: payment.txHash,
          },
          'ledger credit FAILED after x402 settlement — manual reconciliation needed',
        )
        res.status(500).json({
          error: 'ledger update failed after settlement',
          hint: 'contact support with the txHash for manual reconciliation',
          tx: { network: payment.network, txHash: payment.txHash },
        })
      }
    })
  }

  // ── POST /api/wallet/withdraw ───────────────────────────────────────────

  router.post('/withdraw', auth, async (req, res) => {
    const session = req.walletSession!
    const parsed = WithdrawBodySchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.flatten() })
      return
    }
    const network = pickWithdrawalNetwork(session.kind, treasuriesByNetwork)
    if (!network) {
      res.status(503).json({
        error: 'withdrawals not configured for your wallet network',
        hint:
          session.kind === 'solana'
            ? 'set TREASURY_SOLANA_SECRET_KEY in server env'
            : 'set TREASURY_EVM_PRIVATE_KEY in server env',
      })
      return
    }
    const treasury = treasuriesByNetwork.get(network)!
    const destination = parsed.data.destination ?? session.sub
    if (!validDestination(destination, session.kind)) {
      res.status(400).json({ error: 'destination not valid for this wallet kind' })
      return
    }
    const amountMicros = usdToMicros(parsed.data.amountUsd)

    // Reserve funds first — debits the ledger and creates a pending withdraw row.
    let reservation: { txId: string }
    try {
      const result = await deps.ledger.reserveWithdraw({
        address: session.sub,
        kind: session.kind,
        amountUsdcMicros: amountMicros,
        network,
      })
      reservation = { txId: result.txId }
    } catch (err: any) {
      if (err?.code === 'INSUFFICIENT_BALANCE') {
        res.status(400).json({ error: 'insufficient balance' })
        return
      }
      throw err
    }

    // Attempt the on-chain transfer.
    try {
      const sent = await treasury.sendUsdc(destination, amountMicros)
      const entry = await deps.ledger.confirmWithdraw({
        address: session.sub,
        kind: session.kind,
        txId: reservation.txId,
        txHash: sent.txHash,
      })
      log.info(
        {
          address: session.sub,
          amountMicros,
          destination,
          txHash: sent.txHash,
          network,
        },
        'withdraw confirmed',
      )
      res.json({
        ok: true,
        withdrawn: amountMicros,
        withdrawnUsd: microsToUsd(amountMicros),
        destination,
        network,
        txHash: sent.txHash,
        balance: shapeBalance(entry),
      })
    } catch (err: any) {
      log.error(
        { err: err.message, address: session.sub, txId: reservation.txId },
        'withdraw failed — refunding balance',
      )
      await deps.ledger.failWithdraw({
        address: session.sub,
        kind: session.kind,
        txId: reservation.txId,
        amountUsdcMicros: amountMicros,
        note: err.message ?? 'unknown',
      })
      res.status(502).json({
        error: 'withdrawal failed; balance refunded',
        detail: err.message ?? 'unknown',
      })
    }
  })

  return router
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shapeEntryForResponse(
  entry: { transactions: any[]; balanceUsdcMicros: string } & Record<string, any>,
  txLimit: number,
): Record<string, unknown> {
  return {
    address: entry.address,
    kind: entry.kind,
    balanceUsdcMicros: entry.balanceUsdcMicros,
    balanceUsd: microsToUsd(entry.balanceUsdcMicros),
    totals: {
      depositedUsdcMicros: entry.totalDepositedUsdcMicros,
      spentUsdcMicros: entry.totalSpentUsdcMicros,
      withdrawnUsdcMicros: entry.totalWithdrawnUsdcMicros,
    },
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    transactions: entry.transactions.slice(0, txLimit),
  }
}

function shapeBalance(entry: { balanceUsdcMicros: string }): {
  usdcMicros: string
  usd: number
} {
  return {
    usdcMicros: entry.balanceUsdcMicros,
    usd: microsToUsd(entry.balanceUsdcMicros),
  }
}

function pickWithdrawalNetwork(
  kind: WalletNetworkKind,
  treasuries: Map<X402Network, Treasury>,
): X402Network | null {
  const candidates: X402Network[] =
    kind === 'solana'
      ? ['solana', 'solana-devnet']
      : ['base', 'arbitrum', 'ethereum', 'base-sepolia']
  for (const n of candidates) {
    if (treasuries.has(n)) return n
  }
  return null
}

function validDestination(dest: string, kind: WalletNetworkKind): boolean {
  if (kind === 'evm') {
    return /^0x[a-fA-F0-9]{40}$/.test(dest)
  }
  // Solana addresses: base58, 32–44 chars typically.
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(dest)
}
