import { describe, expect, it } from "vitest";
import { getSwing } from "../imu/mock/swings";
import type { ImuSample } from "../imu/types";
import { DETECT, type DetectState, SwingDetector, type SwingCapture } from "./detect";

/** Run a whole sample array through the detector in realistic batches. */
function run(samples: ImuSample[], batch = 8) {
    const captures: SwingCapture[] = [];
    const states: DetectState[] = [];
    const d = new SwingDetector(
        (c) => captures.push(c),
        (s) => states.push(s),
    );
    for (let i = 0; i < samples.length; i += batch) {
        d.push(samples.slice(i, i + batch));
    }
    return { captures, states, detector: d };
}

describe("swing detection", () => {
    it("captures exactly one swing from a clean recording", () => {
        const { samples } = getSwing("good");
        expect(run(samples).captures).toHaveLength(1);
    });

    it("does not treat the record tap as the start of the swing", () => {
        const { samples } = getSwing("good");
        const [capture] = run(samples).captures;
        // The recording opens with the golfer still fidgeting. t=0 has to land after
        // that, at the address stillness, not at sample zero.
        const t0 = capture.samples[0].t;
        expect(t0).toBeGreaterThan(samples[0].t + 0.5);
    });

    it("lands t=0 at the stillness just before takeaway", () => {
        const { samples, truth } = getSwing("good");
        const [capture] = run(samples).captures;
        const t0 = capture.samples[0].t;
        const trueTakeaway = samples[truth.takeawayIndex].t;
        // A smooth takeaway ramps up from zero, so the club is genuinely still for a
        // few tens of ms after motion mathematically begins. t=0 lands there.
        expect(Math.abs(t0 - trueTakeaway)).toBeLessThan(0.06);
    });

    it("ignores waggles and still finds the real swing", () => {
        const { samples, truth } = getSwing("waggle");
        const { captures } = run(samples);

        // Three waggles, one swing, one capture.
        expect(captures).toHaveLength(1);

        const t0 = captures[0].samples[0].t;
        const trueTakeaway = samples[truth.takeawayIndex].t;
        expect(Math.abs(t0 - trueTakeaway)).toBeLessThan(0.06);

        // And critically, t=0 is after the last waggle, not stuck back at the first.
        const lastWaggleEnd = samples[truth.takeawayIndex].t - 0.25;
        expect(t0).toBeGreaterThan(lastWaggleEnd);
    });

    it("finds impact and keeps follow through after it", () => {
        const { samples, truth } = getSwing("good");
        const [capture] = run(samples).captures;
        const impactT = capture.samples[capture.impactIndex].t;
        expect(impactT).toBeCloseTo(samples[truth.impactIndex].t, 2);

        const after = capture.samples[capture.samples.length - 1].t - impactT;
        expect(after).toBeGreaterThanOrEqual(DETECT.followSec - 0.02);
    });

    it("hands back a still window to calibrate against", () => {
        const [capture] = run(getSwing("good").samples).captures;
        expect(capture.still.length).toBeGreaterThan(50);
        for (const s of capture.still) {
            expect(Math.hypot(s.gx, s.gy, s.gz) * (180 / Math.PI)).toBeLessThan(DETECT.stillDps);
        }
    });

    it("captures every canned swing", () => {
        for (const id of ["good", "slice", "hook", "waggle"] as const) {
            expect(run(getSwing(id).samples).captures, id).toHaveLength(1);
        }
    });

    it("gives the same answer whatever the batch size", () => {
        const { samples } = getSwing("waggle");
        const a = run(samples, 1).captures;
        const b = run(samples, 8).captures;
        const c = run(samples, 64).captures;
        expect(a).toHaveLength(1);
        expect(a[0].samples[0].t).toBe(b[0].samples[0].t);
        expect(a[0].samples[0].t).toBe(c[0].samples[0].t);
    });

    it("captures nothing from waggles alone", () => {
        // Cut the recording off before the real takeaway begins.
        const { samples, truth } = getSwing("waggle");
        const waggleOnly = samples.slice(0, truth.takeawayIndex - 4);
        expect(run(waggleOnly).captures).toHaveLength(0);
    });

    it("captures nothing from a still club", () => {
        const still: ImuSample[] = [];
        for (let i = 0; i < 2000; i++) {
            still.push({ t: i / 400, ax: 0, ay: 9.80665, az: 0, gx: 0.001, gy: 0, gz: 0 });
        }
        expect(run(still).captures).toHaveLength(0);
    });

    it("recovers and captures a second swing after the first", () => {
        const { samples } = getSwing("good");
        const shifted = samples.map((s) => ({
            ...s,
            t: s.t + samples[samples.length - 1].t + 0.01,
        }));
        expect(run([...samples, ...shifted]).captures).toHaveLength(2);
    });

    it("reaches the still state before it will look at a takeaway", () => {
        const { states } = run(getSwing("good").samples);
        expect(states[0]).toBe("still");
        expect(states).toContain("capturing");
    });
});
