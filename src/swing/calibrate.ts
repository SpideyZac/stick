import { type Club, effectiveShaftLength } from "../data/clubs";
import type { ImuSample } from "../imu/types";
import type { Quat } from "../math/quat";
import { rotate } from "../math/quat";
import { type Vec3, len, scale, v3 } from "../math/vec3";
import { DEG, GRAVITY, type Handedness, SHAFT_AXIS_S, addressFrame, toDeg } from "./frames";

export interface Calibration {
    /** Mean gyro output while the club sat still. Subtracted from everything. */
    gyroBias: Vec3;
    /** Sensor to world at address. The reference every later angle is read off. */
    addressQuat: Quat;
    /** Shaft angle off the ground implied by the address pose. */
    lieAngleDeg: number;
    /** How high the grip sits above the ground, implied by the same pose. */
    gripHeight: number;
    /** Set when the geometry does not add up. Shown to the golfer, not swallowed. */
    warning: string | null;
}

// Plausible bands for a grounded club held by a person. Anything outside these
// means the mount, the axes, or the club selection is wrong.
const LIE_MIN = 45;
const LIE_MAX = 78;
const GRIP_MIN = 0.45;
const GRIP_MAX = 1.15;
const GRAVITY_TOLERANCE = 0.12;
/** Tighter than the detector's stillness threshold, on purpose. */
const QUIET_DPS = 5;

/**
 * Read everything we need out of the still moment before takeaway.
 *
 * The gyro bias matters more than anything else here. A degree or two per second
 * left uncorrected integrates into several degrees of orientation error across a
 * two second swing, which is larger than the face angles we are trying to report.
 */
export function calibrate(window: ImuSample[], club: Club, hand: Handedness): Calibration {
    // Only average over samples that are genuinely still. A few samples of early
    // takeaway leaking into the window drags the bias estimate by more than the
    // bias itself, so this is worth doing even though the caller already tried.
    const quiet = window.filter((s) => Math.hypot(s.gx, s.gy, s.gz) / DEG < QUIET_DPS);
    const still = quiet.length >= 8 ? quiet : window;
    const n = Math.max(1, still.length);
    let ax = 0;
    let ay = 0;
    let az = 0;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    for (const s of still) {
        ax += s.ax;
        ay += s.ay;
        az += s.az;
        gx += s.gx;
        gy += s.gy;
        gz += s.gz;
    }

    const accel = v3(ax / n, ay / n, az / n);
    const gyroBias = v3(gx / n, gy / n, gz / n);
    const addressQuat = addressFrame(accel, hand);

    // Forward kinematics on the address pose. The grip is the origin, so the
    // clubhead sitting on the ground is the same statement as the grip sitting at
    // exactly the height this geometry implies.
    const shaftW = rotate(addressQuat, SHAFT_AXIS_S);
    const lieAngleDeg = toDeg(Math.asin(Math.max(-1, Math.min(1, -shaftW.y))));
    const gripHeight = -shaftW.y * effectiveShaftLength(club);

    return {
        gyroBias,
        addressQuat,
        lieAngleDeg,
        gripHeight,
        warning: checkGeometry(accel, lieAngleDeg, gripHeight),
    };
}

function checkGeometry(accel: Vec3, lieAngleDeg: number, gripHeight: number): string | null {
    const g = len(accel) / GRAVITY;
    if (Math.abs(g - 1) > GRAVITY_TOLERANCE) {
        return `Sensor read ${g.toFixed(2)}g at address instead of 1g. Check it is still and mounted tight.`;
    }
    if (lieAngleDeg < LIE_MIN || lieAngleDeg > LIE_MAX) {
        return `Shaft sits ${lieAngleDeg.toFixed(0)} degrees off the ground at address, which is not a grounded club. Check the sensor orientation.`;
    }
    if (gripHeight < GRIP_MIN || gripHeight > GRIP_MAX) {
        return `Address geometry puts the grip ${gripHeight.toFixed(2)}m off the ground. Check the club selection.`;
    }
    return null;
}

/** Gyro reading with the address bias taken out. */
export const debias = (s: ImuSample, bias: Vec3): Vec3 =>
    v3(s.gx - bias.x, s.gy - bias.y, s.gz - bias.z);

export const accelOf = (s: ImuSample): Vec3 => v3(s.ax, s.ay, s.az);

/** Bias magnitude in degrees per second, for display. */
export const biasDps = (cal: Calibration): number => len(scale(cal.gyroBias, 1 / DEG));
