import { BALL } from "../data/ball";
import type { Club } from "../data/clubs";
import { type Vec3, addScaled, cross, len, normalize, rotateAbout, v3 } from "../math/vec3";
import { DEG, GRAVITY, type Handedness, WORLD_UP } from "../swing/frames";
import type { StrikeLocation } from "../swing/strike";
import type { SwingStats } from "../swing/stats";

// The air a golf ball flies through. Fixed on purpose, none of this is worth
// exposing as a setting.
const AIR_DENSITY = 1.225;
const AREA = (Math.PI * BALL.diameterM * BALL.diameterM) / 4;
const FORCE_K = (0.5 * AIR_DENSITY * AREA) / BALL.massKg;

// Both coefficients rise with the spin ratio, spin surface speed over airspeed.
// Modelling that rather than fixing them matters: a low spin long iron launches
// much flatter than a wedge, and constant coefficients would leave it with more
// lift than it earns and rob it of the carry it should get.
const LIFT_PER_SPIN_RATIO = 1.0;
const MAX_LIFT_COEFFICIENT = 0.33;
const BASE_DRAG = 0.21;
const DRAG_PER_SPIN_RATIO = 0.25;

/** Ball starts closer to where the face points than where the club is moving. */
const FACE_WEIGHT = 0.85;
/** Degrees of spin axis tilt per degree of face to path. */
const SPIN_AXIS_PER_DEGREE = 3.5;
// Widened from the plain face-to-path 40 degree cap to leave room for gear
// effect (below) stacking on top of the curve a mis-hit already has.
const MAX_SPIN_AXIS = 60;
/** Rough backspin from dynamic loft. Enough to size the lift, no more. */
const SPIN_PER_LOFT_RPM = 220;
/** Floor so a near-topped ball still has some backspin rather than none. */
const MIN_BACKSPIN_RPM = 150;

/**
 * Off-center strikes lose ball speed faster than a linear falloff, the way a
 * real moment-of-inertia loss does: small misses barely cost anything, big
 * ones fall off a cliff. These are the quadratic (and, near the leading edge,
 * cubic) coefficients for that falloff, tuned to feel right rather than
 * measured off real launch monitor data.
 */
const LATERAL_SMASH_LOSS = 0.28;
const VERTICAL_SMASH_LOSS_HIGH = 0.35;
const VERTICAL_SMASH_LOSS_LOW = 0.5;
/** Where "high on the face, toward the top edge" turns into a real cliff. */
const LEADING_EDGE_FRAC = 0.6;
const LEADING_EDGE_KICKER = 6;

/** How much loft a strike keeps, per unit of high/low face offset. */
const LOFT_LOSS_HIGH = 1.15;
const LOFT_LOSS_LOW = 0.25;

/** Degrees of spin axis tilt a fully-off-center toe or heel strike adds. */
const GEAR_EFFECT_DEG = 12;

const STEP = 0.001;
const MAX_FLIGHT_SEC = 15;

export type ShotShape = "straight" | "draw" | "fade" | "hook" | "slice" | "whiff";

export interface BallFlight {
    dynamicLoftDeg: number;
    launchAngleDeg: number;
    /** Horizontal direction the ball starts on, relative to the target line. */
    startDirectionDeg: number;
    ballSpeedMps: number;
    backspinRpm: number;
    /** Positive tilts the ball right, negative left. */
    spinAxisDeg: number;
    carryM: number;
    /** Sideways miss at landing. Positive right, negative left. */
    offlineM: number;
    apexM: number;
    shape: ShotShape;
    /** Sampled trajectory for drawing, world coordinates. */
    path: Vec3[];
}

/**
 * A reasonable estimate, not a launch monitor.
 *
 * We have no spin data, so face to path stands in for the spin axis. That is the
 * right proxy: face to path is what actually curves a golf ball, and it is the
 * one thing a grip mounted gyro can see clearly.
 *
 * Strike location modulates all of this on top of the clean-contact numbers
 * above: off-center contact loses ball speed and loft, contact near the top of
 * the face or the leading edge collapses both toward nothing (a topped shot),
 * and toe or heel contact adds gear-effect sidespin opposite the miss.
 */
export function estimateFlight(
    stats: SwingStats,
    club: Club,
    strike: StrikeLocation,
    hand: Handedness,
): BallFlight {
    if (strike.zone === "whiff") return whiffedFlight();

    // + is toward the top of the face / leading edge (thin, then topped).
    // - is the heuristic fat/chunk direction, see StrikeLocation.highLowM.
    const ny = strike.faceHitFracY;
    // + is toe, - is heel.
    const nx = strike.faceHitFracX;

    const lateralLoss = LATERAL_SMASH_LOSS * nx * nx;
    const verticalLoss =
        ny >= 0
            ? VERTICAL_SMASH_LOSS_HIGH * ny * ny +
              LEADING_EDGE_KICKER * Math.max(0, ny - LEADING_EDGE_FRAC) ** 3
            : VERTICAL_SMASH_LOSS_LOW * ny * ny;
    const smashRetention = clamp(1 - lateralLoss - verticalLoss, 0.05, 1);

    const loftRetention =
        ny >= 0
            ? clamp(1 - LOFT_LOSS_HIGH * ny, 0.05, 1)
            : clamp(1 - LOFT_LOSS_LOW * Math.abs(ny), 0.4, 1);

    const dynamicLoftDeg = Math.max(0.5, (club.loft + stats.attackAngleDeg) * loftRetention);
    let launchAngleDeg = dynamicLoftDeg * club.launchFactor;
    if (ny > 0.85) {
        // A true top barely gets airborne, no matter what the loft math says.
        launchAngleDeg = Math.min(launchAngleDeg, 2 + (1 - ny) * 10);
    }

    const ballSpeedMps = stats.clubheadSpeedMps * club.smash * smashRetention;
    const backspinRpm = Math.max(MIN_BACKSPIN_RPM, SPIN_PER_LOFT_RPM * dynamicLoftDeg);

    // Toe strikes impart draw-biased gear spin, heel strikes fade-biased, opposite
    // the geometric miss, tapered by how solidly the ball was actually struck.
    const gearSign = hand === "right" ? -1 : 1;
    const gearSpinAxisDeg = gearSign * nx * GEAR_EFFECT_DEG * smashRetention;
    const spinAxisDeg = clamp(
        stats.faceToPathDeg * SPIN_AXIS_PER_DEGREE + gearSpinAxisDeg,
        -MAX_SPIN_AXIS,
        MAX_SPIN_AXIS,
    );
    const startDirectionDeg =
        FACE_WEIGHT * stats.faceAngleDeg + (1 - FACE_WEIGHT) * stats.pathAngleDeg;

    const launch = launchAngleDeg * DEG;
    const start = startDirectionDeg * DEG;
    const velocity = v3(
        ballSpeedMps * Math.cos(launch) * Math.cos(start),
        ballSpeedMps * Math.sin(launch),
        ballSpeedMps * Math.cos(launch) * Math.sin(start),
    );

    const spinRadPerSec = (backspinRpm * 2 * Math.PI) / 60;
    const { path, carryM, offlineM, apexM } = integrate(
        velocity,
        spinAxisDeg * DEG,
        spinRadPerSec * (BALL.diameterM / 2),
    );

    return {
        dynamicLoftDeg,
        launchAngleDeg,
        startDirectionDeg,
        ballSpeedMps,
        backspinRpm,
        spinAxisDeg,
        carryM,
        offlineM,
        apexM,
        shape: classify(offlineM),
        path,
    };
}

/**
 * Forward Euler at 1ms with quadratic drag and a tilted Magnus lift.
 * `spinSurfaceMps` is the speed of the ball's surface due to spin, which is what
 * the spin ratio is measured against.
 */
function integrate(v0: Vec3, spinAxisRad: number, spinSurfaceMps: number) {
    let p = v3(0, 0, 0);
    let v = v0;
    const path: Vec3[] = [p];
    let apexM = 0;

    for (let step = 0; step * STEP < MAX_FLIGHT_SEC; step++) {
        const speed = len(v);
        if (speed < 1e-6) break;

        const vHat = normalize(v);
        // Lift acts across the flight path. Tilting it about the path is what turns
        // backspin into a curve, so this one rotation is the whole shot shape.
        const right = normalize(cross(vHat, WORLD_UP));
        const liftDir = rotateAbout(normalize(cross(right, vHat)), vHat, spinAxisRad);

        const spinRatio = spinSurfaceMps / speed;
        const lift = Math.min(MAX_LIFT_COEFFICIENT, LIFT_PER_SPIN_RATIO * spinRatio);
        const drag = BASE_DRAG + DRAG_PER_SPIN_RATIO * spinRatio;

        let a = v3(0, -GRAVITY, 0);
        a = addScaled(a, vHat, -FORCE_K * drag * speed * speed);
        a = addScaled(a, liftDir, FORCE_K * lift * speed * speed);

        const next = addScaled(p, v, STEP);
        v = addScaled(v, a, STEP);

        if (next.y <= 0 && p.y > 0) {
            // Land exactly on the ground rather than a step past it.
            const f = p.y / (p.y - next.y);
            p = addScaled(p, { x: next.x - p.x, y: next.y - p.y, z: next.z - p.z }, f);
            path.push(p);
            break;
        }

        p = next;
        apexM = Math.max(apexM, p.y);
        // One point every 20ms is plenty to draw a smooth arc.
        if (step % 20 === 0) path.push(p);
    }

    return { path, carryM: p.x, offlineM: p.z, apexM };
}

/** No contact worth calling a shot: the club missed the ball by more than a face and ball width. */
function whiffedFlight(): BallFlight {
    return {
        dynamicLoftDeg: 0,
        launchAngleDeg: 0,
        startDirectionDeg: 0,
        ballSpeedMps: 0,
        backspinRpm: 0,
        spinAxisDeg: 0,
        carryM: 0,
        offlineM: 0,
        apexM: 0,
        shape: "whiff",
        path: [v3(0, 0, 0)],
    };
}

function classify(offlineM: number): ShotShape {
    const yards = offlineM * 1.09361;
    const magnitude = Math.abs(yards);
    if (magnitude < 4) return "straight";
    if (magnitude < 18) return yards > 0 ? "fade" : "draw";
    return yards > 0 ? "slice" : "hook";
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

export const shapeLabel: Record<ShotShape, string> = {
    straight: "Straight",
    draw: "Draw",
    fade: "Fade",
    hook: "Hook",
    slice: "Slice",
    whiff: "Whiff",
};

export const spinAxisSummary = (flight: BallFlight): string =>
    `${Math.abs(flight.spinAxisDeg).toFixed(0)} deg ${flight.spinAxisDeg > 0 ? "right" : "left"}`;
