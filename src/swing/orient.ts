import type { ImuSample } from "../imu/types";
import {
    type Quat,
    fromAngularRate,
    fromTo,
    mul,
    normalize,
    rotate,
    scaleRotation,
} from "../math/quat";
import { type Vec3, len, v3 } from "../math/vec3";
import { type Calibration, accelOf, debias } from "./calibrate";
import { DEG, GRAVITY, WORLD_UP } from "./frames";

export const ZUPT = {
    /** Below this the club is turning slowly enough to trust the accelerometer. */
    rateDps: 30,
    /** And the accelerometer has to be reading close to plain gravity. */
    gravityTolerance: 0.08,
    /** Fraction of the tilt error corrected per sample. Small, so it never jerks. */
    gain: 0.02,
} as const;

export interface OrientationTrack {
    /** Sensor to world, one per sample. */
    q: Quat[];
    /** Bias corrected angular velocity in world coordinates, one per sample. */
    omegaWorld: Vec3[];
    /** Magnitude in degrees per second, kept because almost everything wants it. */
    rateDps: number[];
    /** How many samples got a gravity correction applied. */
    zuptCount: number;
}

/**
 * Turn a bias corrected gyro stream into an orientation track.
 *
 * Integration alone drifts, so wherever the club is briefly both slow and
 * reading plain gravity, which is address and the top of the backswing, we nudge
 * the estimate back toward the direction gravity says is up. The nudge is small
 * and only touches tilt. Yaw is unobservable without a magnetometer, which is
 * why every angle we report is relative to the address frame rather than absolute.
 */
export function integrateOrientation(
    samples: readonly ImuSample[],
    cal: Calibration,
): OrientationTrack {
    const n = samples.length;
    const q: Quat[] = new Array(n);
    const omegaWorld: Vec3[] = new Array(n);
    const rateDps: number[] = new Array(n);
    let zuptCount = 0;

    let cur = cal.addressQuat;

    for (let i = 0; i < n; i++) {
        const s = samples[i];
        const w = debias(s, cal.gyroBias);
        const dps = len(w) / DEG;

        const accel = accelOf(s);
        const gForce = len(accel) / GRAVITY;
        if (dps < ZUPT.rateDps && Math.abs(gForce - 1) < ZUPT.gravityTolerance) {
            // Gravity is visible right now, so pull the tilt back toward it.
            const measuredUp = rotate(cur, accel);
            const correction = scaleRotation(fromTo(measuredUp, WORLD_UP), ZUPT.gain);
            cur = normalize(mul(correction, cur));
            zuptCount++;
        }

        q[i] = cur;
        omegaWorld[i] = rotate(cur, w);
        rateDps[i] = dps;

        if (i + 1 < n) {
            const dt = samples[i + 1].t - s.t;
            // Body frame rate, so the increment goes on the right.
            cur = normalize(mul(cur, fromAngularRate(w, dt)));
        }
    }

    return { q, omegaWorld, rateDps, zuptCount };
}

/** Sample interval implied by a stream, falling back to 400 Hz if it cannot tell. */
export function sampleInterval(samples: readonly ImuSample[]): number {
    if (samples.length < 2) return 1 / 400;
    const span = samples[samples.length - 1].t - samples[0].t;
    return span > 0 ? span / (samples.length - 1) : 1 / 400;
}

export const zeroVec = (): Vec3 => v3(0, 0, 0);
