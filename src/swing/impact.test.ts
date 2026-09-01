import { describe, expect, it } from "vitest";
import { getClub } from "../data/clubs";
import { SWING_PRESETS, getSwing, type SwingId } from "../imu/mock/swings";
import { synthesizeSwing, type SwingParams } from "../imu/mock/synth";
import type { ImuSample } from "../imu/types";
import { add, v3 } from "../math/vec3";
import { calibrate } from "./calibrate";
import { SwingDetector, type SwingCapture } from "./detect";
import { GRAVITY } from "./frames";
import { trackGrip } from "./grip";
import { IMPACT, findImpact } from "./impact";
import { clubheadOffset } from "./kinematics";
import { integrateOrientation } from "./orient";
import { findTop } from "./phases";
import { analyzeSwing } from "./pipeline";
import { ballPosition } from "./strike";

const CLUB = getClub("7i");
const SHAFT = 0.89;

function capture(samples: ImuSample[]): { capture: SwingCapture; offset: number } {
    let out: SwingCapture | null = null;
    const d = new SwingDetector((c) => (out = c));
    for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8));
    if (!out) throw new Error("no capture");
    const c = out as SwingCapture;
    return { capture: c, offset: Math.round(c.samples[0].t * 400) };
}

/** Everything findImpact needs, built the way the pipeline builds it. */
function reconstruct(cap: SwingCapture) {
    const cal = calibrate(cap.still, CLUB, "right");
    const track = integrateOrientation(cap.samples, cal);
    const grip = trackGrip(cap.samples, track.q, cap.still, "right");
    const clubheadPath = track.q.map((q, i) => add(grip.position[i], clubheadOffset(q, SHAFT)));
    const t0 = cap.samples[0].t;
    const times = cap.samples.map((s) => s.t - t0);
    const topIndex = findTop(cap.samples, track).topIndex;
    return { samples: cap.samples, times, track, clubheadPath, topIndex };
}

/** Sample index the detector's capture assigns to the synthesizer's true impact. */
const truthIndex = (id: SwingId, offset: number) => getSwing(id).truth.impactIndex - offset;

/**
 * Box filter over the accelerometer only, standing in for a mount soft enough to
 * swallow the strike. The gyro is left exactly as it was, so what is left is a
 * swing that plainly happened with no acceleration edge to find it by.
 */
function smoothAccel(samples: ImuSample[], span: number): ImuSample[] {
    const half = Math.floor(span / 2);
    return samples.map((s, i) => {
        let ax = 0;
        let ay = 0;
        let az = 0;
        let n = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(samples.length - 1, i + half); j++) {
            ax += samples[j].ax;
            ay += samples[j].ay;
            az += samples[j].az;
            n++;
        }
        return { ...s, ax: ax / n, ay: ay / n, az: az / n };
    });
}

function place(params: SwingParams) {
    const built = synthesizeSwing(params);
    const { capture: cap, offset } = capture(built.samples);
    const input = reconstruct(cap);
    return {
        estimate: findImpact({ ...input, ball: ballPosition(input.clubheadPath) }),
        truthLocal: built.truth.impactIndex - offset,
    };
}

describe("placing contact", () => {
    it("lands on the right sample for every canned swing", () => {
        for (const id of ["good", "flush", "slice", "hook", "topped", "toe"] as SwingId[]) {
            const { capture: cap, offset } = capture(getSwing(id).samples);
            const input = reconstruct(cap);
            const got = findImpact({ ...input, ball: ballPosition(input.clubheadPath) });
            // A sample at 400 Hz is about a degree of club rotation, so this is the
            // resolution every angle downstream inherits.
            expect(Math.abs(got.index - truthIndex(id, offset)), id).toBeLessThanOrEqual(1);
        }
    });

    it("finds contact with nothing in the accelerometer to find it by", () => {
        // The case the old acceleration threshold could not survive at all. The
        // accelerometer is replaced with dead flat gravity, so no shock, no edge,
        // nothing: the gyro has to place contact on its own.
        const { samples, truth } = getSwing("good");
        const { capture: cap, offset } = capture(samples);
        const input = reconstruct(cap);
        const flat = input.samples.map((s) => ({ ...s, ax: 0, ay: GRAVITY, az: 0 }));
        const got = findImpact({
            ...input,
            samples: flat,
            ball: ballPosition(input.clubheadPath),
        });

        expect(got.source).toBe("return");
        expect(got.shockRatio).toBeLessThan(IMPACT.shockProminence);
        // Geometry alone lands within a few milliseconds. What it is really finding
        // is the club coming back through address, and the hands lead the clubhead
        // at contact, so it reads a touch late by exactly that shaft lean.
        expect(Math.abs(got.index - (truth.impactIndex - offset))).toBeLessThanOrEqual(3);
    });

    it("still hears a strike through a mount soft enough to smear it", () => {
        // Nothing here needs a sharp edge, only one sharper than the swing around
        // it, so a shock spread over several milliseconds is still found.
        const { samples, truth } = getSwing("good");
        const { capture: cap, offset } = capture(smoothAccel(samples, 9));
        const input = reconstruct(cap);
        const got = findImpact({ ...input, ball: ballPosition(input.clubheadPath) });
        // Smearing the edge costs a sample or two of onset, and nothing more.
        expect(Math.abs(got.index - (truth.impactIndex - offset))).toBeLessThanOrEqual(3);
    });

    it("gives the same answer however hard the strike hits", () => {
        // Nothing here scales with the size of the shock, so a chip and a full
        // driver have to land on the same sample of the same swing.
        const indices = [0, 2, 6, 14, 30].map(
            (g) => place({ ...SWING_PRESETS.good, impactShockG: g }).estimate.index,
        );
        const spread = Math.max(...indices) - Math.min(...indices);
        expect(spread).toBeLessThanOrEqual(2);
    });

    it("never places contact before the top of the backswing", () => {
        for (const id of ["good", "slice", "hook", "waggle"] as SwingId[]) {
            const { capture: cap } = capture(getSwing(id).samples);
            const input = reconstruct(cap);
            const got = findImpact({ ...input, ball: ballPosition(input.clubheadPath) });
            expect(got.index, id).toBeGreaterThan(input.topIndex);
        }
    });

    it("reports the clubhead passing close to the ball", () => {
        const { capture: cap } = capture(getSwing("good").samples);
        const input = reconstruct(cap);
        const got = findImpact({ ...input, ball: ballPosition(input.clubheadPath) });
        expect(got.passedBall).toBe(true);
        expect(got.approachM).toBeLessThan(IMPACT.passRadiusM);
    });

    it("reports a miss when the club goes nowhere near the ball", () => {
        // Same swing, ball moved a metre away. Contact still gets placed, because
        // the swing still happened, but nothing pretends the club reached it.
        const { capture: cap } = capture(getSwing("good").samples);
        const input = reconstruct(cap);
        const away = add(ballPosition(input.clubheadPath), v3(1, 0, 0));
        const got = findImpact({ ...input, ball: away });
        expect(got.passedBall).toBe(false);
        expect(got.approachM).toBeGreaterThan(0.5);
    });

    it("works the same at the rate the hardware actually streams", () => {
        // The synthesizer runs at 400 Hz. Decimating to 100 Hz is the worst case a
        // real link should ever hand over, and nothing here assumes a rate.
        const { samples, truth } = getSwing("good");
        const slow = samples.filter((_, i) => i % 4 === 0);
        const { capture: cap } = capture(slow);
        const input = reconstruct(cap);
        const got = findImpact({ ...input, ball: ballPosition(input.clubheadPath) });

        const trueSec = samples[truth.impactIndex].t - cap.samples[0].t;
        // One 100 Hz sample of slack, which is exactly the cost of the lower rate.
        expect(Math.abs(got.sec - trueSec)).toBeLessThan(0.011);
    });
});

describe("contact in the whole pipeline", () => {
    it("reports how contact was placed alongside the numbers", () => {
        const { capture: cap } = capture(getSwing("good").samples);
        const a = analyzeSwing(cap, CLUB, "right", null);
        expect(a.impact.index).toBe(a.phases.impactIndex);
        expect(a.impact.passedBall).toBe(true);
        expect(["shock", "return"]).toContain(a.impact.source);
    });

    it("reads the same swing the same way with and without a shock", () => {
        const loud = synthesizeSwing({ ...SWING_PRESETS.good, impactShockG: 6 });
        const silent = synthesizeSwing({ ...SWING_PRESETS.good, impactShockG: 0 });

        const a = analyzeSwing(capture(loud.samples).capture, CLUB, "right", null);
        const b = analyzeSwing(capture(silent.samples).capture, CLUB, "right", null);

        expect(b.stats.faceToPathDeg).toBeCloseTo(a.stats.faceToPathDeg, 0);
        expect(b.stats.clubheadSpeedMps).toBeCloseTo(a.stats.clubheadSpeedMps, 0);
        expect(b.strike.zone).toBe(a.strike.zone);
    });
});
