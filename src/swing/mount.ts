import type { ImuSample } from "../imu/types";
import {
    type Quat,
    IDENTITY,
    fromAngularRate,
    fromBasis,
    mul,
    normalize as qnormalize,
    rotate,
} from "../math/quat";
import {
    type Vec3,
    add,
    addScaled,
    cross,
    dot,
    len,
    normalize,
    reject,
    scale,
    v3,
} from "../math/vec3";
import { DEG, GRAVITY, type Handedness, toDeg } from "./frames";

export const MOUNT = {
    /** Rotation, in degrees per second, that counts as the takeaway being under way. */
    takeawayDps: 60,
    /** Plausible band for the shaft angle off the ground at address. */
    lieMinDeg: 40,
    lieMaxDeg: 82,
    /** A still window has to read this close to one g to be worth reading a pose off. */
    gravityTolerance: 0.1,
    /**
     * Bare numerical guard on the cross product that builds the frame. The real
     * judgement is the lie band below, which this angle turns out to equal exactly
     * once the frame is built -- this only stops a degenerate input reaching it.
     */
    minAxisSeparationDeg: 5,
} as const;

export interface Mount {
    /** Rotation taking a chip-frame vector into the pipeline's sensor frame. */
    q: Quat;
    /** Shaft angle off the ground the address pose implied, degrees. */
    lieAngleDeg: number;
    /** Epoch milliseconds when this was learned. */
    ts: number;
}

export interface MountFit {
    mount: Mount | null;
    /** Why it could not be trusted, if it could not. */
    warning: string | null;
}

/**
 * Work out how the sensor is strapped to the club, from one ordinary swing.
 *
 * The pipeline works in a fixed sensor frame (see frames.ts): +Z down the shaft,
 * +X facing the golfer at address, +Y out through the face. The BMI270's own axes
 * are bolted to the StickC's case, so the rotation between the two is a property
 * of the strap and nothing else -- and hand-entering it is a nuisance that has to
 * be redone every time the unit is remounted, and is wrong in a way that is very
 * hard to read back off the numbers.
 *
 * All three axes are recoverable from a swing:
 *
 *   Up.       A still club at address reads gravity, so the accelerometer gives
 *             world up directly, in chip coordinates.
 *
 *   Forward.  A golf swing turns about the swing plane's normal, and at address
 *             that normal is the forward axis: perpendicular to both the shaft
 *             and the target line, which is exactly how +X is defined. So the
 *             axis the club turns about during the takeaway *is* +X, read in the
 *             address pose and needing no integration of position or anything
 *             else that drifts.
 *
 *   The rest. The face is horizontal at address, so it is perpendicular to up as
 *             well as to forward, which pins +Y; and +Z follows to complete the
 *             set. The shaft never has to be identified directly, which is just
 *             as well, because it is the axis a strapped-on sensor is least
 *             likely to line up with.
 *

 * Two things this cannot get from the physics alone.
 *
 * Which way along the swing axis counts as "toward the golfer", because a lefty's
 * backswing turns the opposite way about the same plane. That comes from the
 * handedness setting, which the app already asks for and everything downstream
 * already depends on.
 *
 * And where the target line actually points. Yaw about vertical is unobservable
 * without a magnetometer, so the azimuth of the frame has to be assumed from
 * something, and what it is assumed from here is that the swing that taught it
 * was swung down the target line. A swing taught on a seven degree out-to-in
 * plane therefore reads about seven degrees closer to square on path forever
 * after, and face-to-path follows it. The old code made the same class of
 * assumption -- frames.ts has always taken the golfer to be square at address --
 * it just took its azimuth from how the sensor happened to be clipped on rather
 * than from a swing. Neither is a measurement; this one at least comes off the
 * club. Learn it from a swing that feels normal, and relearn it if the
 * strap moves.
 */
export function fitMount(
    samples: readonly ImuSample[],
    still: readonly ImuSample[],
    hand: Handedness,
    now = Date.now(),
): MountFit {
    if (still.length < 8 || samples.length < 16) {
        return fail("Not enough of that swing to read a mount off. Try again.");
    }

    const address = mean(still.map(accelOf));
    const g = len(address) / GRAVITY;
    if (Math.abs(g - 1) > MOUNT.gravityTolerance) {
        return fail(
            `The club read ${g.toFixed(2)}g while settling instead of 1g. Ground it, hold still, then swing.`,
        );
    }
    const upC = normalize(address);
    const bias = mean(still.map(gyroOf));

    const swing = swingAxis(samples, bias);
    if (!swing) {
        return fail("Couldn't find a takeaway in that. Settle over the ball first, then swing.");
    }

    // A lefty's backswing turns the opposite way about the same plane, so the axis
    // is the same line and only its direction differs.
    const forwardC = hand === "right" ? swing : scale(swing, -1);

    const separationDeg = toDeg(Math.acos(Math.min(1, Math.abs(dot(forwardC, upC)))));
    if (separationDeg < MOUNT.minAxisSeparationDeg) {
        return fail(
            "That swing turned about a near-vertical axis, which is not a golf swing. Make a normal one.",
        );
    }

    // The face is horizontal at address, so it is square to both up and forward.
    // Building +Y from those two and taking the rest from it means the shaft axis
    // is never estimated directly, only derived.
    const y = normalize(cross(forwardC, upC));
    const x = normalize(reject(forwardC, y));
    const z = cross(x, y);
    const q = fromBasis(x, y, z);

    // Read the address pose back through the frame just built. The shaft has to
    // come out pointing at the ground somewhere a real club could sit, and if it
    // does not then one of the two inputs was not what it was taken to be.
    const upS = rotate(q, upC);
    const lieAngleDeg = toDeg(Math.asin(clamp(-upS.z, -1, 1)));
    if (lieAngleDeg < MOUNT.lieMinDeg || lieAngleDeg > MOUNT.lieMaxDeg) {
        return fail(
            `That works out to a shaft ${lieAngleDeg.toFixed(0)} degrees off the ground, which is not a grounded club. Ground it at address before you swing.`,
        );
    }

    return { mount: { q, lieAngleDeg, ts: now }, warning: null };
}

/** Put a stream into the pipeline's sensor frame. A null mount passes it through. */
export function applyMount(samples: readonly ImuSample[], mount: Mount | null): ImuSample[] {
    if (!mount) return samples as ImuSample[];
    return samples.map((s) => {
        const a = rotate(mount.q, v3(s.ax, s.ay, s.az));
        const w = rotate(mount.q, v3(s.gx, s.gy, s.gz));
        return { t: s.t, ax: a.x, ay: a.y, az: a.z, gx: w.x, gy: w.y, gz: w.z };
    });
}

/**
 * The axis the club turns about through the backswing, in the address pose's own
 * coordinates.
 *
 * Averaging raw gyro over a window would be wrong: the sensor is turning while it
 * measures, so an axis that is genuinely fixed in the world sweeps across the
 * chip's own axes as the swing goes on, and the average would land somewhere in
 * the middle of that sweep. So the gyro is integrated from t=0 and each reading
 * is carried back into the address frame before being added in. That makes the
 * whole backswing usable rather than only its first few samples, which is worth a
 * lot: it is the difference between averaging over a dozen noisy samples and over
 * several hundred.
 */
function swingAxis(samples: readonly ImuSample[], bias: Vec3): Vec3 | null {
    const n = samples.length;
    const backToAddress: Vec3[] = new Array(n);

    let q = IDENTITY;
    for (let i = 0; i < n; i++) {
        const w = sub3(gyroOf(samples[i]), bias);
        // q carries a vector from the pose at sample i back into the pose at t=0.
        backToAddress[i] = rotate(q, w);
        if (i + 1 < n) {
            const dt = samples[i + 1].t - samples[i].t;
            q = qnormalize(mul(q, fromAngularRate(w, dt)));
        }
    }

    const threshold = MOUNT.takeawayDps * DEG;
    let start = 0;
    while (start < n && len(backToAddress[start]) < threshold) start++;
    if (start >= n) return null;

    // Seed off the first moments of the takeaway, which are unambiguously the
    // backswing, then keep taking everything still turning the same way.
    let seed = v3(0, 0, 0);
    for (let i = start; i < Math.min(n, start + 16); i++) seed = add(seed, backToAddress[i]);
    if (len(seed) === 0) return null;
    seed = normalize(seed);

    // Rate weighted, so the quick middle of the backswing counts for more than the
    // slow, noisy ends of it.
    let sum = v3(0, 0, 0);
    let used = 0;
    for (let i = start; i < n; i++) {
        const w = backToAddress[i];
        if (dot(w, seed) <= 0) break; // over the top; the downswing runs the other way
        sum = addScaled(sum, w, len(w));
        used++;
    }
    if (used < 8 || len(sum) === 0) return null;
    return normalize(sum);
}

const accelOf = (s: ImuSample): Vec3 => v3(s.ax, s.ay, s.az);
const gyroOf = (s: ImuSample): Vec3 => v3(s.gx, s.gy, s.gz);
const sub3 = (a: Vec3, b: Vec3): Vec3 => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function mean(vs: Vec3[]): Vec3 {
    let sum = v3(0, 0, 0);
    for (const v of vs) sum = add(sum, v);
    return scale(sum, 1 / Math.max(1, vs.length));
}

const fail = (warning: string): MountFit => ({ mount: null, warning });
