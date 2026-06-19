// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/xspace-agent)

// =============================================================================
// Treasury — server-controlled hot wallet that pays out withdrawals.
//
// The same address is used for inbound x402 settlement (SOLANA_RECIPIENT_ADDRESS
// / EVM_RECIPIENT_ADDRESS). Withdrawals are atomic from the ledger's view: we
// reserve the funds first, then attempt the on-chain transfer, and roll back
// (refund the ledger) if the transfer fails or never confirms.
//
// Two implementations:
//   - SolanaTreasury: builds + signs an SPL USDC transfer with @solana/web3.js
//   - EvmTreasury:    crafts and signs an ERC-20 USDC.transfer via raw secp256k1
//                     + RLP, then broadcasts through any JSON-RPC endpoint.
//
// Both are loaded lazily from env vars and surface a uniform `Treasury` shape.
// =============================================================================

import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import bs58 from 'bs58'

import { getAppLogger } from 'xspace-agent'

import type { X402Network } from '../x402/types'

const log = getAppLogger('treasury')

export interface WithdrawResult {
  txHash: string
  /** Network-specific identifier (chainId for EVM, cluster for Solana). */
  networkId?: string
}

export interface Treasury {
  readonly network: X402Network
  /** Public address that funds withdrawals. */
  readonly address: string
  /**
   * Send `amountUsdcMicros` (USDC base units) from the treasury to `destination`.
   * Returns the settlement tx hash. Throws on any failure — callers should
   * treat that as a signal to refund the ledger.
   */
  sendUsdc(destination: string, amountUsdcMicros: string): Promise<WithdrawResult>
}

// =============================================================================
// Solana
// =============================================================================

interface SolanaTreasuryConfig {
  /** Base58-encoded secret key (64 bytes) from `solana-keygen new`. */
  secretKeyBase58: string
  /** Solana RPC URL. Defaults to mainnet-beta. */
  rpcUrl?: string
  /** USDC mint address. Defaults to mainnet USDC. */
  usdcMint?: string
  network?: X402Network
}

export class SolanaTreasury implements Treasury {
  readonly network: X402Network
  readonly address: string

  // Lazy-loaded — @solana/web3.js is only imported when we need to actually
  // build a transaction, keeping the cold-start cost low.
  private web3!: typeof import('@solana/web3.js')
  private splToken!: typeof import('@solana/spl-token')
  private keypair: import('@solana/web3.js').Keypair | null = null
  private connection: import('@solana/web3.js').Connection | null = null

  constructor(private readonly config: SolanaTreasuryConfig) {
    this.network = config.network ?? 'solana'
    const secret = bs58.decode(config.secretKeyBase58)
    if (secret.length !== 64) {
      throw new Error('SolanaTreasury: secret key must be 64 bytes (base58)')
    }
    // Address derivation without importing @solana/web3.js: last 32 bytes are the public key.
    this.address = bs58.encode(secret.slice(32))
  }

  async sendUsdc(destination: string, amountUsdcMicros: string): Promise<WithdrawResult> {
    await this.ensureLoaded()
    const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } = this.web3
    const {
      createAssociatedTokenAccountInstruction,
      createTransferCheckedInstruction,
      getAssociatedTokenAddress,
      TOKEN_PROGRAM_ID,
    } = this.splToken

    const connection =
      this.connection ??
      new Connection(this.config.rpcUrl ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
    this.connection = connection

    const keypair =
      this.keypair ?? Keypair.fromSecretKey(bs58.decode(this.config.secretKeyBase58))
    this.keypair = keypair

    const mint = new PublicKey(this.config.usdcMint ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
    const recipient = new PublicKey(destination)
    const payer = keypair.publicKey
    const amount = BigInt(amountUsdcMicros)

    const fromAta = await getAssociatedTokenAddress(mint, payer)
    const toAta = await getAssociatedTokenAddress(mint, recipient)

    const tx = new Transaction()
    const toInfo = await connection.getAccountInfo(toAta)
    if (!toInfo) {
      tx.add(createAssociatedTokenAccountInstruction(payer, toAta, recipient, mint))
    }
    tx.add(
      createTransferCheckedInstruction(
        fromAta,
        mint,
        toAta,
        payer,
        amount,
        6,
        [],
        TOKEN_PROGRAM_ID,
      ),
    )

    log.info(
      { from: this.address, to: destination, amountUsdcMicros },
      'sending USDC (solana)',
    )
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: 'confirmed',
    })
    return { txHash: sig, networkId: 'solana' }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.web3) this.web3 = await import('@solana/web3.js')
    if (!this.splToken) this.splToken = await import('@solana/spl-token')
  }
}

// =============================================================================
// EVM — minimal ERC-20 USDC transfer (no ethers/viem dependency)
// =============================================================================

interface EvmTreasuryConfig {
  /** Hex-encoded 32-byte private key (with or without 0x prefix). */
  privateKey: string
  /** JSON-RPC endpoint of the EVM network. */
  rpcUrl: string
  /** USDC contract address (network-specific). */
  usdcAddress: string
  /** Numeric chain id (e.g. 8453 for Base). */
  chainId: number
  network: X402Network
}

export class EvmTreasury implements Treasury {
  readonly network: X402Network
  readonly address: string
  private readonly privateKey: Uint8Array

  constructor(private readonly config: EvmTreasuryConfig) {
    this.network = config.network
    this.privateKey = hexToBytes(strip0x(config.privateKey))
    if (this.privateKey.length !== 32) {
      throw new Error('EvmTreasury: private key must be 32 bytes (hex)')
    }
    const pub = secp256k1.getPublicKey(this.privateKey, false) // 65 bytes, leading 0x04
    const addressBytes = keccak_256(pub.slice(1)).slice(-20)
    this.address = '0x' + bytesToHex(addressBytes)
  }

  async sendUsdc(destination: string, amountUsdcMicros: string): Promise<WithdrawResult> {
    if (!destination.startsWith('0x') || destination.length !== 42) {
      throw new Error('EvmTreasury: destination must be a 0x-prefixed 20-byte address')
    }
    const amount = BigInt(amountUsdcMicros)
    const data = encodeErc20Transfer(destination, amount)

    const nonce = await this.rpc<string>('eth_getTransactionCount', [
      this.address,
      'pending',
    ])
    const gasPriceHex = await this.rpc<string>('eth_gasPrice', [])
    const gasPrice = BigInt(gasPriceHex)
    const estGas = await this.rpc<string>('eth_estimateGas', [
      { from: this.address, to: this.config.usdcAddress, data, value: '0x0' },
    ])
    // Add a 20% headroom on gas to absorb minor block-to-block variance.
    const gas = (BigInt(estGas) * 120n) / 100n

    const tx: LegacyTx = {
      nonce: BigInt(nonce),
      gasPrice,
      gasLimit: gas,
      to: hexToBytes(strip0x(this.config.usdcAddress)),
      value: 0n,
      data: hexToBytes(strip0x(data)),
      chainId: BigInt(this.config.chainId),
    }

    const raw = signEip155LegacyTx(tx, this.privateKey)
    log.info(
      {
        from: this.address,
        to: destination,
        amountUsdcMicros,
        chainId: this.config.chainId,
      },
      'sending USDC (evm)',
    )
    const txHash = await this.rpc<string>('eth_sendRawTransaction', ['0x' + bytesToHex(raw)])
    return { txHash, networkId: String(this.config.chainId) }
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!res.ok) {
      throw new Error(`evm rpc ${method} ${res.status}: ${await res.text().catch(() => '')}`)
    }
    const json = (await res.json()) as { result?: T; error?: { message: string } }
    if (json.error) throw new Error(`evm rpc ${method}: ${json.error.message}`)
    if (json.result === undefined) throw new Error(`evm rpc ${method}: empty result`)
    return json.result
  }
}

// =============================================================================
// EVM transaction encoding (legacy / EIP-155)
//
// We use the pre-1559 legacy format because every L1/L2 we target
// (Base, Arbitrum, Ethereum) still accepts it and it's smaller than 1559.
// =============================================================================

interface LegacyTx {
  nonce: bigint
  gasPrice: bigint
  gasLimit: bigint
  to: Uint8Array
  value: bigint
  data: Uint8Array
  chainId: bigint
}

function signEip155LegacyTx(tx: LegacyTx, privateKey: Uint8Array): Uint8Array {
  // EIP-155: sign over [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
  const signingList = [
    bnToBytes(tx.nonce),
    bnToBytes(tx.gasPrice),
    bnToBytes(tx.gasLimit),
    tx.to,
    bnToBytes(tx.value),
    tx.data,
    bnToBytes(tx.chainId),
    new Uint8Array(0),
    new Uint8Array(0),
  ]
  const signingEnc = rlpEncodeList(signingList)
  const digest = keccak_256(signingEnc)
  const sig = secp256k1.sign(digest, privateKey)
  // EIP-155 v = chainId * 2 + 35 + recoveryBit
  const v = tx.chainId * 2n + 35n + BigInt(sig.recovery)
  const r = bnToBytes(sig.r)
  const s = bnToBytes(sig.s)

  const txList = [
    bnToBytes(tx.nonce),
    bnToBytes(tx.gasPrice),
    bnToBytes(tx.gasLimit),
    tx.to,
    bnToBytes(tx.value),
    tx.data,
    bnToBytes(v),
    r,
    s,
  ]
  return rlpEncodeList(txList)
}

function encodeErc20Transfer(toAddress: string, amount: bigint): string {
  // function transfer(address to, uint256 value) → selector 0xa9059cbb
  const selector = 'a9059cbb'
  const padTo = strip0x(toAddress).toLowerCase().padStart(64, '0')
  const padAmount = amount.toString(16).padStart(64, '0')
  return '0x' + selector + padTo + padAmount
}

// ── RLP encoding (just enough for legacy txs) ─────────────────────────────

function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  const encoded = items.map(rlpEncodeBytes)
  const total = encoded.reduce((n, e) => n + e.length, 0)
  const body = concat(...encoded)
  const header = rlpListHeader(total)
  return concat(header, body)
}

function rlpEncodeBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && b[0] < 0x80) return b
  if (b.length < 56) return concat(new Uint8Array([0x80 + b.length]), b)
  const lenBytes = bnToBytes(BigInt(b.length))
  return concat(new Uint8Array([0xb7 + lenBytes.length]), lenBytes, b)
}

function rlpListHeader(payloadLen: number): Uint8Array {
  if (payloadLen < 56) return new Uint8Array([0xc0 + payloadLen])
  const lenBytes = bnToBytes(BigInt(payloadLen))
  return concat(new Uint8Array([0xf7 + lenBytes.length]), lenBytes)
}

function bnToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0)
  let hex = n.toString(16)
  if (hex.length % 2 === 1) hex = '0' + hex
  return hexToBytes(hex)
}

// ── Generic byte helpers ──────────────────────────────────────────────────

function strip0x(s: string): string {
  return s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s
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

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const a of arrs) {
    out.set(a, o)
    o += a.length
  }
  return out
}

// =============================================================================
// Env loaders
// =============================================================================

const USDC_BY_NETWORK: Record<string, { address: string; chainId: number }> = {
  base:           { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', chainId: 8453 },
  'base-sepolia': { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', chainId: 84532 },
  arbitrum:       { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', chainId: 42161 },
  ethereum:       { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chainId: 1 },
}

const RPC_DEFAULTS: Record<string, string> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  ethereum: 'https://eth.llamarpc.com',
}

export function loadTreasuriesFromEnv(): Treasury[] {
  const treasuries: Treasury[] = []

  if (process.env.TREASURY_SOLANA_SECRET_KEY) {
    try {
      treasuries.push(
        new SolanaTreasury({
          secretKeyBase58: process.env.TREASURY_SOLANA_SECRET_KEY,
          rpcUrl: process.env.TREASURY_SOLANA_RPC_URL,
          network: (process.env.TREASURY_SOLANA_NETWORK as X402Network) ?? 'solana',
        }),
      )
    } catch (err: any) {
      log.warn({ err: err.message }, 'failed to init Solana treasury')
    }
  }

  if (process.env.TREASURY_EVM_PRIVATE_KEY) {
    const evmNet = (process.env.TREASURY_EVM_NETWORK ?? process.env.X402_EVM_NETWORK ?? 'base') as X402Network
    const meta = USDC_BY_NETWORK[evmNet]
    if (!meta) {
      log.warn({ network: evmNet }, 'unsupported EVM treasury network')
    } else {
      try {
        treasuries.push(
          new EvmTreasury({
            privateKey: process.env.TREASURY_EVM_PRIVATE_KEY,
            rpcUrl: process.env.TREASURY_EVM_RPC_URL ?? RPC_DEFAULTS[evmNet],
            usdcAddress: process.env.TREASURY_EVM_USDC ?? meta.address,
            chainId: meta.chainId,
            network: evmNet,
          }),
        )
      } catch (err: any) {
        log.warn({ err: err.message }, 'failed to init EVM treasury')
      }
    }
  }

  return treasuries
}
