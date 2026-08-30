import { BALL_RADIUS_M } from "../data/ball";
import type { Club } from "../data/clubs";
import {
    type QuadraticFit,
    evalLinear,
    evalQuadratic,
    evalQuadraticDeriv,
    linearFit,
    quadraticFit,
} from "../math/fit";
import { type Quat, fromAngularRate, mul, normalize as qnormalize, rotate } from "../math/quat";
import { type Vec3, add, cross, dot, len, normalize, reject, sub, v3 } from "../math/vec3";
import { FACE_NORMAL_S, WORLD_UP, type Handedness } from "./frames";
import { FIT_SPAN, SHOCK_BACKOFF } from "./stats";

const NEWTON_ITERATIONS = 4;

export type StrikeZone = "center" | "toe" | "heel" | "thin" | "top" | "fat" | "whiff";

export interface StrikeLocation {
    /** Fixed world position of the ball, wherever the clubhead rested at address. */
    ballPosition: Vec3;
    /** The clubhead's true closest-approach point to the ball. */
    contactPoint: Vec3;
    /** Time of closest approach, sub-sample precision. */
    contactSec: number;
    /** Clubhead orientation at the moment of closest approach. */
    faceQuat: Quat;
    /**
     * Offset across the face, heel to toe, with NOISE_FLOOR_M of leeway already
     * credited back toward zero. This, not rawHeelToeM, is what classification,
     * ball flight, and the UI use. Positive is toe.
     */
    heelToeM: number;
    /**
     * Offset across the face, sole to top edge, leeway applied, in the "contact
     * minus ball" sense. Positive means the clubhead was riding high and only
     * reached the ball near the bottom of the face or the leading edge, a thin
     * or topped strike. Negative is the heuristic stand-in for a fat/chunked
     * strike (there is no turf sensing here, so this direction is an
     * approximation, unlike the other three). See rawHighLowM for the number
     * before leeway.
     */
    highLowM: number;
    /** Euclidean offset between the contact point and the ball, leeway applied. */
    offCenterM: number;
    /** heelToeM before NOISE_FLOOR_M leeway: the actual reconstructed geometry. */
    rawHeelToeM: number;
    /** highLowM before leeway. */
    rawHighLowM: number;
    /** offCenterM before leeway. */
    rawOffCenterM: number;
    /** Offset along the face normal, diagnostic only, no leeway applied. */
    faceNormalM: number;
    /** heelToeM normalized by half the face width. */
    faceHitFracX: number;
    /** highLowM normalized by half the face height. */
    faceHitFracY: number;
    /** False when the raw offset is beyond the face and ball envelope: a whiff. */
    contactMade: boolean;
    zone: StrikeZone;
}

/**
 * How far off the ball this pipeline's own reconstruction can land even for a
 * genuinely centered strike, purely from integrating a BMI270-class IMU through
 * roughly a second of swing: a degree or two of orientation error alone moves
 * the clubhead tip several centimeters at the end of an iron's shaft, on top of
 * whatever the grip's own integrated position has drifted. Measured directly
 * against this pipeline's reconstruction of otherwise-clean mock swings, the
 * worst case observed was a bit over 6cm. Offsets inside this floor are credited
 * back toward zero before classification: real sensor leeway, not a bug being
 * hidden. Mis-hit presets are built to clear it with real margin (see swings.ts).
 */
const NOISE_FLOOR_M = 0.065;

/** Offset with NOISE_FLOOR_M of leeway credited back toward zero. */
const credit = (raw: number): number => Math.sign(raw) * Math.max(0, Math.abs(raw) - NOISE_FLOOR_M);

const clampNum = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

const quadraticPoint = (fx: QuadraticFit, fy: QuadraticFit, fz: QuadraticFit, t: number): Vec3 =>
    v3(evalQuadratic(fx, t), evalQuadratic(fy, t), evalQuadratic(fz, t));

const quadraticVelocity = (fx: QuadraticFit, fy: QuadraticFit, fz: QuadraticFit, t: number): Vec3 =>
    v3(evalQuadraticDeriv(fx, t), evalQuadraticDeriv(fy, t), evalQuadraticDeriv(fz, t));

/** Where zone boundaries fall, as a fraction of half the face dimension. */
const TOP_FRAC = 0.9;
const THIN_FRAC = 0.4;
const FAT_FRAC = 0.5;
const LATERAL_FRAC = 0.4;

/**
 * A real mis-hit rarely stays cleanly on one axis: a strike that is badly off
 * one way is very often somewhat off the other way too. Rather than always
 * reading the vertical axis first, this picks whichever axis is furthest past
 * its own threshold (normalized by that threshold, so "just past" on one axis
 * never beats "well past" on the other), and only falls back to the milder
 * thin/fat calls when nothing has cleared a hard zone.
 */
function classifyZone(fracX: number, fracY: number, contactMade: boolean): StrikeZone {
    if (!contactMade) return "whiff";

    const verticalSeverity = fracY >= 0 ? fracY / TOP_FRAC : -fracY / FAT_FRAC;
    const lateralSeverity = Math.abs(fracX) / LATERAL_FRAC;

    if (verticalSeverity >= 1 || lateralSeverity >= 1) {
        return verticalSeverity >= lateralSeverity
            ? fracY >= 0
                ? "top"
                : "fat"
            : fracX >= 0
              ? "toe"
              : "heel";
    }
    if (fracY > THIN_FRAC) return "thin";
    return "center";
}

/**
 * Ball position, fixed for the whole swing: one radius above wherever the
 * clubhead rested at address, same x/z. This formalizes what the replay
 * (src/three/scene.ts) already assumed about where the ball sits.
 */
export function ballPosition(clubheadPath: readonly Vec3[]): Vec3 {
    return add(clubheadPath[0], v3(0, BALL_RADIUS_M, 0));
}

/**
 * Where on the clubface the ball was actually struck.
 *
 * Impact detection elsewhere in the pipeline is sample precision only, and the
 * sample or two right at contact has a shocked gyro, so this follows the same
 * pattern stats.ts uses for angular velocity at impact: fit a clean window that
 * stops short of contact, then run it forward. Here that means fitting the
 * clubhead's own position against time and finding where that line comes
 * closest to the ball, which buys sub-sample timing precision nothing else in
 * this codebase has.
 */
export function computeStrikeLocation(
    clubheadPath: readonly Vec3[],
    times: readonly number[],
    q: readonly Quat[],
    omegaWorld: readonly Vec3[],
    impactIndex: number,
    club: Club,
    hand: Handedness,
): StrikeLocation {
    const ball = ballPosition(clubheadPath);
    const hi = impactIndex - SHOCK_BACKOFF;
    const lo = hi - FIT_SPAN + 1;

    let contactPoint: Vec3;
    let contactSec: number;
    let faceQuat: Quat;

    if (lo < 0 || hi < 1) {
        const i = Math.max(0, Math.min(clubheadPath.length - 1, impactIndex));
        contactPoint = clubheadPath[i];
        contactSec = times[i];
        faceQuat = q[i];
    } else {
        const ts: number[] = [];
        const xs: number[] = [];
        const ys: number[] = [];
        const zs: number[] = [];
        const wxs: number[] = [];
        const wys: number[] = [];
        const wzs: number[] = [];
        for (let i = lo; i <= hi; i++) {
            ts.push(times[i]);
            xs.push(clubheadPath[i].x);
            ys.push(clubheadPath[i].y);
            zs.push(clubheadPath[i].z);
            wxs.push(omegaWorld[i].x);
            wys.push(omegaWorld[i].y);
            wzs.push(omegaWorld[i].z);
        }

        // The clubhead is on a fast, curved arc this close to impact, curved enough
        // that a straight-line fit of position against time drifts off the true path
        // by a centimeter or more over just a few milliseconds. A parabola (constant
        // curvature) tracks it far better, so position is fit quadratically and the
        // closest-approach time is refined with a few Newton steps on that curve,
        // seeded from the straight-line estimate.
        const fx = quadraticFit(ts, xs);
        const fy = quadraticFit(ts, ys);
        const fz = quadraticFit(ts, zs);

        const lx = linearFit(ts, xs);
        const ly = linearFit(ts, ys);
        const lz = linearFit(ts, zs);
        const a = v3(lx.intercept, ly.intercept, lz.intercept);
        const b = v3(lx.slope, ly.slope, lz.slope);
        const bb = dot(b, b);
        const hiTime = times[hi];
        let tStar = bb > 1e-9 ? dot(b, sub(ball, a)) / bb : hiTime;

        const clampHiIndex = Math.min(clubheadPath.length - 1, impactIndex + 3);
        const tLo = times[lo];
        const tHi = times[clampHiIndex];
        tStar = clampNum(tStar, tLo, tHi);

        for (let iter = 0; iter < NEWTON_ITERATIONS; iter++) {
            const p = quadraticPoint(fx, fy, fz, tStar);
            const v = quadraticVelocity(fx, fy, fz, tStar);
            const e = sub(p, ball);
            const accel = v3(2 * fx.c, 2 * fy.c, 2 * fz.c);
            const dD = 2 * dot(e, v);
            const ddD = 2 * (dot(v, v) + dot(e, accel));
            if (Math.abs(ddD) < 1e-9) break;
            tStar = clampNum(tStar - dD / ddD, tLo, tHi);
        }

        contactPoint = quadraticPoint(fx, fy, fz, tStar);
        contactSec = tStar;

        const omegaAtStar = v3(
            evalLinear(linearFit(ts, wxs), tStar),
            evalLinear(linearFit(ts, wys), tStar),
            evalLinear(linearFit(ts, wzs), tStar),
        );
        const dt = tStar - hiTime;
        faceQuat = qnormalize(mul(q[hi], fromAngularRate(omegaAtStar, dt)));
    }

    const d = sub(contactPoint, ball);
    const faceNormal = rotate(faceQuat, FACE_NORMAL_S);
    const vertical = normalize(reject(WORLD_UP, faceNormal));
    const lateral = cross(vertical, faceNormal);

    const rawHighLowM = dot(d, vertical);
    const rawHeelToeM = dot(d, lateral) * (hand === "right" ? 1 : -1);
    const faceNormalM = dot(d, faceNormal);
    const rawOffCenterM = len(d);

    const highLowM = credit(rawHighLowM);
    const heelToeM = credit(rawHeelToeM);
    const offCenterM = Math.hypot(heelToeM, highLowM);

    const faceHitFracX = heelToeM / (club.faceWidth / 2);
    const faceHitFracY = highLowM / (club.faceHeight / 2);
    // Leeway applies here too: whether contact was physically possible is a
    // question about the real offset, and the noise floor is exactly the part of
    // the raw number that is not trustworthy as "real."
    const envelope = Math.hypot(club.faceWidth / 2, club.faceHeight / 2) + BALL_RADIUS_M * 0.6;
    const contactMade = offCenterM <= envelope;

    const zone = classifyZone(faceHitFracX, faceHitFracY, contactMade);

    return {
        ballPosition: ball,
        contactPoint,
        contactSec,
        faceQuat,
        heelToeM,
        highLowM,
        offCenterM,
        rawHeelToeM,
        rawHighLowM,
        rawOffCenterM,
        faceNormalM,
        faceHitFracX,
        faceHitFracY,
        contactMade,
        zone,
    };
}
