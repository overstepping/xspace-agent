// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 nirholas

import { XSpaceAskClient, type AskResponseEvent, type AskErrorEvent } from '@xspace/web-client'

// ---------------------------------------------------------------------------
// Config — apiUrl is same-origin in production (served from the xspace-agent
// Express static handler). In dev, Vite proxies /api and /socket.io to :3000.
// ---------------------------------------------------------------------------

const apiUrl =
  (import.meta.env.VITE_XSPACE_API_URL as string | undefined) ?? window.location.origin

const client = new XSpaceAskClient({
  apiUrl,
  preferredNetwork: 'solana',
})

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const avatar = document.getElementById('avatar') as HTMLElement | null
const transcript = document.getElementById('transcript') as HTMLOListElement
const form = document.getElementById('ask-form') as HTMLFormElement
const input = document.getElementById('question') as HTMLInputElement
const sendBtn = document.getElementById('send') as HTMLButtonElement
const connectBtn = document.getElementById('connect') as HTMLButtonElement
const walletStatus = document.getElementById('wallet-status') as HTMLSpanElement

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function addMessage(
  role: 'you' | 'agent' | 'error',
  text: string,
  meta?: string,
): HTMLLIElement {
  const li = document.createElement('li')
  li.className = role
  li.textContent = text
  if (meta) {
    const span = document.createElement('span')
    span.className = 'meta'
    span.textContent = meta
    li.appendChild(span)
  }
  transcript.appendChild(li)
  transcript.scrollTop = transcript.scrollHeight
  return li
}

function setWalletStatus(text: string | null): void {
  if (!text) {
    walletStatus.hidden = true
    walletStatus.textContent = ''
    return
  }
  walletStatus.hidden = false
  walletStatus.textContent = text
}

function shortAddress(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr
}

// ---------------------------------------------------------------------------
// Lipsync — amplitude-driven mouth animation. We try a few common method
// names that `<agent-3d>` might expose; if none exist, fall back to
// dispatching a CustomEvent so the host page can listen if it wants.
// ---------------------------------------------------------------------------

interface MouthSink {
  (amplitude: number): void
}

function getMouthSink(el: HTMLElement | null): MouthSink {
  if (!el) return () => undefined
  const anyEl = el as any
  if (typeof anyEl.setMouthOpenness === 'function') {
    return (a) => anyEl.setMouthOpenness(a)
  }
  if (typeof anyEl.setBlendShape === 'function') {
    return (a) => anyEl.setBlendShape('mouthOpen', a)
  }
  if (typeof anyEl.lipsync === 'function') {
    return (a) => anyEl.lipsync(a)
  }
  // Fallback: dispatch a CustomEvent that any wrapper can listen to.
  return (a) => {
    el.dispatchEvent(new CustomEvent('mouth-amplitude', { detail: { amplitude: a } }))
  }
}

const mouthSink = getMouthSink(avatar)

// Shared AudioContext — lazily created on first user gesture (required for
// autoplay policies). Reusing it across multiple replies avoids leaking
// contexts.
let audioCtx: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext ||
      (window as any).webkitAudioContext)()
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => undefined)
  }
  return audioCtx
}

async function speakWithLipsync(b64Mp3: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(`data:audio/mp3;base64,${b64Mp3}`)
    audio.crossOrigin = 'anonymous'

    let ctx: AudioContext
    try {
      ctx = getAudioContext()
    } catch (err) {
      // No audio support — just resolve.
      resolve()
      return
    }

    const source = ctx.createMediaElementSource(audio)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)
    analyser.connect(ctx.destination)

    const data = new Uint8Array(analyser.frequencyBinCount)
    let rafId = 0

    function tick(): void {
      analyser.getByteFrequencyData(data)
      // Use a band-limited average focused on vocal frequencies (roughly
      // bins 1..32 of a 128-bin fftSize=256 analyser at 48kHz ≈ 200–6000Hz).
      let sum = 0
      const len = Math.min(32, data.length)
      for (let i = 1; i < len; i++) sum += data[i]
      const avg = sum / (len - 1) / 255 // 0..1
      // Apply a non-linear curve so quiet bits don't constantly twitch.
      const opening = Math.min(1, Math.max(0, (avg - 0.05) * 1.6))
      mouthSink(opening)
      rafId = requestAnimationFrame(tick)
    }

    audio.addEventListener('ended', () => {
      cancelAnimationFrame(rafId)
      mouthSink(0)
      resolve()
    })
    audio.addEventListener('error', (e) => {
      cancelAnimationFrame(rafId)
      mouthSink(0)
      reject(e)
    })

    audio.play().then(() => {
      tick()
    }).catch(reject)
  })
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

client.on('response', async (ev: AskResponseEvent) => {
  addMessage(
    'agent',
    ev.text,
    ev.txHash ? `${ev.source} · tx ${shortAddress(ev.txHash)}` : ev.source,
  )
  if (ev.audio) {
    try {
      await speakWithLipsync(ev.audio)
    } catch (err) {
      console.warn('lipsync playback failed', err)
    }
  }
})

client.on('error', (ev: AskErrorEvent) => {
  addMessage('error', ev.error)
})

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true
  try {
    const { kind, address } = await client.connect()
    setWalletStatus(`${kind} · ${shortAddress(address)}`)
    connectBtn.textContent = 'Connected'
  } catch (err: any) {
    addMessage('error', `wallet connect failed: ${err.message ?? err}`)
    connectBtn.disabled = false
  }
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const question = input.value.trim()
  if (!question) return

  sendBtn.disabled = true
  // Prime the AudioContext on this user gesture so the autoplay policy
  // doesn't block the reply audio.
  getAudioContext()

  if (!client.getActive()) {
    try {
      const { kind, address } = await client.connect()
      setWalletStatus(`${kind} · ${shortAddress(address)}`)
      connectBtn.textContent = 'Connected'
    } catch (err: any) {
      addMessage('error', `wallet connect failed: ${err.message ?? err}`)
      sendBtn.disabled = false
      return
    }
  }

  addMessage('you', question)
  input.value = ''

  try {
    const { questionId, paidWith } = await client.ask(question)
    addMessage('you', '✓ paid', `${paidWith.network} · ${shortAddress(paidWith.txHash || questionId)}`)
  } catch (err: any) {
    addMessage('error', err.message ?? 'request failed')
  } finally {
    sendBtn.disabled = false
  }
})

// Show which wallets are detected on load.
const detected = client.available()
if (detected.length === 0) {
  addMessage('error', 'No wallet detected. Install Phantom (Solana) or MetaMask (Base) to ask.')
  connectBtn.disabled = true
} else {
  setWalletStatus(`detected: ${detected.join(', ')}`)
}
