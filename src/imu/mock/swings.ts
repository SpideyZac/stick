import { getClub } from "../../data/clubs";
import { v3 } from "../../math/vec3";
import type { Handedness } from "../../swing/frames";
import { type SwingParams, type SynthResult, synthesizeSwing } from "./synth";

export type SwingId =
    "good" | "flush" | "slice" | "hook" | "waggle" | "topped" | "thin" | "fat" | "toe" | "heel";

/**
 * A steady mid iron swing. Everything else is this with a few numbers moved, so
 * differences between the canned swings are only ever the thing being modelled.
 */
const BASE: SwingParams = {
    club: getClub("7i"),
    hand: "right",
    lieDeg: 62,
    planeYawDeg: 0,
    faceRollDeg: 0,
    impactLagDeg: 3,
    preRollSec: 0.6,
    settleSec: 0.7,
    backswingSec: 0.78,
    pauseSec: 0.05,
    downswingSec: 0.3,
    followSec: 0.5,
    sweepDeg: 190,
    waggles: [],
    verticalDriftM: 0,
    lateralDriftM: 0,
    // A real BMI270 turns up with a degree or two of bias on each axis. Left in
    // the mock on purpose, removing it is the biggest single win on drift.
    gyroBiasDps: v3(1.4, -0.9, 2.1),
    gyroNoiseDps: 0.5,
    accelNoiseG: 0.02,
    // Real accelerometers turn up with tens of milli-g of bias. Left in so the
    // velocity integration has to earn its accuracy.
    accelBiasG: v3(0.003, -0.004, 0.003),
    seed: 7,
};

export const SWING_PRESETS: Record<SwingId, SwingParams> = {
    // Square face, path just barely in to out. An easy, unhurried swing.
    good: { ...BASE, planeYawDeg: 1.8, faceRollDeg: -1.2, seed: 11 },

    // Flushed 7 iron at about 80 mph, which is where a decent 10 to 20 handicap
    // lands, carrying roughly 155 yards. Same square face as `good`, just quicker
    // through the ball and on a textbook three to one tempo.
    //
    // This one only works because the hands are modelled. Getting 80 mph out of a
    // fixed grip would need over 2300 dps at the sensor, past what the BMI270 can
    // report at all, so the number would be a lie before it ever reached the maths.
    flush: {
        ...BASE,
        planeYawDeg: 1.8,
        faceRollDeg: -1.2,
        backswingSec: 0.92,
        downswingSec: 0.28,
        sweepDeg: 205,
        seed: 17,
    },

    // Out to in path with the face open to it. Steep, which is what slicers do.
    slice: { ...BASE, planeYawDeg: 7, faceRollDeg: 7, seed: 23 },

    // In to out path with the face shut to it. Shallow, which is what hookers do.
    hook: { ...BASE, planeYawDeg: -7, faceRollDeg: -9, seed: 41 },

    // Same swing as `good`, but the golfer waggles three times first. The last one
    // is deliberately big and slow enough to survive the fast confirmation checks,
    // so something later has to throw it out.
    waggle: {
        ...BASE,
        planeYawDeg: 1.8,
        faceRollDeg: -1.2,
        settleSec: 1.8,
        seed: 11,
        waggles: [
            { atSec: 0.15, peakDps: 110, durSec: 0.18 },
            { atSec: 0.55, peakDps: 110, durSec: 0.32 },
            { atSec: 1.0, peakDps: 150, durSec: 0.5 },
        ],
    },

    // The next five all mis-hit the ball through real geometry: verticalDriftM and
    // lateralDriftM shift where the swing hub sits through the downswing, which
    // shifts the whole grip arc and, with it, the clubhead's real closest-approach
    // point to the ball. src/swing/strike.ts discovers the resulting strike zone
    // from the noisy IMU stream the same way it would from a real sensor, nothing
    // here sets the strike location directly.

    // Standing up out of the shot. The arc rises through impact and the leading
    // edge catches the ball above its equator: a genuine topped strike.
    //
    // These drift magnitudes are deliberately large. A grip-mounted BMI270 and
    // roughly a second of dead-reckoning through it cannot place the clubhead to
    // better than a few centimeters (see NOISE_FLOOR_M in strike.ts), so a
    // mis-hit preset has to move the real swing arc well past that noise floor
    // to reconstruct as its intended zone reliably, not just on average.
    topped: {
        ...BASE,
        planeYawDeg: 1.8,
        faceRollDeg: -1.2,
        verticalDriftM: 0.105,
        seed: 53,
    },

    // The same fault, milder. Catches the ball a little high on the face rather
    // than off the leading edge entirely.
    thin: {
        ...BASE,
        planeYawDeg: 1.8,
        faceRollDeg: -1.2,
        verticalDriftM: 0.078,
        seed: 59,
    },

    // The arc's low point comes early, the heuristic stand-in for hitting behind
    // the ball. There is no turf model here, see the highLowM comment in strike.ts.
    fat: {
        ...BASE,
        planeYawDeg: 1.8,
        faceRollDeg: -1.2,
        verticalDriftM: -0.09,
        seed: 61,
    },

    // Early extension toward the ball, catching it out near the toe.
    toe: {
        ...BASE,
        planeYawDeg: 1.8,
        faceRollDeg: -1.2,
        lateralDriftM: 0.082,
        seed: 67,
    },

    // Standing up and away from the ball, catching it in toward the heel.
    heel: {
        ...BASE,
        planeYawDeg: 1.8,
        faceRollDeg: -1.2,
        lateralDriftM: -0.093,
        seed: 74,
    },
};

export const SWING_LABELS: Record<SwingId, string> = {
    good: "Good swing",
    flush: "Flushed 7 iron, 80 mph",
    slice: "Slice tendency",
    hook: "Hook tendency",
    waggle: "Waggle then swing",
    topped: "Topped 7 iron",
    thin: "Thin strike",
    fat: "Fat / chunked strike",
    toe: "Toe strike",
    heel: "Heel strike",
};

export const SWING_IDS = Object.keys(SWING_PRESETS) as SwingId[];

const cache = new Map<string, SynthResult>();

/** Synthesis is deterministic, so the same club, hand, and swing only gets built once. */
export function getSwing(id: SwingId, clubId?: string, hand: Handedness = "right"): SynthResult {
    const key = `${id}:${clubId ?? BASE.club.id}:${hand}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const preset = SWING_PRESETS[id];
    const built = synthesizeSwing({
        ...preset,
        ...(clubId ? { club: getClub(clubId) } : {}),
        hand,
    });
    cache.set(key, built);
    return built;
}
