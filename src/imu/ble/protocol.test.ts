import { describe, expect, it } from "vitest";
import { ACCEL_LSB, ACCEL_RANGE_G, GYRO_LSB, GYRO_RANGE_DPS } from "../types";
import { decodeImuBatch } from "./protocol";

const HEADER_BYTES = 6;
const SAMPLE_BYTES = 14;

interface RawSample {
    dtUs: number;
    ax: number;
    ay: number;
    az: number;
    gx: number;
    gy: number;
    gz: number;
}

/**
 * Builds a packet byte for byte the way hardware/src/main.cpp does. If this and
 * the firmware ever drift apart, that is what these tests are here to catch.
 */
function encodeBatch(t0Ms: number, recording: boolean, samples: RawSample[]): DataView {
    const buf = new ArrayBuffer(HEADER_BYTES + samples.length * SAMPLE_BYTES);
    const view = new DataView(buf);
    view.setUint32(0, t0Ms, true);
    view.setUint8(4, samples.length);
    view.setUint8(5, recording ? 0x01 : 0x00);
    samples.forEach((s, i) => {
        const at = HEADER_BYTES + i * SAMPLE_BYTES;
        view.setUint16(at, s.dtUs, true);
        view.setInt16(at + 2, s.ax, true);
        view.setInt16(at + 4, s.ay, true);
        view.setInt16(at + 6, s.az, true);
        view.setInt16(at + 8, s.gx, true);
        view.setInt16(at + 10, s.gy, true);
        view.setInt16(at + 12, s.gz, true);
    });
    return view;
}

const raw = (dtUs: number, v: number): RawSample => ({
    dtUs,
    ax: v,
    ay: v,
    az: v,
    gx: v,
    gy: v,
    gz: v,
});

describe("the wire format", () => {
    it("reads back a full batch", () => {
        const samples = Array.from({ length: 16 }, (_, i) => raw(i * 2500, i * 100));
        const got = decodeImuBatch(encodeBatch(1234, true, samples));

        expect(got.samples).toHaveLength(16);
        expect(got.recording).toBe(true);
        expect(got.timesMs[0]).toBe(1234);
        // 2500 microseconds a sample is the 400 Hz the firmware configures.
        expect(got.timesMs[15]).toBeCloseTo(1234 + 37.5, 6);
    });

    it("turns raw counts into m/s^2 and rad/s with one multiply", () => {
        const got = decodeImuBatch(encodeBatch(0, false, [raw(0, 1000)]));
        expect(got.samples[0].ax).toBeCloseTo(1000 * ACCEL_LSB, 12);
        expect(got.samples[0].gx).toBeCloseTo(1000 * GYRO_LSB, 12);
    });

    it("puts full scale exactly where the firmware configures the chip", () => {
        // The firmware sets +-16 g and +-2000 dps precisely so counts can travel
        // unscaled. If either end ever moves, this is the number that breaks. The
        // largest positive count is one short of full scale, which is where the
        // last fraction of a unit goes.
        const full = decodeImuBatch(encodeBatch(0, false, [raw(0, 32767)])).samples[0];
        expect(full.ax / 9.80665).toBeCloseTo(ACCEL_RANGE_G, 2);
        expect(full.gx * (180 / Math.PI)).toBeCloseTo(GYRO_RANGE_DPS, 0);
    });

    it("keeps the sign of negative counts", () => {
        const got = decodeImuBatch(encodeBatch(0, false, [raw(0, -12345)]));
        expect(got.samples[0].az).toBeCloseTo(-12345 * ACCEL_LSB, 12);
        expect(got.samples[0].gz).toBeCloseTo(-12345 * GYRO_LSB, 12);
    });

    it("reads what arrived rather than what the header claimed", () => {
        // A truncated notification should cost the tail of one batch, not throw.
        const full = encodeBatch(50, false, [raw(0, 1), raw(2500, 2), raw(5000, 3)]);
        const cut = new DataView(full.buffer.slice(0, HEADER_BYTES + 2 * SAMPLE_BYTES));
        expect(decodeImuBatch(cut).samples).toHaveLength(2);
    });

    it("survives a packet with no samples in it", () => {
        expect(decodeImuBatch(encodeBatch(9, false, [])).samples).toHaveLength(0);
        expect(decodeImuBatch(new DataView(new ArrayBuffer(2))).samples).toHaveLength(0);
    });

    it("carries the device's own recording flag", () => {
        expect(decodeImuBatch(encodeBatch(0, false, [raw(0, 0)])).recording).toBe(false);
        expect(decodeImuBatch(encodeBatch(0, true, [raw(0, 0)])).recording).toBe(true);
    });

    it("fits a full batch inside the MTU the firmware asks for", () => {
        // 247 byte MTU, three bytes of ATT overhead. Sixteen samples has to fit or
        // the firmware's batchCapacity and this decoder disagree about packet size.
        expect(HEADER_BYTES + 16 * SAMPLE_BYTES).toBeLessThanOrEqual(247 - 3);
    });
});
