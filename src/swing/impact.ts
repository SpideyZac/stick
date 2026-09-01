import type { ImuSample } from "../imu/types";
import { rotate } from "../math/quat";
import { type Vec3, cross, dot, len, normalize, reject, sub, v3 } from "../math/vec3";
import { accelOf } from "./calibrate";
import { GRAVITY, SHAFT_AXIS_S } from "./frames";
import type { OrientationTrack } from "./orient";

export const IMPACT = {
    /**
     * How far either side of the geometric estimate a shock is allowed to move
     * contact. Wide enough to cover the forward shaft lean that puts the two a
     * few milliseconds apart, tight enough that a knock at the top or a bump in
     * the follow through can never be mistaken for the ball.
     */
    windowSec: 0.05,
    /**
     * How far a jerk sample has to stand out from the swing's own jerk beside it
     * before it counts as contact. A ratio, not a figure in g: what makes contact
     * visible at the grip is that the shaft rings, not that the reading is large,
     * and how large it is depends on the club, the shaft, the strike, and how
     * tightly the mount is strapped on.
     */
    shockProminence: 4,
    /** Nothing the club does this soon after t=0 can be contact. */
    guardSec: 0.15,
    /**
     * The clubhead counts as having passed the ball if it came at least this
     * close. Generous on purpose: it separates a swing at a ball from a swing
     * nowhere near one, and the reconstruction's own error is a good part of it.
     */
    passRadiusM: 0.25,
} as const;

export type ImpactSource = "shock" | "return" | "proximity" | "peak-rate";

export interface ImpactEstimate {
    /** Sample index of contact. */
    index: number;
    /** Seconds since t=0, interpolated between samples where that is possible. */
    sec: number;
    /** Which cue actually placed it. */
    source: ImpactSource;
    /**
     * How close the reconstructed clubhead came to the ball, in meters. Large
     * means either a genuine air swing or a reconstruction that has drifted.
     */
    approachM: number;
    /** Whether the clubhead came within IMPACT.passRadiusM of the ball. */
    passedBall: boolean;
    /** Peak jerk near contact over the swing's own jerk beside it. */
    shockRatio: number;
}

export interface ImpactInput {
    samples: readonly ImuSample[];
    /** Seconds since t=0, one per sample. */
    times: readonly number[];
    track: OrientationTrack;
    /** Reconstructed clubhead position, one per sample. */
    clubheadPath: readonly Vec3[];
    /** Where the ball sits, fixed for the whole swing. */
    ball: Vec3;
    /** Top of the backswing. Nothing before it can be contact. */
    topIndex: number;
}

/**
 * Where the club met the ball, without ever asking how hard it hit.
 *
 * The old test for this was an acceleration threshold, and that was the wrong
 * question twice over. The sensor sits on the shaft just below the grip, not on
 * the clubhead, so what reaches it at contact is whatever survives a meter of
 * flexing shaft: a short, sharp ring whose size depends on the club, the shaft,
 * the strike and how tight the strap is, and which is not reliably larger than
 * the six or seven g the grip already pulls mid swing. Picking a number in g and
 * hoping every strike clears it while nothing else does is guesswork, and it
 * fails in both directions -- a soft wedge never trips it, a violent transition
 * trips it early.
 *
 * What is actually known is geometry. The ball sits where the clubhead rested at
 * address, so contact is the moment the club comes back through the address pose
 * on the way down. That moment is visible in the gyro alone: track the shaft's
 * rotation about the swing axis relative to where it pointed at address, and it
 * sweeps away through the backswing and returns through zero coming down. One
 * integration, no threshold, and no assumption about how fast anyone swings.
 *
 * That return is a hair late on its own, by however much the hands lead the
 * clubhead at contact, so a shock is used to sharpen it when there is one: the
 * leading edge of a burst of jerk that clearly stands out from the swing's own
 * jerk right beside it. That is still not a threshold. It asks about contrast
 * rather than magnitude, it is only ever allowed to move the answer by a few
 * milliseconds either side of where the geometry already put it, and when no
 * shock survives the shaft, the geometry stands on its own.
 *
 * Nothing here reads the clubhead's distance from the ball to place contact.
 * That number carries the double-integrated grip position and has drifted a few
 * centimeters by the time the club comes back down, which is plenty to say
 * whether the club went at the ball at all -- reported as `approachM` -- and
 * nowhere near enough to choose between two samples.
 */
export function findImpact(input: ImpactInput): ImpactEstimate {
    const { samples, times, track, clubheadPath, ball, topIndex } = input;
    const n = samples.length;
    const rate = sampleRate(times);
    const guard = Math.max(1, Math.round(IMPACT.guardSec * rate));
    const from = Math.max(topIndex + 1, guard);
    const to = n - 1;

    if (from >= to) return fallbackToPeakRate(track, times, clubheadPath, ball, from, to);

    const axis = downswingAxis(track, from, to);
    const phase = shaftPhase(track, axis, n);
    const crossing = zeroCrossing(phase, times, from, to);

    const window = Math.max(1, Math.round(IMPACT.windowSec * rate));
    const seed = crossing ? crossing.index : nearestApproachIndex(clubheadPath, ball, from, to);
    let source: ImpactSource = crossing ? "return" : "proximity";
    let index = seed;
    let sec = crossing ? crossing.sec : times[seed];

    const lo = Math.max(from, seed - window);
    const hi = Math.min(to, seed + window);

    const shock = findShock(samples, lo, hi);
    if (shock.ratio >= IMPACT.shockProminence) {
        index = shock.index;
        sec = times[shock.index];
        source = "shock";
    }

    // How close the club came, reported and never used to move the answer. The
    // clubhead path carries the double-integrated grip position, which has drifted
    // a few centimeters by the time the club gets back down -- enough to say
    // whether the club went at the ball at all, nowhere near enough to pick between
    // two samples two and a half milliseconds apart. It is read at contact rather
    // than over the window, because the clubhead covers the better part of a meter
    // per hundredth of a second down here and a window minimum would flatter every
    // swing that passed anywhere near.
    const approachM = len(sub(clubheadPath[index], ball));
    return {
        index,
        sec,
        source,
        approachM,
        passedBall: approachM <= IMPACT.passRadiusM,
        shockRatio: shock.ratio,
    };
}

/**
 * Which way the club turns coming down, taken from the fast half of the
 * downswing so a slow, wandering transition cannot skew it.
 */
function downswingAxis(track: OrientationTrack, from: number, to: number): Vec3 {
    let peak = 0;
    for (let i = from; i <= to; i++) peak = Math.max(peak, track.rateDps[i]);
    const floor = peak * 0.5;

    let sum = v3(0, 0, 0);
    for (let i = from; i <= to; i++) {
        if (track.rateDps[i] < floor) continue;
        sum = {
            x: sum.x + track.omegaWorld[i].x,
            y: sum.y + track.omegaWorld[i].y,
            z: sum.z + track.omegaWorld[i].z,
        };
    }
    const axis = normalize(sum);
    return len(axis) > 0 ? axis : v3(0, 1, 0);
}

/**
 * Shaft rotation about the swing axis, measured from where the shaft pointed at
 * address and unwrapped so it keeps climbing past half a turn. Zero at address
 * by construction, sweeps out through the backswing, and comes back through zero
 * on the way down. That return is contact.
 *
 * Unwrapping is safe because a sample can only ever be a few degrees from the
 * one before it: even 2500 degrees per second is a sixteenth of a turn per
 * sample at 400 Hz, well short of the half turn that would make the direction of
 * a step ambiguous.
 */
function shaftPhase(track: OrientationTrack, axis: Vec3, n: number): Float64Array {
    const phase = new Float64Array(n);
    const reference = normalize(reject(rotate(track.q[0], SHAFT_AXIS_S), axis));
    // Degenerate only if the club turns about its own shaft, which no swing does.
    if (len(reference) === 0) return phase;

    let unwrapped = 0;
    let previous = 0;
    for (let i = 0; i < n; i++) {
        const shaft = normalize(reject(rotate(track.q[i], SHAFT_AXIS_S), axis));
        const raw = Math.atan2(dot(cross(reference, shaft), axis), dot(reference, shaft));
        let step = raw - previous;
        while (step > Math.PI) step -= 2 * Math.PI;
        while (step < -Math.PI) step += 2 * Math.PI;
        unwrapped += step;
        previous = raw;
        phase[i] = unwrapped;
    }
    return phase;
}

/**
 * First time after the top that the shaft comes back through the address
 * direction, interpolated between the two samples that straddle it. Worth
 * interpolating: the club covers several degrees per sample here.
 */
function zeroCrossing(
    phase: Float64Array,
    times: readonly number[],
    from: number,
    to: number,
): { index: number; sec: number } | null {
    for (let i = Math.max(1, from); i <= to; i++) {
        const a = phase[i - 1];
        const b = phase[i];
        if (b === 0) return { index: i, sec: times[i] };
        if (a === 0 || Math.sign(a) === Math.sign(b)) continue;
        const frac = a / (a - b);
        return {
            index: frac < 0.5 ? i - 1 : i,
            sec: times[i - 1] + frac * (times[i] - times[i - 1]),
        };
    }
    return null;
}

/** Sample in [lo, hi] whose clubhead position sits closest to the ball. */
function nearestApproachIndex(
    clubheadPath: readonly Vec3[],
    ball: Vec3,
    lo: number,
    hi: number,
): number {
    let best = lo;
    let bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
        const d = len(sub(clubheadPath[i], ball));
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

/** Where the burst is reckoned to have started, as a fraction of its own peak. */
const ONSET_FRACTION = 0.5;

/**
 * The contact burst in this window: where it starts, and how far it stands out
 * from the swing's own jerk beside it.
 *
 * Contact shows up at the grip as a sudden roughness in the acceleration,
 * sitting on a swing whose own acceleration is large but perfectly smooth.
 * Differencing kills the smooth part, and dividing by the local median says how
 * far out of family what is left is, without ever naming a number in g.
 *
 * The answer is the burst's leading edge, not its peak. A shaft rings for
 * several milliseconds after the ball has gone, and how that ring builds depends
 * on the club and the strike, so its loudest moment wanders. Its onset does not:
 * that is the ball.
 */
function findShock(
    samples: readonly ImuSample[],
    lo: number,
    hi: number,
): { index: number; ratio: number } {
    const start = Math.max(1, lo);
    if (start > hi) return { index: lo, ratio: 0 };

    const jerk: number[] = [];
    for (let i = start; i <= hi; i++) {
        jerk.push(len(sub(accelOf(samples[i]), accelOf(samples[i - 1]))));
    }
    if (jerk.length < 3) return { index: lo, ratio: 0 };

    let peak = 0;
    let peakAt = 0;
    for (let i = 0; i < jerk.length; i++) {
        if (jerk[i] > peak) {
            peak = jerk[i];
            peakAt = i;
        }
    }

    let onset = peakAt;
    while (onset > 0 && jerk[onset - 1] >= ONSET_FRACTION * peak) onset--;

    const sorted = [...jerk].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // A perfectly smooth stretch would otherwise divide by nothing. One percent
    // of a g is below the noise of any real BMI270, so it is a safe floor.
    const baseline = Math.max(median, 0.01 * GRAVITY);
    return { index: start + onset, ratio: peak / baseline };
}

/** Nothing to work with. The fastest sample is the best guess left. */
function fallbackToPeakRate(
    track: OrientationTrack,
    times: readonly number[],
    clubheadPath: readonly Vec3[],
    ball: Vec3,
    from: number,
    to: number,
): ImpactEstimate {
    const lo = Math.max(0, Math.min(from, times.length - 1));
    const hi = Math.max(lo, Math.min(to, times.length - 1));
    let index = lo;
    for (let i = lo; i <= hi; i++) {
        if (track.rateDps[i] > track.rateDps[index]) index = i;
    }
    const approachM = len(sub(clubheadPath[index], ball));
    return {
        index,
        sec: times[index],
        source: "peak-rate",
        approachM,
        passedBall: approachM <= IMPACT.passRadiusM,
        shockRatio: 0,
    };
}

function sampleRate(times: readonly number[]): number {
    if (times.length < 2) return 400;
    const span = times[times.length - 1] - times[0];
    return span > 0 ? (times.length - 1) / span : 400;
}
