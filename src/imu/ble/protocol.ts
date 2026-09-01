import { ACCEL_LSB, GYRO_LSB, type ImuSample } from "../types";

// Mirrors hardware/src/main.cpp. Keep both sides in sync if you touch either.
//
// These are the v2 UUIDs. They moved when the pairing key came out and the
// stream started arriving in batches, so a v1 device and this build simply do
// not see each other rather than connecting and disagreeing about every packet.
export const SERVICE_UUID = "7a2fb2c0-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
/** Readable link state, for a person poking at the device with a BLE scanner. */
export const STATUS_CHAR_UUID = "7a2fb2c2-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const DATA_CHAR_UUID = "7a2fb2c3-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const CONTROL_CHAR_UUID = "7a2fb2c4-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const BATTERY_CHAR_UUID = "7a2fb2c5-3c1a-4a9e-8f6b-1d2e3f4a5b6c";

/** What the site writes to the control characteristic. */
export const PING = "PING";
export const REC_START = "REC_START";
export const REC_STOP = "REC_STOP";

/**
 * How often the site tells the device it is still here. The device hangs up and
 * goes back to advertising after a few missed pings, which is the only way it
 * can tell a closed tab from a quiet one -- see the link liveness note in
 * hardware/src/main.cpp.
 */
export const PING_INTERVAL_MS = 1000;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const decodeText = (data: DataView): string => textDecoder.decode(data.buffer);
export const encodeText = (text: string): Uint8Array => textEncoder.encode(text);

const HEADER_BYTES = 6;
const SAMPLE_BYTES = 14;

export interface ImuBatch {
    /** Device uptime, milliseconds, one entry per sample. */
    timesMs: number[];
    samples: Omit<ImuSample, "t">[];
    /** Whether the device believed it was recording when it sent this. */
    recording: boolean;
}

/**
 * DATA_CHAR payload, little-endian throughout:
 *
 *   header  uint32 t0Ms; uint8 count; uint8 flags
 *   sample  uint16 dtUs; int16 ax,ay,az; int16 gx,gy,gz     x count
 *
 * The counts are exactly what came off the BMI270, at the ranges the firmware
 * configures it to and src/imu/types.ts assumes, so decoding is one multiply and
 * there is no second place for a unit to go wrong.
 *
 * Timestamps ride along per sample rather than being reconstructed from a
 * nominal rate. The sample that matters most is the one at contact, and it
 * should be placed by the clock that took it.
 */
export function decodeImuBatch(data: DataView): ImuBatch {
    if (data.byteLength < HEADER_BYTES) return { timesMs: [], samples: [], recording: false };

    const t0Ms = data.getUint32(0, true);
    const declared = data.getUint8(4);
    const recording = (data.getUint8(5) & 0x01) !== 0;

    // Trust the packet's length over its own count field. A short read should
    // cost the tail of one batch, not throw.
    const fits = Math.floor((data.byteLength - HEADER_BYTES) / SAMPLE_BYTES);
    const count = Math.min(declared, fits);

    const timesMs: number[] = new Array(count);
    const samples: Omit<ImuSample, "t">[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const at = HEADER_BYTES + i * SAMPLE_BYTES;
        timesMs[i] = t0Ms + data.getUint16(at, true) / 1000;
        samples[i] = {
            ax: data.getInt16(at + 2, true) * ACCEL_LSB,
            ay: data.getInt16(at + 4, true) * ACCEL_LSB,
            az: data.getInt16(at + 6, true) * ACCEL_LSB,
            gx: data.getInt16(at + 8, true) * GYRO_LSB,
            gy: data.getInt16(at + 10, true) * GYRO_LSB,
            gz: data.getInt16(at + 12, true) * GYRO_LSB,
        };
    }
    return { timesMs, samples, recording };
}
