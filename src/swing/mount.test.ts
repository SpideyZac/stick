import { describe, expect, it } from "vitest";
import { getClub } from "../data/clubs";
import { SWING_PRESETS, getSwing, type SwingId } from "../imu/mock/swings";
import { synthesizeSwing } from "../imu/mock/synth";
import { mulberry32 } from "../imu/mock/rng";
import type { ImuSample } from "../imu/types";
import { type Quat, angleBetweenQuats, conj, fromAxisAngle, mul, rotate } from "../math/quat";
import { normalize, v3 } from "../math/vec3";
import { SwingDetector, type SwingCapture } from "./detect";
import { toDeg, type Handedness } from "./frames";
import { fitMount } from "./mount";
import { analyzeSwing } from "./pipeline";

const CLUB = getClub("7i");

function capture(samples: ImuSample[]): SwingCapture {
    let out: SwingCapture | null = null;
    const d = new SwingDetector((c) => (out = c));
    for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8));
    if (!out) throw new Error("no capture");
    return out;
}

/**
 * Turn a stream that is already in the pipeline's sensor frame into what the chip
 * would have reported had it been strapped on at some arbitrary angle. This is
 * the inverse of what fitMount has to undo.
 */
function remount(samples: readonly ImuSample[], r: Quat): ImuSample[] {
    return samples.map((s) => {
        const a = rotate(r, v3(s.ax, s.ay, s.az));
        const w = rotate(r, v3(s.gx, s.gy, s.gz));
        return { t: s.t, ax: a.x, ay: a.y, az: a.z, gx: w.x, gy: w.y, gz: w.z };
    });
}

/** A spread of mountings, from a nudge to completely arbitrary. */
function mountings(count: number): Quat[] {
    const rand = mulberry32(2024);
    const out: Quat[] = [];
    for (let i = 0; i < count; i++) {
        const axis = normalize(v3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1));
        out.push(fromAxisAngle(axis, rand() * 2 * Math.PI));
    }
    return out;
}

function fit(id: SwingId, r: Quat, hand: Handedness = "right") {
    const swung = remount(getSwing(id, undefined, hand).samples, r);
    const cap = capture(swung);
    return { fit: fitMount(cap.samples, cap.still, hand), capture: cap };
}

describe("learning the mount from a swing", () => {
    it("recovers an identity mount from a stream already in the right frame", () => {
        const cap = capture(getSwing("good").samples);
        const { mount, warning } = fitMount(cap.samples, cap.still, "right");
        expect(warning).toBeNull();
        expect(mount).not.toBeNull();
        expect(toDeg(angleBetweenQuats(mount!.q, { w: 1, x: 0, y: 0, z: 0 }))).toBeLessThan(4);
    });

    it("recovers the mount however the sensor is strapped on", () => {
        // The whole point: no assumption at all about which way up the unit went.
        for (const r of mountings(24)) {
            const { fit: got } = fit("good", r);
            expect(got.warning).toBeNull();
            expect(got.mount).not.toBeNull();
            // The mount has to be the inverse of the mounting, since one undoes
            // what the other did.
            const err = toDeg(angleBetweenQuats(got.mount!.q, conj(r)));
            expect(err).toBeLessThan(4);
        }
    });

    it("reads the lie angle of the club it was taught on", () => {
        // The canned swings all address a 62 degree lie.
        for (const r of mountings(6)) {
            const { fit: got } = fit("good", r);
            expect(got.mount!.lieAngleDeg).toBeGreaterThan(57);
            expect(got.mount!.lieAngleDeg).toBeLessThan(67);
        }
    });

    it("gives the same frame no matter how the sensor was strapped on", () => {
        // Stronger than agreeing with the truth, and the property that actually
        // matters: nothing about the answer may depend on the mounting.
        const frames = mountings(12).map((r) => mul(fit("good", r).fit.mount!.q, r));
        for (const q of frames) {
            expect(toDeg(angleBetweenQuats(q, frames[0]))).toBeLessThan(0.5);
        }
    });

    it("works for a left-handed swing too", () => {
        for (const r of mountings(8)) {
            const { fit: got } = fit("good", r, "left");
            expect(got.warning).toBeNull();
            expect(toDeg(angleBetweenQuats(got.mount!.q, conj(r)))).toBeLessThan(4);
        }
    });

    it("learns the same tilt from any swing, and takes its azimuth from the plane", () => {
        // Tilt is measured -- gravity says which way is up regardless of what kind of
        // swing taught it -- so every swing shape has to agree on the lie angle.
        const r = mountings(1)[0];
        const lies = (["good", "slice", "hook", "flush", "waggle"] as SwingId[]).map(
            (id) => fit(id, r).fit.mount!.lieAngleDeg,
        );
        for (const lie of lies) expect(Math.abs(lie - lies[0])).toBeLessThan(1);

        // Azimuth is not measured, it is assumed from the teaching swing's plane, so
        // these deliberately do not agree: a mount taught on a seven degree out-to-in
        // swing is yawed by about seven degrees. This is the documented limit in
        // mount.ts, pinned here so it stays a known quantity rather than a surprise.
        const good = fit("good", r).fit.mount!.q;
        const slice = fit("slice", r).fit.mount!.q;
        const yaw = toDeg(angleBetweenQuats(good, slice));
        expect(yaw).toBeGreaterThan(3);
        expect(yaw).toBeLessThan(9);
    });
});

describe("swinging with a learned mount", () => {
    it("gets the same answers as if the sensor had been mounted perfectly", () => {
        const straight = analyzeSwing(capture(getSwing("good").samples), CLUB, "right", null);

        for (const r of mountings(8)) {
            const cap = capture(remount(getSwing("good").samples, r));
            const { mount } = fitMount(cap.samples, cap.still, "right");
            const remounted = analyzeSwing(cap, CLUB, "right", mount);

            expect(remounted.calibration.warning).toBeNull();
            expect(remounted.impact.passedBall).toBe(true);
            expect(remounted.strike.zone).toBe(straight.strike.zone);
            expect(remounted.stats.clubheadSpeedMps).toBeCloseTo(
                straight.stats.clubheadSpeedMps,
                0,
            );
            // A degree and a half, not the pipeline's usual one: the mount takes its
            // azimuth from the plane of the swing that taught it, and this swing has
            // nearly two degrees of plane yaw in it. See the note in mount.ts.
            expect(
                Math.abs(remounted.stats.faceToPathDeg - straight.stats.faceToPathDeg),
            ).toBeLessThan(1.5);
        }
    });

    it("still reads the mis-hits as mis-hits through an arbitrary mount", () => {
        const r = mountings(3)[2];
        for (const [id, zone] of [
            ["topped", "top"],
            ["toe", "toe"],
            ["thin", "thin"],
        ] as const) {
            const cap = capture(remount(getSwing(id).samples, r));
            const { mount } = fitMount(cap.samples, cap.still, "right");
            expect(analyzeSwing(cap, CLUB, "right", mount).strike.zone, id).toBe(zone);
        }
    });

    it("a mount learned from one swing works on the next", () => {
        const r = mountings(5)[4];
        const taught = fitMount(
            ...(() => {
                const c = capture(remount(getSwing("good").samples, r));
                return [c.samples, c.still, "right"] as const;
            })(),
        ).mount;

        const later = capture(remount(getSwing("slice").samples, r));
        const a = analyzeSwing(later, CLUB, "right", taught);
        const straight = analyzeSwing(capture(getSwing("slice").samples), CLUB, "right", null);

        expect(a.calibration.warning).toBeNull();
        expect(Math.abs(a.stats.faceToPathDeg - straight.stats.faceToPathDeg)).toBeLessThan(1.5);
    });

    it("costs nothing at all to have been strapped on crooked", () => {
        // Whatever the residual error is, none of it may come from the mounting: the
        // same swing through twelve different mountings has to give one answer.
        const answers = mountings(12).map((r) => {
            const cap = capture(remount(getSwing("good").samples, r));
            const mount = fitMount(cap.samples, cap.still, "right").mount;
            return analyzeSwing(cap, CLUB, "right", mount).stats;
        });
        for (const s of answers) {
            expect(s.faceToPathDeg).toBeCloseTo(answers[0].faceToPathDeg, 3);
            expect(s.clubheadSpeedMps).toBeCloseTo(answers[0].clubheadSpeedMps, 3);
        }
    });
});

describe("refusing a mount it cannot trust", () => {
    it("will not read a pose off a club that was not still", () => {
        const cap = capture(getSwing("good").samples);
        // Half a g of extra acceleration: the club was moving, so the direction it
        // reads is not up and the frame built off it would be quietly wrong.
        const moving = cap.still.map((s) => ({ ...s, ax: s.ax + 5 }));
        const got = fitMount(cap.samples, moving, "right");
        expect(got.mount).toBeNull();
        expect(got.warning).toMatch(/still/i);
    });

    it("will not read a mount off something that is not a swing", () => {
        const still: ImuSample[] = [];
        for (let i = 0; i < 400; i++) {
            still.push({ t: i / 400, ax: 0, ay: 9.80665, az: 0, gx: 0, gy: 0, gz: 0 });
        }
        const got = fitMount(still, still, "right");
        expect(got.mount).toBeNull();
        expect(got.warning).toMatch(/takeaway/i);
    });

    it("will not accept a swing that never grounded the club", () => {
        // A club held out at 85 degrees, nearly straight down, is not a club sitting
        // on the ground. The frame it builds is perfectly self consistent -- it is
        // just not describing an address pose, and every angle read against it later
        // would be measured off a fiction.
        const built = synthesizeSwing({ ...SWING_PRESETS.good, lieDeg: 85 });
        const cap = capture(built.samples);
        const got = fitMount(cap.samples, cap.still, "right");
        expect(got.mount).toBeNull();
        expect(got.warning).toMatch(/ground/i);
    });
});
