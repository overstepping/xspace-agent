// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas (https://github.com/nirholas/agent)

// =============================================================================
// POST /api/ask — pay-per-question endpoint.
//
// Supports two payment modes (clients can choose either per request):
//
//   A) Pay-as-you-go (default, no auth required)
//      - Client posts { question } without payment.
//      - x402Gate responds 402 with USDC payment requirements.
//      - Client signs with Phantom/MetaMask, retries with X-PAYMENT header.
//      - Gate verifies + settles, attaches req.x402, then we process.
//
//   B) Prepaid wallet (Authorization: Bearer <session>)
//      - Client previously signed in (POST /api/wallet/session) and topped up.
//      - We debit the user's ledger balance before processing.
//      - If processing fails, the charge is refunded to the same balance.
//
// Mode A keeps the demo non-custodial. Mode B trades custody for conversational
// flow (no wallet popup per question).
//
// In both modes:
//   - 202 { questionId } responds immediately.
//   - The answer text + audio arrive over Socket.IO `ask:response`,
//     keyed by questionId.
// =============================================================================

import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import type { Server as IOServer } from 'socket.io'
import {
  createLLM,
  createTTS,
  getAppLogger,
  type LLMProvider,
  type TTSProvider,
  type XSpaceAgent,
} from 'xspace-agent'

import { loadX402ConfigFromEnv, x402Gate } from '../x402'
import type {
  AgentWalletLedger,
  WalletSessionManager,
} from '../wallet'
import {
  InsufficientBalanceError,
  type WalletNetworkKind,
} from '../wallet'
import { extractSessionToken } from '../wallet/session-middleware'

const AskBody = z.object({
  question: z.string().trim().min(1).max(500),
})

interface AskRouterDeps {
  /** Reference to the server-wide state object holding the live agent (if any). */
  state: { agent: XSpaceAgent | null }
  io: IOServer
  /** Prepaid wallet ledger. If omitted, only pay-as-you-go (x402) mode works. */
  ledger?: AgentWalletLedger
  /** Session manager used to validate Bearer tokens for prepaid mode. */
  sessions?: WalletSessionManager
  /** Price per question in USDC base units. Defaults to env (X402_PRICE_USDC). */
  pricePerQuestionUsdcMicros?: string
}

interface AskResponseEvent {
  questionId: string
  text: string
  /** Base64-encoded MP3, or null if no audio was generated. */
  audio: string | null
  /** Which path produced the answer. */
  source: 'agent' | 'direct'
  /** Tx hash from the x402 settlement (per-request mode only). */
  txHash?: string
  network?: string
  payer?: string
  /** Set in prepaid mode. The wallet address that was debited. */
  prepaidAddress?: string
}

interface AskErrorEvent {
  questionId: string
  error: string
}

type PaymentContext =
  | {
      kind: 'x402'
      network: string
      txHash: string
      payer: string
      amount: string
      asset: string
    }
  | {
      kind: 'prepaid'
      address: string
      walletKind: WalletNetworkKind
      amountUsdcMicros: string
    }

export function createAskRouter(deps: AskRouterDeps): Router {
  const router = Router()
  const log = getAppLogger('ask')

  const x402Config = loadX402ConfigFromEnv()
  const pricePerQuestion =
    deps.pricePerQuestionUsdcMicros ?? process.env.X402_PRICE_USDC ?? '10000'

  if (!x402Config && !(deps.ledger && deps.sessions)) {
    log.warn('neither x402 nor prepaid wallet configured — POST /api/ask will 503')
    router.post('/', (_req, res) => {
      res.status(503).json({
        error: 'no payment method configured',
        hint:
          'configure x402 (SOLANA_RECIPIENT_ADDRESS + CDP_API_KEY_* and/or EVM_RECIPIENT_ADDRESS) ' +
          'or prepaid wallet (WALLET_SESSION_SECRET + TREASURY_*)',
      })
    })
    return router
  }

  const x402GateMw = x402Config ? x402Gate(x402Config) : null
  const spaceNS = deps.io.of('/space')

  // Lazy provider holders for the fallback path.
  let fallbackLlm: LLMProvider | null = null
  let fallbackTts: TTSProvider | null = null

  function getFallbackLlm(): LLMProvider | null {
    if (fallbackLlm) return fallbackLlm
    const provider = (process.env.AI_PROVIDER ?? 'openai') as
      | 'openai'
      | 'claude'
      | 'groq'
      | 'gemini'
    const apiKey =
      provider === 'claude'
        ? process.env.ANTHROPIC_API_KEY
        : provider === 'groq'
          ? process.env.GROQ_API_KEY
          : provider === 'gemini'
            ? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
            : process.env.OPENAI_API_KEY
    if (!apiKey) return null
    try {
      fallbackLlm = createLLM({ provider, apiKey } as any)
      return fallbackLlm
    } catch (err: any) {
      log.warn({ err: err.message }, 'failed to init fallback LLM')
      return null
    }
  }

  function getFallbackTts(): TTSProvider | null {
    if (fallbackTts) return fallbackTts
    const provider = (process.env.TTS_PROVIDER ?? 'openai') as
      | 'openai'
      | 'elevenlabs'
      | 'browser'
    const apiKey =
      provider === 'elevenlabs' ? process.env.ELEVENLABS_API_KEY : process.env.OPENAI_API_KEY
    if (!apiKey && provider !== 'browser') return null
    try {
      fallbackTts = createTTS({ provider, apiKey } as any)
      return fallbackTts
    } catch (err: any) {
      log.warn({ err: err.message }, 'failed to init fallback TTS')
      return null
    }
  }

  // ── Router-level dispatch ────────────────────────────────────────────────
  //
  // The presence of a session token decides the path. We can't combine the
  // two as middleware because x402Gate would otherwise demand payment from
  // prepaid users.

  router.post('/', async (req, res) => {
    const usingPrepaid = Boolean(extractSessionToken(req)) && deps.sessions && deps.ledger

    if (usingPrepaid) {
      await handlePrepaid(req, res)
      return
    }

    if (!x402GateMw) {
      res.status(401).json({
        error: 'prepaid session required — x402 fallback not configured',
        hint: 'sign in via POST /api/wallet/session and retry with Authorization: Bearer <token>',
      })
      return
    }

    // Per-request x402 path: run the gate, then continue.
    x402GateMw(req, res, () => {
      void handleX402(req, res).catch((err: any) => {
        log.error({ err: err.message }, 'ask handler crashed (x402 path)')
        if (!res.headersSent) {
          res.status(500).json({ error: 'internal error', detail: err.message })
        }
      })
    })
  })

  // ── x402 mode ────────────────────────────────────────────────────────────

  async function handleX402(req: any, res: any): Promise<void> {
    const parsed = AskBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.flatten() })
      return
    }
    const payment = req.x402!
    const questionId = randomUUID()
    const context: PaymentContext = {
      kind: 'x402',
      network: payment.network,
      txHash: payment.txHash,
      payer: payment.payer,
      amount: payment.amount,
      asset: payment.asset,
    }

    log.info(
      { questionId, mode: 'x402', network: payment.network, txHash: payment.txHash },
      'paid question accepted',
    )
    res.status(202).json({
      questionId,
      status: 'processing',
      mode: 'x402',
      paidWith: {
        network: payment.network,
        txHash: payment.txHash,
        amount: payment.amount,
        asset: payment.asset,
      },
    })
    processQuestion({ question: parsed.data.question, questionId, payment: context }).catch(
      (err: any) => {
        log.error({ err: err.message, questionId }, 'paid question processing failed')
        spaceNS.emit('ask:error', {
          questionId,
          error: err.message ?? 'processing failed',
        } satisfies AskErrorEvent)
      },
    )
  }

  // ── Prepaid mode ─────────────────────────────────────────────────────────

  async function handlePrepaid(req: any, res: any): Promise<void> {
    const sessions = deps.sessions!
    const ledger = deps.ledger!

    const token = extractSessionToken(req)!
    let claims
    try {
      claims = sessions.verifyToken(token)
    } catch (err: any) {
      res.status(401).json({ error: 'invalid or expired session' })
      return
    }

    const parsed = AskBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.flatten() })
      return
    }

    const questionId = randomUUID()
    const amount = pricePerQuestion

    try {
      await ledger.spend({
        address: claims.sub,
        kind: claims.kind,
        amountUsdcMicros: amount,
        questionId,
      })
    } catch (err: unknown) {
      if (err instanceof InsufficientBalanceError) {
        // Tell the client both how much they're short AND give them the
        // option to switch to per-request x402 by offering the requirements.
        res.status(402).json({
          error: 'insufficient balance',
          required: err.required,
          available: err.available,
          hint: 'top up via POST /api/wallet/deposit, or omit the session header to pay per-request',
        })
        return
      }
      throw err
    }

    const context: PaymentContext = {
      kind: 'prepaid',
      address: claims.sub,
      walletKind: claims.kind,
      amountUsdcMicros: amount,
    }

    log.info(
      { questionId, mode: 'prepaid', address: claims.sub, amountUsdcMicros: amount },
      'paid question accepted',
    )

    res.status(202).json({
      questionId,
      status: 'processing',
      mode: 'prepaid',
      paidWith: {
        address: claims.sub,
        amountUsdcMicros: amount,
      },
    })

    processQuestion({ question: parsed.data.question, questionId, payment: context }).catch(
      async (err: any) => {
        log.error({ err: err.message, questionId }, 'prepaid question processing failed')
        try {
          await ledger.refund({
            address: claims.sub,
            kind: claims.kind,
            amountUsdcMicros: amount,
            questionId,
            note: err.message ?? 'processing failed',
          })
        } catch (refundErr: any) {
          log.error(
            { err: refundErr.message, questionId },
            'refund FAILED — manual ledger reconciliation needed',
          )
        }
        spaceNS.emit('ask:error', {
          questionId,
          error: err.message ?? 'processing failed',
        } satisfies AskErrorEvent)
      },
    )
  }

  // ── Shared answer pipeline ───────────────────────────────────────────────

  async function processQuestion(args: {
    question: string
    questionId: string
    payment: PaymentContext
  }): Promise<void> {
    const { question, questionId, payment } = args
    if (deps.state.agent) {
      await routeThroughAgent(deps.state.agent, question, questionId, payment)
      return
    }
    await routeDirect(question, questionId, payment)
  }

  /**
   * Active agent path — pipe the question through the live agent so it gets
   * spoken in the Space. We listen for the next `response` event and echo
   * its text + audio back to the web client.
   */
  async function routeThroughAgent(
    agent: XSpaceAgent,
    question: string,
    questionId: string,
    payment: PaymentContext,
  ): Promise<void> {
    const TIMEOUT_MS = 45_000

    const result = await new Promise<{ text: string; audio: Buffer | null }>((resolve, reject) => {
      const onResponse = (ev: { text: string; audio: Buffer | null }): void => {
        cleanup()
        resolve(ev)
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(err)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('agent response timeout'))
      }, TIMEOUT_MS)

      function cleanup(): void {
        clearTimeout(timer)
        ;(agent as any).off?.('response', onResponse)
        ;(agent as any).off?.('error', onError)
      }

      ;(agent as any).once('response', onResponse)
      ;(agent as any).once('error', onError)

      agent.say(question).catch((err: Error) => {
        cleanup()
        reject(err)
      })
    })

    emitResponse(questionId, result.text, result.audio, 'agent', payment)
  }

  /**
   * Fallback path — no active agent. Generate a text response via LLM and
   * synthesize audio via TTS, then emit over Socket.IO. The audio is NOT
   * injected into any Space (there is none).
   */
  async function routeDirect(
    question: string,
    questionId: string,
    payment: PaymentContext,
  ): Promise<void> {
    const llm = getFallbackLlm()
    if (!llm) {
      throw new Error('no LLM provider configured for offline answers')
    }

    const systemPrompt =
      'You are an AI agent that normally hosts live X Spaces. Right now you are not in a Space — answer briefly and conversationally, as if greeting a curious visitor on your website.'

    let text = ''
    for await (const chunk of llm.streamResponse(0, question, systemPrompt)) {
      text += chunk
    }
    text = text.trim()

    let audio: Buffer | null = null
    const tts = getFallbackTts()
    if (tts) {
      try {
        audio = await tts.synthesize(text)
      } catch (err: any) {
        log.warn({ err: err.message, questionId }, 'fallback TTS failed; sending text-only')
      }
    }

    emitResponse(questionId, text, audio, 'direct', payment)
  }

  function emitResponse(
    questionId: string,
    text: string,
    audio: Buffer | null,
    source: 'agent' | 'direct',
    payment: PaymentContext,
  ): void {
    const event: AskResponseEvent = {
      questionId,
      text,
      audio: audio ? audio.toString('base64') : null,
      source,
    }
    if (payment.kind === 'x402') {
      event.txHash = payment.txHash
      event.network = payment.network
      event.payer = payment.payer
    } else {
      event.prepaidAddress = payment.address
      event.network = payment.walletKind === 'solana' ? 'solana' : 'evm'
    }
    spaceNS.emit('ask:response', event)
  }

  return router
}
