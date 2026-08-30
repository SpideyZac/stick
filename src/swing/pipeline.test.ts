import { describe, expect, it } from "vitest";
import { getClub } from "../data/clubs";
import { getSwing } from "../imu/mock/swings";
import type { SwingId } from "../imu/mock/swings";
import { SWING_PRESETS } from "../imu/mock/swings";
import { synthesizeSwing, type SwingParams } from "../imu/mock/synth";
import { SwingDetector, type SwingCapture } from "./detect";
import { analyzeSwing } from "./pipeline";

const CLUB = getClub("7i");
const MPH = 2.23694;
const YARDS = 1.09361;

function capture(id: SwingId): SwingCapture {
    const { samples } = getSwing(id);
    let out: SwingCapture | null = null;
    const d = new SwingDetector((c) => (out = c));
    for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8));
    if (!out) throw new Error(`no capture for ${id}`);
    return out;
}

const analyze = (id: SwingId) => analyzeSwing(capture(id), CLUB, "right");

describe("round trip against ground truth", () => {
    // This is the test that proves the chain. The synthesizer knows exactly what
    // face angle, path, and speed it produced. Everything in between, detection,
    // bias, integration, drift, kinematics, has to give those numbers back from
    // nothing but noisy quantized samples.
    for (const id of ["good", "slice", "hook"] as const) {
        it(`recovers the ${id} swing`, () => {
            const { stats } = analyze(id);
            const truth = getSwing(id).truth;

            // One degree is the floor, and it is set by the sensor rather than the
            // maths. A few milli-g of accelerometer bias at address is indistinguishable
            // from a fraction of a degree of tilt, and that tilt carries into every
            // angle measured against the address frame.
            const within = (got: number, want: number, what: string) =>
                expect(Math.abs(got - want), what).toBeLessThan(1);

            within(stats.faceAngleDeg, truth.faceAngleDeg, "face");
            within(stats.pathAngleDeg, truth.pathAngleDeg, "path");
            within(stats.faceToPathDeg, truth.faceToPathDeg, "face to path");
            // Attack angle is the touchiest number here. It is a small vertical
            // component of a large velocity vector, so the same fraction of a percent
            // that leaves speed inside half a metre per second shows up as a degree.
            expect(Math.abs(stats.attackAngleDeg - truth.attackAngleDeg), "attack").toBeLessThan(
                1.5,
            );
            expect(stats.clubheadSpeedMps, "speed").toBeCloseTo(truth.clubheadSpeedMps, 0);
        });
    }

    it("recovers timing", () => {
        const { stats } = analyze("good");
        const truth = getSwing("good").truth;
        expect(stats.backswingSec).toBeCloseTo(truth.backswingSec, 1);
        // Downswing is measured from the top, so it takes in the transition pause.
        expect(stats.downswingSec).toBeGreaterThan(truth.downswingSec);
        expect(stats.downswingSec).toBeLessThan(truth.downswingSec + 0.12);
    });

    it("survives the waggles and still gets the same answer", () => {
        const clean = analyze("good").stats;
        const waggled = analyze("waggle").stats;
        expect(waggled.faceToPathDeg).toBeCloseTo(clean.faceToPathDeg, 0);
        expect(waggled.clubheadSpeedMps).toBeCloseTo(clean.clubheadSpeedMps, 0);
    });
});

describe("swing stats", () => {
    it("reports a tempo near the classic three to one", () => {
        const { stats } = analyze("good");
        expect(stats.tempoRatio).toBeGreaterThan(1.8);
        expect(stats.tempoRatio).toBeLessThan(3.6);
    });

    it("finds a pause at the top", () => {
        const { stats } = analyze("good");
        expect(stats.transitionPauseSec).toBeGreaterThan(0);
        expect(stats.transitionPauseSec).toBeLessThan(0.35);
    });

    it("peaks late in the downswing, near impact", () => {
        const { stats } = analyze("good");
        expect(stats.peakRateDps).toBeGreaterThan(1500);
        expect(stats.peakRateSec).toBeGreaterThan(stats.impactSec - 0.1);
        expect(stats.peakRateSec).toBeLessThanOrEqual(stats.impactSec);
    });

    it("fits a swing plane close to the lie angle of the club", () => {
        const { stats } = analyze("good");
        expect(stats.swingPlaneDeg).toBeGreaterThan(50);
        expect(stats.swingPlaneDeg).toBeLessThan(75);
    });

    it("separates the three swings by face to path", () => {
        const good = analyze("good").stats;
        const slice = analyze("slice").stats;
        const hook = analyze("hook").stats;
        expect(slice.faceToPathDeg).toBeGreaterThan(6);
        expect(hook.faceToPathDeg).toBeLessThan(-6);
        expect(Math.abs(good.faceToPathDeg)).toBeLessThan(2.5);
    });

    it("calibrates cleanly with no warning", () => {
        expect(analyze("good").calibration.warning).toBeNull();
    });
});

describe("ball flight", () => {
    it("carries a seven iron a believable distance", () => {
        const { flight, stats } = analyze("good");
        const carryYards = flight.carryM * YARDS;
        const ballMph = flight.ballSpeedMps * MPH;
        const clubMph = stats.clubheadSpeedMps * MPH;

        // Roughly 64 mph clubhead, so about 88 mph ball speed and 140 yards carry.
        expect(clubMph).toBeGreaterThan(55);
        expect(ballMph).toBeCloseTo(clubMph * CLUB.smash, 0);
        expect(carryYards).toBeGreaterThan(110);
        expect(carryYards).toBeLessThan(175);
    });

    it("delofts the club by the attack angle", () => {
        const { flight, stats } = analyze("good");
        expect(flight.dynamicLoftDeg).toBeCloseTo(CLUB.loft + stats.attackAngleDeg, 6);
        expect(flight.dynamicLoftDeg).toBeLessThan(CLUB.loft); // irons hit down
        expect(flight.launchAngleDeg).toBeLessThan(flight.dynamicLoftDeg);
    });

    it("curves a slice right and a hook left", () => {
        const slice = analyze("slice").flight;
        const hook = analyze("hook").flight;
        expect(slice.offlineM).toBeGreaterThan(0);
        expect(hook.offlineM).toBeLessThan(0);
        expect(slice.shape).toBe("slice");
        expect(hook.shape).toBe("hook");
    });

    it("leaves a good swing near straight", () => {
        const good = analyze("good").flight;
        expect(Math.abs(good.offlineM * YARDS)).toBeLessThan(12);
    });

    it("costs a slice distance against a straight strike", () => {
        // Same clubhead speed, but sidespin and a steeper strike give up carry.
        expect(analyze("slice").flight.carryM).toBeLessThan(analyze("good").flight.carryM);
    });

    it("reaches a sensible apex and lands back on the ground", () => {
        const { flight } = analyze("good");
        expect(flight.apexM).toBeGreaterThan(10);
        expect(flight.apexM).toBeLessThan(50);
        expect(flight.path.length).toBeGreaterThan(20);
        expect(flight.path[flight.path.length - 1].y).toBeCloseTo(0, 2);
    });

    it("flies further with a longer club", () => {
        const cap = capture("good");
        const seven = analyzeSwing(cap, getClub("7i"), "right");
        const four = analyzeSwing(cap, getClub("4i"), "right");
        expect(four.flight.carryM).toBeGreaterThan(seven.flight.carryM);
    });

    it("spins more with a wedge than a long iron", () => {
        const cap = capture("good");
        expect(analyzeSwing(cap, getClub("sw"), "right").flight.backspinRpm).toBeGreaterThan(
            analyzeSwing(cap, getClub("4i"), "right").flight.backspinRpm,
        );
    });
});

describe("strike location", () => {
    it("reads a clean swing as a center strike", () => {
        const a = analyze("good");
        expect(a.strike.zone).toBe("center");
        expect(a.strike.contactMade).toBe(true);
    });

    it("hands back a fixed ball position under the address clubhead", () => {
        const a = analyze("good");
        expect(a.strike.ballPosition.x).toBeCloseTo(a.clubheadPath[0].x, 6);
        expect(a.strike.ballPosition.z).toBeCloseTo(a.clubheadPath[0].z, 6);
        expect(a.strike.ballPosition.y).toBeGreaterThan(a.clubheadPath[0].y);
    });
});

describe("analysis output for the replay", () => {
    it("hands back a clubhead path and matching times", () => {
        const a = analyze("good");
        expect(a.clubheadPath.length).toBe(a.orientation.length);
        expect(a.times.length).toBe(a.orientation.length);
        expect(a.times[0]).toBe(0);
        expect(a.times[a.times.length - 1]).toBeGreaterThan(1);
    });

    it("covers address through impact and into the follow through", () => {
        const a = analyze("good");
        expect(a.stats.impactSec).toBeLessThan(a.times[a.times.length - 1]);
        expect(a.times[a.times.length - 1] - a.stats.impactSec).toBeGreaterThan(0.25);
    });
});

describe("the flushed 80 mph seven iron", () => {
    it("swings at about 80 mph and carries 150 to 160", () => {
        const { stats, flight } = analyzeSwing(capture("flush"), CLUB, "right");
        expect(stats.clubheadSpeedMps * MPH).toBeGreaterThan(77);
        expect(stats.clubheadSpeedMps * MPH).toBeLessThan(83);
        expect(flight.carryM * YARDS).toBeGreaterThan(148);
        expect(flight.carryM * YARDS).toBeLessThan(165);
    });

    it("is struck square, which is what makes it a flush one", () => {
        const { stats, flight } = analyzeSwing(capture("flush"), CLUB, "right");
        expect(Math.abs(stats.faceToPathDeg)).toBeLessThan(2);
        expect(Math.abs(flight.offlineM * YARDS)).toBeLessThan(12);
    });

    it("stays inside what the sensor can actually report", () => {
        // 80 mph off a fixed grip would need over 2300 dps, past the BMI270 range.
        // Modelling the hands is what makes this swing representable at all.
        const peak = Math.max(
            ...getSwing("flush").samples.map((s) => Math.hypot(s.gx, s.gy, s.gz) * (180 / Math.PI)),
        );
        expect(peak).toBeLessThan(2000);
        expect(peak).toBeGreaterThan(1700);
    });

    it("outruns the easier swing it is based on", () => {
        const easy = analyzeSwing(capture("good"), CLUB, "right");
        const flush = analyzeSwing(capture("flush"), CLUB, "right");
        expect(flush.stats.clubheadSpeedMps).toBeGreaterThan(easy.stats.clubheadSpeedMps);
        expect(flush.flight.carryM).toBeGreaterThan(easy.flight.carryM);
    });

    it("runs a textbook three to one tempo", () => {
        const { stats } = analyzeSwing(capture("flush"), CLUB, "right");
        expect(stats.tempoRatio).toBeGreaterThan(2.4);
        expect(stats.tempoRatio).toBeLessThan(3.6);
    });
});

describe("two segment model", () => {
    it("counts the hands, which the fixed grip model could not", () => {
        const a = analyzeSwing(capture("flush"), CLUB, "right");
        const i = a.phases.impactIndex;
        // Rotation about the hands alone leaves out roughly a fifth of the speed.
        const rotationOnly = Math.hypot(
            a.clubheadPath[i].x - a.gripPath[i].x,
            a.clubheadPath[i].y - a.gripPath[i].y,
            a.clubheadPath[i].z - a.gripPath[i].z,
        );
        expect(rotationOnly).toBeCloseTo(a.shaftLength, 6);
        expect(a.stats.clubheadSpeedMps * MPH).toBeGreaterThan(77);
    });

    it("moves the hands through the swing instead of pinning them", () => {
        const a = analyzeSwing(capture("good"), CLUB, "right");
        const moved = a.gripPath.some(
            (p) =>
                Math.hypot(p.x - a.gripPath[0].x, p.y - a.gripPath[0].y, p.z - a.gripPath[0].z) >
                0.2,
        );
        expect(moved).toBe(true);
    });

    it("starts the hands at the origin, where the grip sat at address", () => {
        const a = analyzeSwing(capture("good"), CLUB, "right");
        expect(Math.hypot(a.gripPath[0].x, a.gripPath[0].y, a.gripPath[0].z)).toBeLessThan(1e-6);
    });
});

describe("left-handed golfers", () => {
    // The "good" preset is defined for a right-handed golfer. Re-synthesizing it
    // with hand: "left" and otherwise identical parameters is the mirror image
    // of the same swing, so a correct pipeline has to read it as a square,
    // center-struck shot too, not as some other swing entirely.
    function synthesizeLeft(id: SwingId): SwingParams {
        return { ...SWING_PRESETS[id], hand: "left" };
    }

    function analyzeLeft(id: SwingId) {
        const { samples } = synthesizeSwing(synthesizeLeft(id));
        let out: SwingCapture | null = null;
        const d = new SwingDetector((c) => (out = c));
        for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8));
        if (!out) throw new Error("no capture");
        return analyzeSwing(out, CLUB, "left");
    }

    it("reads a mirrored square swing as square, not tilted 180 degrees off", () => {
        // Before faceNormalS existed, the face normal used a right-handed sensor
        // convention unconditionally, so a left-handed address pose came out
        // reading the face as pointing straight back at the golfer instead of
        // down the target line.
        const a = analyzeLeft("good");
        expect(Math.abs(a.stats.faceAngleDeg)).toBeLessThan(10);
        expect(Math.abs(a.flight.offlineM) * YARDS).toBeLessThan(12);
    });

    it("still reads a center strike as center, mirrored", () => {
        const a = analyzeLeft("good");
        expect(a.strike.zone).toBe("center");
        expect(a.strike.contactMade).toBe(true);
    });

    it("names a mirrored slice-causing fault a slice, not a hook", () => {
        // A righty slice comes from planeYawDeg/faceRollDeg both positive (see
        // the "slice" preset). The mirror image of that same swing fault, for a
        // lefty, is both negated.
        const params: SwingParams = {
            ...synthesizeLeft("good"),
            planeYawDeg: -SWING_PRESETS.slice.planeYawDeg,
            faceRollDeg: -SWING_PRESETS.slice.faceRollDeg,
        };
        const { samples } = synthesizeSwing(params);
        let out: SwingCapture | null = null;
        const d = new SwingDetector((c) => (out = c));
        for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8));
        if (!out) throw new Error("no capture");
        const a = analyzeSwing(out, CLUB, "left");

        // Ball misses to the golfer's dominant side, same as the righty slice
        // test above, which for a lefty is physically the opposite side of target.
        expect(a.flight.offlineM).toBeLessThan(0);
        expect(a.flight.shape).toBe("slice");
    });
});
