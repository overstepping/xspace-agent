// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

import type { X402Network } from '../x402/types'

export type WalletNetworkKind = 'solana' | 'evm'

/**
 * USDC amounts are stored as base-unit strings (USDC has 6 decimals, so
 * `"5000000"` === $5.00). We never use `number` or `bigint` JSON-serialized,
 * because the ledger is persisted as JSON and bigints don't round-trip.
 */
export interface AgentWalletEntry {
  /** Lower-case EVM address or base58 Solana address — the user's external wallet. */
  address: string
  /** Which signature scheme owns this balance. */
  kind: WalletNetworkKind
  /** Current spendable balance, USDC base units (string). */
  balanceUsdcMicros: string
  /** Lifetime totals. Useful for receipts and analytics, never decreases. */
  totalDepositedUsdcMicros: string
  totalSpentUsdcMicros: string
  totalWithdrawnUsdcMicros: string
  createdAt: string
  updatedAt: string
  transactions: WalletTransaction[]
}

export type WalletTransactionType = 'deposit' | 'spend' | 'refund' | 'withdraw'

export interface WalletTransaction {
  id: string
  type: WalletTransactionType
  /** Always positive — the type determines whether it credits or debits. */
  amountUsdcMicros: string
  /** Balance after applying this transaction (for audit). */
  balanceAfterUsdcMicros: string
  /** Network where the underlying on-chain settlement happened (deposit/withdraw). */
  network?: X402Network
  /** Settlement tx hash for deposits and withdrawals. */
  txHash?: string
  /** For spend/refund: the questionId that consumed credit. */
  questionId?: string
  /** Free-text reason — useful for refunds. */
  note?: string
  at: string
}

export interface NonceChallenge {
  nonce: string
  address: string
  kind: WalletNetworkKind
  message: string
  /** Unix ms — challenges expire after a short window. */
  expiresAt: number
}

export interface WalletSessionClaims {
  /** Lower-case EVM address or base58 Solana address. */
  sub: string
  kind: WalletNetworkKind
  /** Issued-at, unix seconds. */
  iat: number
  /** Expires-at, unix seconds. */
  exp: number
}
