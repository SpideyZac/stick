import type { ImuSample } from "../imu/types";
import { type Vec3, add, dot, normalize, v3 } from "../math/vec3";
import type { OrientationTrack } from "./orient";

/** Below this the club counts as paused at the top. */
const PAUSE_DPS = 45;
/** Enough motion to count as under way, matching the detector. */
const TAKEAWAY_DPS = 60;
/** How much of the takeaway to average over when reading which way "back" is. */
const TAKEAWAY_WINDOW_SEC = 0.12;

export interface Phases {
    topIndex: number;
    impactIndex: number;
    peakRateIndex: number;
    peakRateDps: number;
    backswingSec: number;
    downswingSec: number;
    transitionPauseSec: number;
    /** Backswing over downswing. The classic number is about 3. */
    tempoRatio: number;
}

export interface Top {
    topIndex: number;
    /** Which way the club turned going back. Unit length. */
    backAxis: Vec3;
}

/**
 * Find the top of the backswing.
 *
 * This runs before contact has been placed, because placing contact needs the
 * top: the return through address that marks the strike is only unambiguous once
 * you know the club has already been to the top and turned around
 * (src/swing/impact.ts).
 *
 * The top is where rotation about the backswing axis crosses zero, which is a
 * cleaner marker than looking for a dip in raw magnitude. Raw magnitude has a
 * minimum at the top too, but it is shallow and noisy, whereas the sign change is
 * unambiguous. Nothing here needs an upper bound: the downswing and follow
 * through both project negative along the backswing axis, so neither can be
 * mistaken for part of the backswing however fast they get.
 */
export function findTop(samples: readonly ImuSample[], track: OrientationTrack): Top {
    const n = track.rateDps.length;
    const backAxis = takeawayAxis(samples, track);
    const projected = track.omegaWorld.map((w) => dot(w, backAxis));

    let backPeak = 0;
    for (let i = 1; i < n; i++) {
        if (projected[i] > projected[backPeak]) backPeak = i;
    }

    let topIndex = backPeak;
    for (let i = backPeak; i < n; i++) {
        if (projected[i] <= 0) {
            topIndex = i;
            break;
        }
    }

    return { topIndex, backAxis };
}

/**
 * Split a captured swing into backswing, transition, and downswing, given the
 * top and the moment of contact.
 */
export function segment(
    samples: readonly ImuSample[],
    track: OrientationTrack,
    topIndex: number,
    impactIndex: number,
): Phases {
    const t = (i: number) => samples[i].t - samples[0].t;

    // Widen out from the top over everything still quiet enough to count as paused.
    let pauseStart = topIndex;
    while (pauseStart > 0 && track.rateDps[pauseStart - 1] < PAUSE_DPS) pauseStart--;
    let pauseEnd = topIndex;
    while (pauseEnd < impactIndex - 1 && track.rateDps[pauseEnd + 1] < PAUSE_DPS) pauseEnd++;

    let peakRateIndex = 0;
    for (let i = 1; i <= impactIndex; i++) {
        if (track.rateDps[i] > track.rateDps[peakRateIndex]) peakRateIndex = i;
    }

    const backswingSec = t(topIndex);
    const downswingSec = t(impactIndex) - t(topIndex);

    return {
        topIndex,
        impactIndex,
        peakRateIndex,
        peakRateDps: track.rateDps[peakRateIndex],
        backswingSec,
        downswingSec,
        transitionPauseSec: t(pauseEnd) - t(pauseStart),
        tempoRatio: downswingSec > 0 ? backswingSec / downswingSec : 0,
    };
}

/**
 * Direction the club turns during the takeaway. t=0 is the takeaway by
 * construction, so a short window just after the club starts moving is a
 * reliable read on which way the backswing goes.
 */
function takeawayAxis(samples: readonly ImuSample[], track: OrientationTrack): Vec3 {
    const n = track.rateDps.length;
    let start = 0;
    while (start < n && track.rateDps[start] < TAKEAWAY_DPS) start++;
    if (start >= n) return v3(0, 1, 0);

    const end = Math.min(n, start + Math.max(4, samplesFor(samples, TAKEAWAY_WINDOW_SEC)));
    let sum = v3(0, 0, 0);
    for (let i = start; i < end; i++) sum = add(sum, track.omegaWorld[i]);
    return normalize(sum);
}

function samplesFor(samples: readonly ImuSample[], seconds: number): number {
    if (samples.length < 2) return 1;
    const span = samples[samples.length - 1].t - samples[0].t;
    const rate = span > 0 ? (samples.length - 1) / span : 400;
    return Math.max(1, Math.round(seconds * rate));
}
