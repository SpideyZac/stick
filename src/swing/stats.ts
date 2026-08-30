import { type Club, effectiveShaftLength } from "../data/clubs";
import type { ImuSample } from "../imu/types";
import { fitPlane } from "../math/plane";
import { type Vec3, angleBetween, len, v3 } from "../math/vec3";
import { WORLD_UP, horizontalAngle, toDeg, wrapAngle } from "./frames";
import { clubheadOffset, clubheadVelocity, faceNormal } from "./kinematics";
import type { GripTrack } from "./grip";
import type { OrientationTrack } from "./orient";
import type { Phases } from "./phases";

/**
 * Contact shocks the gyro for a sample or two, so the last samples before impact
 * are the last trustworthy ones. But the club is turning at nearly 2000 degrees
 * per second, which is well over two degrees of face angle per sample, so simply
 * reading a few samples early costs more than the shock would.
 *
 * Instead we fit the angular velocity over a clean window that stops short of
 * contact and run it forward to the strike. Over ten milliseconds the downswing
 * is near enough linear for that to hold, and it keeps every number reported at
 * the same instant.
 */
const SHOCK_BACKOFF = 2;
const FIT_SPAN = 5;

export interface SwingStats {
    backswingSec: number;
    downswingSec: number;
    transitionPauseSec: number;
    tempoRatio: number;
    peakRateDps: number;
    peakRateSec: number;
    impactSec: number;

    clubheadSpeedMps: number;
    swingPlaneDeg: number;
    attackAngleDeg: number;
    /** Where the face points at impact, relative to the address target line. */
    faceAngleDeg: number;
    /** Where the clubhead is travelling at impact, same reference. */
    pathAngleDeg: number;
    /** Face minus path. This is what curves the ball, not face to target. */
    faceToPathDeg: number;
}

export function computeStats(
    samples: readonly ImuSample[],
    track: OrientationTrack,
    phases: Phases,
    club: Club,
    grip: GripTrack,
): SwingStats {
    const shaft = effectiveShaftLength(club);
    const i = phases.impactIndex;
    const t0 = samples[0].t;

    const omega = omegaAtImpact(track.omegaWorld, i);
    const offset = clubheadOffset(track.q[i], shaft);
    // The hands are still travelling at contact, so the clubhead carries their
    // velocity on top of its own rotation about them.
    const velocity = clubheadVelocity(omega, offset, grip.velocity[i]);
    const face = faceNormal(track.q[i]);

    const horizontal = Math.hypot(velocity.x, velocity.z);
    const faceAngle = horizontalAngle(face);
    const pathAngle = horizontalAngle(velocity);

    return {
        backswingSec: phases.backswingSec,
        downswingSec: phases.downswingSec,
        transitionPauseSec: phases.transitionPauseSec,
        tempoRatio: phases.tempoRatio,
        peakRateDps: phases.peakRateDps,
        peakRateSec: samples[phases.peakRateIndex].t - t0,
        impactSec: samples[phases.impactIndex].t - t0,

        clubheadSpeedMps: len(velocity),
        swingPlaneDeg: swingPlane(track, phases, shaft),
        attackAngleDeg: toDeg(Math.atan2(velocity.y, horizontal)),
        faceAngleDeg: toDeg(faceAngle),
        pathAngleDeg: toDeg(pathAngle),
        faceToPathDeg: toDeg(wrapAngle(faceAngle - pathAngle)),
    };
}

/**
 * Angle of the downswing plane off the ground. Fitted to the clubhead track
 * rather than assumed from the club, so a flat or steep swing shows up as one.
 */
function swingPlane(track: OrientationTrack, phases: Phases, shaft: number): number {
    const points: Vec3[] = [];
    for (let i = phases.topIndex; i <= phases.impactIndex; i++) {
        points.push(clubheadOffset(track.q[i], shaft));
    }
    if (points.length < 3) return 0;
    const { normal } = fitPlane(points);
    // Fold onto [0, 90]. The normal has no meaningful sign here.
    const a = toDeg(angleBetween(normal, WORLD_UP));
    return a > 90 ? 180 - a : a;
}

/**
 * Angular velocity at contact, fitted from the clean samples leading up to it.
 * Least squares on each component, then evaluated at the impact index.
 */
function omegaAtImpact(omega: readonly Vec3[], impact: number): Vec3 {
    const hi = impact - SHOCK_BACKOFF;
    const lo = hi - FIT_SPAN + 1;
    if (lo < 0 || hi < 1) return omega[Math.max(0, Math.min(omega.length - 1, impact))];

    return v3(
        extrapolate(omega, lo, hi, impact, (w) => w.x),
        extrapolate(omega, lo, hi, impact, (w) => w.y),
        extrapolate(omega, lo, hi, impact, (w) => w.z),
    );
}

function extrapolate(
    omega: readonly Vec3[],
    lo: number,
    hi: number,
    at: number,
    pick: (w: Vec3) => number,
): number {
    const n = hi - lo + 1;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumXX = 0;
    for (let i = lo; i <= hi; i++) {
        const y = pick(omega[i]);
        sumX += i;
        sumY += y;
        sumXY += i * y;
        sumXX += i * i;
    }
    const denominator = n * sumXX - sumX * sumX;
    if (Math.abs(denominator) < 1e-12) return sumY / n;
    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;
    return slope * at + intercept;
}
