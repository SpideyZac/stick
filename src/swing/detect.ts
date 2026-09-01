import type { ImuSample } from "../imu/types";
import { DEG } from "./frames";

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
    /** A swing that never gets near this was something else. */
    minPeakDps: 400,
    /**
     * Once the club has been through the ball it slows down. Below this, held for
     * followSec, the swing is over and the capture closes. Everything after the
     * strike is follow through, so this doubles as how much of it gets kept.
     */
    releaseDps: 150,
    followSec: 0.3,
    /** No downswing this long after takeaway means it was not a swing. */
    captureTimeoutSec: 7,
    /** Motion this quiet for this long, before any downswing, also means it was not one. */
    abortStillSec: 0.3,
    /** Gap left between the calibration window and t=0, so the takeaway ramp
     * cannot contaminate the bias estimate. */
    stillGuardSec: 0.06,
    /** Seconds of history kept for walking back to t=0. */
    historySec: 8,
} as const;

export type DetectState = "settling" | "still" | "candidate" | "capturing";

export interface SwingCapture {
    /** Samples from t=0 through the end of follow through. */
    samples: ImuSample[];
    /** The still stretch just before takeaway, used for calibration. */
    still: ImuSample[];
}

const magnitude = (s: ImuSample) => Math.hypot(s.gx, s.gy, s.gz);

/**
 * Finds the real start and end of a swing in a live stream.
 *
 * Recording starts when the golfer taps the button, which is well before they
 * have settled over the ball, so the tap tells us nothing. What we do instead is
 * wait for genuine stillness, then watch for a rotation that crosses a threshold
 * and keeps building rather than dropping back the way a waggle does.
 *
 * Confirmation is deliberately split in two. A cheap check at 120ms commits to
 * capturing, which throws out most waggles straight away and keeps t=0 accurate.
 * A second check at the end throws out anything that got that far but never
 * turned into a downswing, which is what catches a waggle big and slow enough to
 * survive the first pass. Buffering is cheap, so a provisional capture costs
 * nothing if it turns out to be wrong.
 *
 * What this deliberately does not do is find contact. It used to, by watching
 * for an acceleration spike, and that was never a question the grip could answer
 * -- see src/swing/impact.ts. All this has to know is that a downswing happened
 * and has finished, which is plain in the gyro: a fast rotation opposing the
 * takeaway, then a decay. Contact is placed later, from the reconstructed swing.
 */
export class SwingDetector {
    private buf: ImuSample[] = [];
    /** Absolute index of buf[0], so indices stay stable as history is trimmed. */
    private base = 0;
    private next = 0;

    private state: DetectState = "settling";
    private stillRun = 0;

    private candidateAbs = -1;
    private candidateDir = { x: 0, y: 0, z: 0 };

    private startAbs = -1;
    private peakDps = 0;
    private quietRun = 0;
    private releaseRun = 0;
    private downswingSeen = false;

    constructor(
        private onCapture: (capture: SwingCapture) => void,
        private onState?: (state: DetectState) => void,
    ) {}

    getState(): DetectState {
        return this.state;
    }

    reset(): void {
        this.buf = [];
        this.base = 0;
        this.next = 0;
        this.stillRun = 0;
        this.candidateAbs = -1;
        this.startAbs = -1;
        this.peakDps = 0;
        this.quietRun = 0;
        this.releaseRun = 0;
        this.downswingSeen = false;
        this.setState("settling");
    }

    push(batch: ImuSample[]): void {
        for (const s of batch) this.feed(s);
        this.trim();
    }

    private feed(s: ImuSample): void {
        this.buf.push(s);
        const abs = this.next++;
        const dps = magnitude(s) / DEG;

        if (dps < DETECT.stillDps) {
            this.stillRun++;
        } else {
            this.stillRun = 0;
        }

        switch (this.state) {
            case "settling":
                if (this.stillRun >= this.samplesFor(DETECT.stillWindowSec)) this.setState("still");
                break;

            case "still":
                if (dps > DETECT.takeawayDps) {
                    this.candidateAbs = abs;
                    this.candidateDir = { x: s.gx, y: s.gy, z: s.gz };
                    this.setState("candidate");
                }
                break;

            case "candidate":
                this.evaluateCandidate(abs, dps);
                break;

            case "capturing":
                this.evaluateCapture(abs, s, dps);
                break;
        }
    }

    private evaluateCandidate(abs: number, dps: number): void {
        // Dropped back below threshold before the hold elapsed. That is a waggle.
        if (dps < DETECT.takeawayDps) {
            this.setState("settling");
            return;
        }
        if (abs - this.candidateAbs < this.samplesFor(DETECT.holdSec)) return;

        const window = this.slice(this.candidateAbs, abs + 1);
        if (this.looksLikeTakeaway(window)) {
            // Walk back to the last moment of genuine stillness. That is t=0, not the
            // threshold crossing and definitely not the record tap.
            this.startAbs = this.lastStillBefore(this.candidateAbs);
            this.peakDps = 0;
            this.quietRun = 0;
            this.releaseRun = 0;
            this.downswingSeen = false;
            this.setState("capturing");
        } else {
            this.setState("settling");
        }
    }

    private looksLikeTakeaway(window: ImuSample[]): boolean {
        const d = this.candidateDir;
        let agree = 0;
        for (const s of window) {
            if (s.gx * d.x + s.gy * d.y + s.gz * d.z > 0) agree++;
        }
        if (agree / window.length < DETECT.directionAgreement) return false;

        // A takeaway is still building 120ms in. A waggle has already turned around.
        const half = Math.floor(window.length / 2);
        const first = mean(window.slice(0, half).map(magnitude));
        const second = mean(window.slice(half).map(magnitude));
        return second > first;
    }

    private evaluateCapture(abs: number, s: ImuSample, dps: number): void {
        this.peakDps = Math.max(this.peakDps, dps);

        // A hard rotation opposing the takeaway is the downswing and nothing else.
        // The backswing runs the other way, so it can never set this however fast
        // it gets, which a plain speed threshold could not promise.
        if (!this.downswingSeen && dps >= DETECT.minPeakDps && this.opposesTakeaway(s)) {
            this.downswingSeen = true;
        }

        const tooLong = abs - this.startAbs > this.samplesFor(DETECT.captureTimeoutSec);

        if (this.downswingSeen) {
            this.releaseRun = dps < DETECT.releaseDps ? this.releaseRun + 1 : 0;
            // Close on the club settling, or on the timeout if it never does. A
            // golfer who swings and walks straight off never goes quiet, and without
            // the second condition the capture would run forever and take the
            // history buffer with it.
            if (this.releaseRun >= this.samplesFor(DETECT.followSec) || tooLong) this.emit(abs);
            return;
        }

        // No downswing yet. Give up if the club goes quiet again or if it drags on.
        this.quietRun = dps < DETECT.stillDps ? this.quietRun + 1 : 0;
        const wentQuiet = this.quietRun >= this.samplesFor(DETECT.abortStillSec);
        if (wentQuiet || tooLong) this.setState("settling");
    }

    private opposesTakeaway(s: ImuSample): boolean {
        const d = this.candidateDir;
        return s.gx * d.x + s.gy * d.y + s.gz * d.z < 0;
    }

    /** Close out a capture, provided the swing was ever quick enough to be one. */
    private emit(endAbs: number): void {
        if (this.peakDps < DETECT.minPeakDps) {
            this.setState("settling");
            return;
        }
        const samples = this.slice(this.startAbs, endAbs + 1);
        const stillEnd = this.startAbs + 1 - this.samplesFor(DETECT.stillGuardSec);
        const stillStart = Math.max(this.base, stillEnd - this.samplesFor(DETECT.stillWindowSec));
        // Not enough clean history to calibrate against, so this one is unusable.
        if (stillEnd - stillStart < 8) {
            this.setState("settling");
            return;
        }
        const capture: SwingCapture = { samples, still: this.slice(stillStart, stillEnd) };
        this.setState("settling");
        this.onCapture(capture);
    }

    /** Last sample at or before `abs` that was genuinely still. */
    private lastStillBefore(abs: number): number {
        for (let i = abs; i >= this.base; i--) {
            if (magnitude(this.buf[i - this.base]) / DEG < DETECT.stillDps) return i;
        }
        return this.base;
    }

    private slice(fromAbs: number, toAbs: number): ImuSample[] {
        return this.buf.slice(Math.max(0, fromAbs - this.base), toAbs - this.base);
    }

    private samplesFor(seconds: number): number {
        // Derived from the stream itself rather than assumed, so a source running at
        // a different rate still gets the same thresholds in real time.
        return Math.max(1, Math.round(seconds * this.rateHz()));
    }

    private rateHz(): number {
        if (this.buf.length < 2) return 400;
        const span = this.buf[this.buf.length - 1].t - this.buf[0].t;
        return span > 0 ? (this.buf.length - 1) / span : 400;
    }

    /** Drop history we can no longer need, in chunks so it stays amortized O(1). */
    private trim(): void {
        const keep = this.samplesFor(DETECT.historySec);
        if (this.buf.length < keep * 2) return;
        // Never trim past the start of a capture in progress.
        const floor = this.state === "capturing" ? this.startAbs : this.next - keep;
        const drop = Math.max(0, Math.min(this.buf.length - keep, floor - this.base));
        if (drop <= 0) return;
        this.buf = this.buf.slice(drop);
        this.base += drop;
    }

    private setState(next: DetectState): void {
        if (this.state === next) return;
        this.state = next;
        if (next === "settling") this.stillRun = 0;
        this.onState?.(next);
    }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
