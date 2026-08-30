import type { ImuSample } from '../imu/types'
import { DEG, GRAVITY } from './frames'

export const DETECT = {
  /** Below this the club counts as still. */
  stillDps: 15,
  /** How long it has to stay still before we trust the baseline. */
  stillWindowSec: 0.25,
  /** Crossing this starts looking at a possible takeaway. */
  takeawayDps: 60,
  /** How long it has to hold above that before we commit. */
  holdSec: 0.12,
  /** Fraction of the hold that must rotate the same way a takeaway does. */
  directionAgreement: 0.8,
  /** Contact. Well clear of the six or seven g the grip sees mid swing. */
  impactG: 12,
  /** No impact this long after takeaway means it was not a swing. */
  captureTimeoutSec: 4,
  /** Motion this quiet for this long, with no impact, also means it was not one. */
  abortStillSec: 0.3,
  /** A swing that never gets near this was something else. */
  minPeakDps: 400,
  /** How much follow through to keep after contact. */
  followSec: 0.3,
  /** Seconds of history kept for walking back to t=0. */
  historySec: 8,
} as const

export type DetectState = 'settling' | 'still' | 'candidate' | 'capturing'

export interface SwingCapture {
  /** Samples from t=0 through the end of follow through. */
  samples: ImuSample[]
  /** The still stretch just before takeaway, used for calibration. */
  still: ImuSample[]
  /** Index of contact within `samples`. */
  impactIndex: number
}

const magnitude = (s: ImuSample) => Math.hypot(s.gx, s.gy, s.gz)
const accelMagnitude = (s: ImuSample) => Math.hypot(s.ax, s.ay, s.az)

/**
 * Finds the real start of a swing in a live stream.
 *
 * Recording starts when the golfer taps the button, which is well before they
 * have settled over the ball, so the tap tells us nothing. What we do instead is
 * wait for genuine stillness, then watch for a rotation that crosses a threshold
 * and keeps building rather than dropping back the way a waggle does.
 *
 * Confirmation is deliberately split in two. A cheap check at 120ms commits to
 * capturing, which throws out most waggles straight away and keeps t=0 accurate.
 * A second check at the end throws out anything that got that far but never
 * turned into contact, which is what catches a waggle big and slow enough to
 * survive the first pass. Buffering is cheap, so a provisional capture costs
 * nothing if it turns out to be wrong.
 */
export class SwingDetector {
  private buf: ImuSample[] = []
  /** Absolute index of buf[0], so indices stay stable as history is trimmed. */
  private base = 0
  private next = 0

  private state: DetectState = 'settling'
  private stillRun = 0
  private stillStartAbs = -1

  private candidateAbs = -1
  private candidateDir = { x: 0, y: 0, z: 0 }

  private startAbs = -1
  private impactAbs = -1
  private peakDps = 0
  private quietRun = 0

  constructor(
    private onCapture: (capture: SwingCapture) => void,
    private onState?: (state: DetectState) => void,
  ) {}

  getState(): DetectState {
    return this.state
  }

  reset(): void {
    this.buf = []
    this.base = 0
    this.next = 0
    this.stillRun = 0
    this.stillStartAbs = -1
    this.candidateAbs = -1
    this.startAbs = -1
    this.impactAbs = -1
    this.peakDps = 0
    this.quietRun = 0
    this.setState('settling')
  }

  push(batch: ImuSample[]): void {
    for (const s of batch) this.feed(s)
    this.trim()
  }

  private feed(s: ImuSample): void {
    this.buf.push(s)
    const abs = this.next++
    const dps = magnitude(s) / DEG

    if (dps < DETECT.stillDps) {
      this.stillRun++
      if (this.stillStartAbs < 0) this.stillStartAbs = abs
    } else {
      this.stillRun = 0
      this.stillStartAbs = -1
    }

    switch (this.state) {
      case 'settling':
        if (this.stillRun >= this.samplesFor(DETECT.stillWindowSec)) this.setState('still')
        break

      case 'still':
        if (dps > DETECT.takeawayDps) {
          this.candidateAbs = abs
          this.candidateDir = { x: s.gx, y: s.gy, z: s.gz }
          this.setState('candidate')
        }
        break

      case 'candidate':
        this.evaluateCandidate(abs, dps)
        break

      case 'capturing':
        this.evaluateCapture(abs, s, dps)
        break
    }
  }

  private evaluateCandidate(abs: number, dps: number): void {
    // Dropped back below threshold before the hold elapsed. That is a waggle.
    if (dps < DETECT.takeawayDps) {
      this.setState('settling')
      return
    }
    if (abs - this.candidateAbs < this.samplesFor(DETECT.holdSec)) return

    const window = this.slice(this.candidateAbs, abs + 1)
    if (this.looksLikeTakeaway(window)) {
      // Walk back to the last moment of genuine stillness. That is t=0, not the
      // threshold crossing and definitely not the record tap.
      this.startAbs = this.lastStillBefore(this.candidateAbs)
      this.impactAbs = -1
      this.peakDps = 0
      this.quietRun = 0
      this.setState('capturing')
    } else {
      this.setState('settling')
    }
  }

  private looksLikeTakeaway(window: ImuSample[]): boolean {
    const d = this.candidateDir
    let agree = 0
    for (const s of window) {
      if (s.gx * d.x + s.gy * d.y + s.gz * d.z > 0) agree++
    }
    if (agree / window.length < DETECT.directionAgreement) return false

    // A takeaway is still building 120ms in. A waggle has already turned around.
    const half = Math.floor(window.length / 2)
    const first = mean(window.slice(0, half).map(magnitude))
    const second = mean(window.slice(half).map(magnitude))
    return second > first
  }

  private evaluateCapture(abs: number, s: ImuSample, dps: number): void {
    this.peakDps = Math.max(this.peakDps, dps)

    if (this.impactAbs < 0) {
      const g = accelMagnitude(s) / GRAVITY
      // Guard the window so the takeaway itself can never register as contact.
      if (g > DETECT.impactG && abs - this.startAbs > this.samplesFor(0.15)) {
        this.impactAbs = abs
      }
    }

    if (this.impactAbs >= 0) {
      if (abs - this.impactAbs >= this.samplesFor(DETECT.followSec)) this.emit(abs)
      return
    }

    // No contact yet. Give up if the club goes quiet again or if it drags on.
    this.quietRun = dps < DETECT.stillDps ? this.quietRun + 1 : 0
    const wentQuiet = this.quietRun >= this.samplesFor(DETECT.abortStillSec)
    const tooLong = abs - this.startAbs > this.samplesFor(DETECT.captureTimeoutSec)
    if (wentQuiet || tooLong) this.setState('settling')
  }

  private emit(endAbs: number): void {
    if (this.peakDps < DETECT.minPeakDps) {
      this.setState('settling')
      return
    }
    const samples = this.slice(this.startAbs, endAbs + 1)
    const stillEnd = this.startAbs + 1
    const stillStart = Math.max(this.base, stillEnd - this.samplesFor(DETECT.stillWindowSec))
    const capture: SwingCapture = {
      samples,
      still: this.slice(stillStart, stillEnd),
      impactIndex: this.impactAbs - this.startAbs,
    }
    this.setState('settling')
    this.onCapture(capture)
  }

  /** Last sample at or before `abs` that was genuinely still. */
  private lastStillBefore(abs: number): number {
    for (let i = abs; i >= this.base; i--) {
      if (magnitude(this.buf[i - this.base]) / DEG < DETECT.stillDps) return i
    }
    return this.base
  }

  private slice(fromAbs: number, toAbs: number): ImuSample[] {
    return this.buf.slice(Math.max(0, fromAbs - this.base), toAbs - this.base)
  }

  private samplesFor(seconds: number): number {
    // Derived from the stream itself rather than assumed, so a source running at
    // a different rate still gets the same thresholds in real time.
    return Math.max(1, Math.round(seconds * this.rateHz()))
  }

  private rateHz(): number {
    if (this.buf.length < 2) return 400
    const span = this.buf[this.buf.length - 1].t - this.buf[0].t
    return span > 0 ? (this.buf.length - 1) / span : 400
  }

  /** Drop history we can no longer need, in chunks so it stays amortized O(1). */
  private trim(): void {
    const keep = this.samplesFor(DETECT.historySec)
    if (this.buf.length < keep * 2) return
    // Never trim past the start of a capture in progress.
    const floor = this.state === 'capturing' ? this.startAbs : this.next - keep
    const drop = Math.max(0, Math.min(this.buf.length - keep, floor - this.base))
    if (drop <= 0) return
    this.buf = this.buf.slice(drop)
    this.base += drop
  }

  private setState(next: DetectState): void {
    if (this.state === next) return
    this.state = next
    if (next === 'settling') this.stillRun = 0
    this.onState?.(next)
  }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
