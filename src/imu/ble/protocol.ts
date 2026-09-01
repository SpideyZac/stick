import { ACCEL_LSB, GYRO_LSB, type ImuSample } from "../types";

// Mirrors hardware/src/main.cpp. Keep both sides in sync if you touch either.
export const SERVICE_UUID = "7a2fb2b0-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const AUTH_CHAR_UUID = "7a2fb2b1-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const STATUS_CHAR_UUID = "7a2fb2b2-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const DATA_CHAR_UUID = "7a2fb2b3-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const CONTROL_CHAR_UUID = "7a2fb2b4-3c1a-4a9e-8f6b-1d2e3f4a5b6c";
export const BATTERY_CHAR_UUID = "7a2fb2b5-3c1a-4a9e-8f6b-1d2e3f4a5b6c";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export const decodeText = (data: DataView): string => textDecoder.decode(data.buffer);
export const encodeText = (text: string): Uint8Array => textEncoder.encode(text);

/**
 * DATA_CHAR payload: one sample per notification, 16 bytes little-endian.
 *   uint32 tMs; int16 ax,ay,az; int16 gx,gy,gz
 * ax/ay/az and gx/gy/gz are raw counts, quantized with the same LSBs the
 * mock data uses (see src/imu/types.ts), so decoding is just a multiply.
 */
export function decodeImuPacket(data: DataView): { tMs: number; sample: Omit<ImuSample, "t"> } {
    const tMs = data.getUint32(0, true);
    const ax = data.getInt16(4, true) * ACCEL_LSB;
    const ay = data.getInt16(6, true) * ACCEL_LSB;
    const az = data.getInt16(8, true) * ACCEL_LSB;
    const gx = data.getInt16(10, true) * GYRO_LSB;
    const gy = data.getInt16(12, true) * GYRO_LSB;
    const gz = data.getInt16(14, true) * GYRO_LSB;
    return { tMs, sample: { ax, ay, az, gx, gy, gz } };
}
