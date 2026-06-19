// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// File-backed agent wallet ledger.
//
// Each user's prepaid balance lives in `<DATA_DIR>/agent-wallets/<address>.json`.
// All mutations go through `update()` which:
//   - serializes per-address mutations (in-process async mutex) so concurrent
//     /ask calls can't double-spend the same balance
//   - writes atomically via temp-file + rename
//   - keeps an in-memory cache to avoid re-reading on every request
//
// Persistence is intentionally file-based (no DB), matching the project's
// "no database deps" rule. The trade-off is that this design assumes a single
// server process per file path — for multi-instance deploys, swap the store
// for Redis or Postgres without changing the surface.
// =============================================================================

import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'

import { getAppLogger } from 'xspace-agent'

import type { X402Network } from '../x402/types'
import type {
  AgentWalletEntry,
  WalletNetworkKind,
  WalletTransaction,
  WalletTransactionType,
} from './types'

const log = getAppLogger('wallet-ledger')

export interface LedgerConfig {
  /** Absolute path to the ledger root (defaults to <cwd>/data/agent-wallets). */
  dataDir?: string
  /** How many transactions to keep in the per-user log (older are dropped). */
  maxHistory?: number
}

export class InsufficientBalanceError extends Error {
  readonly code = 'INSUFFICIENT_BALANCE' as const
  constructor(
    readonly required: string,
    readonly available: string,
  ) {
    super(`insufficient balance: need ${required} micros, have ${available}`)
  }
}

/** Compare two USDC base-unit strings without precision loss. */
function geMicros(a: string, b: string): boolean {
  return BigInt(a) >= BigInt(b)
}

function addMicros(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString()
}

function subMicros(a: string, b: string): string {
  return (BigInt(a) - BigInt(b)).toString()
}

export function normalizeAddress(address: string, kind: WalletNetworkKind): string {
  if (kind === 'evm') return address.toLowerCase()
  // Solana addresses are case-sensitive base58 — leave as-is.
  return address
}

export class AgentWalletLedger {
  private readonly dataDir: string
  private readonly maxHistory: number
  private readonly cache = new Map<string, AgentWalletEntry>()
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(config: LedgerConfig = {}) {
    this.dataDir = config.dataDir ?? path.resolve(process.cwd(), 'data', 'agent-wallets')
    this.maxHistory = config.maxHistory ?? 100
  }

  /** Ensure the data directory exists. Idempotent. Call once at startup. */
  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
  }

  // ── Public read ─────────────────────────────────────────────────────────

  async get(address: string, kind: WalletNetworkKind): Promise<AgentWalletEntry | null> {
    const norm = normalizeAddress(address, kind)
    const cached = this.cache.get(norm)
    if (cached) return cached

    const file = this.fileFor(norm)
    try {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as AgentWalletEntry
      this.cache.set(norm, parsed)
      return parsed
    } catch (err: any) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  async getOrCreate(address: string, kind: WalletNetworkKind): Promise<AgentWalletEntry> {
    const existing = await this.get(address, kind)
    if (existing) return existing
    return this.update(address, kind, (entry) => entry)
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  /**
   * Credit a deposit. Idempotent against `txHash` — if a deposit with the same
   * tx hash has already been recorded, this is a no-op and returns the existing
   * entry. This protects against duplicate facilitator callbacks.
   */
  async credit(args: {
    address: string
    kind: WalletNetworkKind
    amountUsdcMicros: string
    network: X402Network
    txHash: string
  }): Promise<AgentWalletEntry> {
    return this.update(args.address, args.kind, (entry) => {
      const already = entry.transactions.find(
        (t) => t.type === 'deposit' && t.txHash && t.txHash === args.txHash,
      )
      if (already) {
        log.info(
          { txHash: args.txHash, address: args.address },
          'duplicate deposit ignored',
        )
        return entry
      }
      entry.balanceUsdcMicros = addMicros(entry.balanceUsdcMicros, args.amountUsdcMicros)
      entry.totalDepositedUsdcMicros = addMicros(
        entry.totalDepositedUsdcMicros,
        args.amountUsdcMicros,
      )
      pushTx(entry, this.maxHistory, {
        type: 'deposit',
        amountUsdcMicros: args.amountUsdcMicros,
        balanceAfterUsdcMicros: entry.balanceUsdcMicros,
        network: args.network,
        txHash: args.txHash,
      })
      return entry
    })
  }

  /**
   * Debit the user's balance for a single question. Throws
   * `InsufficientBalanceError` if the balance is too low. The questionId is
   * used to correlate refunds.
   */
  async spend(args: {
    address: string
    kind: WalletNetworkKind
    amountUsdcMicros: string
    questionId: string
  }): Promise<AgentWalletEntry> {
    return this.update(args.address, args.kind, (entry) => {
      if (!geMicros(entry.balanceUsdcMicros, args.amountUsdcMicros)) {
        throw new InsufficientBalanceError(args.amountUsdcMicros, entry.balanceUsdcMicros)
      }
      entry.balanceUsdcMicros = subMicros(entry.balanceUsdcMicros, args.amountUsdcMicros)
      entry.totalSpentUsdcMicros = addMicros(
        entry.totalSpentUsdcMicros,
        args.amountUsdcMicros,
      )
      pushTx(entry, this.maxHistory, {
        type: 'spend',
        amountUsdcMicros: args.amountUsdcMicros,
        balanceAfterUsdcMicros: entry.balanceUsdcMicros,
        questionId: args.questionId,
      })
      return entry
    })
  }

  /**
   * Refund a previously charged question. Idempotent against `questionId` —
   * if a refund for this question is already recorded, no-op. This is critical
   * because answer-failure handlers may fire more than once.
   */
  async refund(args: {
    address: string
    kind: WalletNetworkKind
    amountUsdcMicros: string
    questionId: string
    note?: string
  }): Promise<AgentWalletEntry> {
    return this.update(args.address, args.kind, (entry) => {
      const already = entry.transactions.find(
        (t) => t.type === 'refund' && t.questionId === args.questionId,
      )
      if (already) {
        log.info({ questionId: args.questionId }, 'duplicate refund ignored')
        return entry
      }
      entry.balanceUsdcMicros = addMicros(entry.balanceUsdcMicros, args.amountUsdcMicros)
      // Reduce totalSpent so analytics reflect the net.
      entry.totalSpentUsdcMicros = subMicros(
        entry.totalSpentUsdcMicros,
        args.amountUsdcMicros,
      )
      pushTx(entry, this.maxHistory, {
        type: 'refund',
        amountUsdcMicros: args.amountUsdcMicros,
        balanceAfterUsdcMicros: entry.balanceUsdcMicros,
        questionId: args.questionId,
        note: args.note,
      })
      return entry
    })
  }

  /**
   * Reserve a withdrawal: debits balance and records a pending withdraw tx
   * (with no txHash yet). Returns the txId so the caller can attach the
   * settlement hash via `confirmWithdraw()` once the on-chain transfer lands.
   * If the on-chain send fails, call `failWithdraw()` to credit it back.
   */
  async reserveWithdraw(args: {
    address: string
    kind: WalletNetworkKind
    amountUsdcMicros: string
    network: X402Network
    note?: string
  }): Promise<{ entry: AgentWalletEntry; txId: string }> {
    let txId = ''
    const entry = await this.update(args.address, args.kind, (e) => {
      if (!geMicros(e.balanceUsdcMicros, args.amountUsdcMicros)) {
        throw new InsufficientBalanceError(args.amountUsdcMicros, e.balanceUsdcMicros)
      }
      e.balanceUsdcMicros = subMicros(e.balanceUsdcMicros, args.amountUsdcMicros)
      e.totalWithdrawnUsdcMicros = addMicros(
        e.totalWithdrawnUsdcMicros,
        args.amountUsdcMicros,
      )
      const tx = pushTx(e, this.maxHistory, {
        type: 'withdraw',
        amountUsdcMicros: args.amountUsdcMicros,
        balanceAfterUsdcMicros: e.balanceUsdcMicros,
        network: args.network,
        note: args.note,
      })
      txId = tx.id
      return e
    })
    return { entry, txId }
  }

  async confirmWithdraw(args: {
    address: string
    kind: WalletNetworkKind
    txId: string
    txHash: string
  }): Promise<AgentWalletEntry> {
    return this.update(args.address, args.kind, (entry) => {
      const tx = entry.transactions.find((t) => t.id === args.txId)
      if (tx) tx.txHash = args.txHash
      return entry
    })
  }

  async failWithdraw(args: {
    address: string
    kind: WalletNetworkKind
    txId: string
    amountUsdcMicros: string
    note: string
  }): Promise<AgentWalletEntry> {
    return this.update(args.address, args.kind, (entry) => {
      // Drop the pending withdraw row and credit the funds back.
      entry.transactions = entry.transactions.filter((t) => t.id !== args.txId)
      entry.balanceUsdcMicros = addMicros(entry.balanceUsdcMicros, args.amountUsdcMicros)
      entry.totalWithdrawnUsdcMicros = subMicros(
        entry.totalWithdrawnUsdcMicros,
        args.amountUsdcMicros,
      )
      pushTx(entry, this.maxHistory, {
        type: 'refund',
        amountUsdcMicros: args.amountUsdcMicros,
        balanceAfterUsdcMicros: entry.balanceUsdcMicros,
        note: `withdraw failed: ${args.note}`,
      })
      return entry
    })
  }

  // ── Internal ────────────────────────────────────────────────────────────

  /**
   * Serialize a mutation against the address. The mutator runs inside a
   * per-key mutex; the result is persisted atomically (temp file + rename)
   * and cached in memory.
   */
  private async update(
    address: string,
    kind: WalletNetworkKind,
    mutator: (entry: AgentWalletEntry) => AgentWalletEntry,
  ): Promise<AgentWalletEntry> {
    const norm = normalizeAddress(address, kind)
    const previous = this.locks.get(norm) ?? Promise.resolve()
    const run = previous.then(async () => {
      const current = (await this.get(address, kind)) ?? freshEntry(norm, kind)
      // Deep clone to avoid mutators leaking pre-write state into the cache.
      const draft = JSON.parse(JSON.stringify(current)) as AgentWalletEntry
      const next = mutator(draft)
      next.updatedAt = new Date().toISOString()
      await this.persist(next)
      this.cache.set(norm, next)
      return next
    })
    this.locks.set(
      norm,
      run.catch(() => undefined),
    )
    return run
  }

  private fileFor(address: string): string {
    // Address is already normalized for the cache key; sanitize for filename safety.
    const safe = address.replace(/[^a-zA-Z0-9]/g, '_')
    return path.join(this.dataDir, `${safe}.json`)
  }

  private async persist(entry: AgentWalletEntry): Promise<void> {
    const target = this.fileFor(entry.address)
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    const json = JSON.stringify(entry, null, 2)
    await fs.writeFile(tmp, json, { mode: 0o600 })
    await fs.rename(tmp, target)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function freshEntry(address: string, kind: WalletNetworkKind): AgentWalletEntry {
  const now = new Date().toISOString()
  return {
    address,
    kind,
    balanceUsdcMicros: '0',
    totalDepositedUsdcMicros: '0',
    totalSpentUsdcMicros: '0',
    totalWithdrawnUsdcMicros: '0',
    createdAt: now,
    updatedAt: now,
    transactions: [],
  }
}

function pushTx(
  entry: AgentWalletEntry,
  maxHistory: number,
  tx: Omit<WalletTransaction, 'id' | 'at'> & { type: WalletTransactionType },
): WalletTransaction {
  const full: WalletTransaction = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ...tx,
  }
  entry.transactions.unshift(full)
  if (entry.transactions.length > maxHistory) {
    entry.transactions.length = maxHistory
  }
  return full
}
