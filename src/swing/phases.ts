import type { ImuSample } from "../imu/types";
import { type Vec3, add, dot, normalize, v3 } from "../math/vec3";
import type { OrientationTrack } from "./orient";

/** Below this the club counts as paused at the top. */
const PAUSE_DPS = 45;
/** Enough motion to count as under way, matching the detector. */
const TAKEAWAY_DPS = 60;

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

/**
 * Split a captured swing into backswing, transition, and downswing.
 *
 * The top of the backswing is where rotation about the backswing axis crosses
 * zero, which is a cleaner marker than looking for a dip in raw magnitude. Raw
 * magnitude has a minimum at the top too, but it is shallow and noisy, whereas
 * the sign change is unambiguous.
 */
export function segment(
    samples: readonly ImuSample[],
    track: OrientationTrack,
    impactIndex: number,
): Phases {
    const t = (i: number) => samples[i].t - samples[0].t;

    // Which way "back" is, taken from the takeaway itself. It has to come from
    // here and not from the fastest point of the capture, because the downswing is
    // several times quicker than the backswing and would win that comparison.
    const backAxis = takeawayAxis(track, impactIndex);
    const projected = track.omegaWorld.map((w) => dot(w, backAxis));

    // Fastest point of the backswing, measured along that axis so the downswing,
    // which projects negative, cannot be mistaken for it.
    let backPeak = 0;
    for (let i = 1; i < impactIndex; i++) {
        if (projected[i] > projected[backPeak]) backPeak = i;
    }

    // The top is the first time that rotation reverses.
    let topIndex = backPeak;
    for (let i = backPeak; i < impactIndex; i++) {
        if (projected[i] <= 0) {
            topIndex = i;
            break;
        }
    }

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
function takeawayAxis(track: OrientationTrack, impactIndex: number): Vec3 {
    let start = 0;
    while (start < impactIndex && track.rateDps[start] < TAKEAWAY_DPS) start++;

    const end = Math.min(impactIndex, start + Math.max(4, Math.round(impactIndex * 0.1)));
    let sum = v3(0, 0, 0);
    for (let i = start; i < end; i++) sum = add(sum, track.omegaWorld[i]);
    return normalize(sum);
}
