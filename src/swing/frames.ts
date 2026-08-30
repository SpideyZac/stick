import { type Quat, fromBasis } from "../math/quat";
import { type Vec3, cross, normalize, reject, scale, v3 } from "../math/vec3";

export type Handedness = "right" | "left";

// Mount convention. Change these constants if the sensor is remounted, nothing
// downstream needs to know.
//
// Sensor frame S:
//   +Zs runs down the shaft toward the clubhead
//   +Xs is the forward axis, facing the golfer at address
//   +Ys completes the right handed set
export const SHAFT_AXIS_S: Vec3 = v3(0, 0, 1);
export const FORWARD_AXIS_S: Vec3 = v3(1, 0, 0);

// With the shaft pointing down and +Xs at the golfer, the face normal comes out
// along +Ys for a right-handed club. That is the direction the ball starts in
// when the face is square.
export const FACE_NORMAL_S: Vec3 = v3(0, 1, 0);

/**
 * Face normal in sensor coordinates, for either hand.
 *
 * The mount's own axes, +Xs (facing the golfer) and +Zs (down the shaft), are
 * fixed by the physical clip and do not depend on which club is attached: you
 * install it facing yourself either way. But a left-handed clubhead is a mirror
 * image of a right-handed one, so relative to those same two mount axes its face
 * sits on the opposite side. FACE_NORMAL_S alone is only correct for a
 * right-handed club; every place that reads the face direction from a sensor
 * orientation needs this, not the bare constant, once handedness is known.
 */
export const faceNormalS = (hand: Handedness): Vec3 =>
    hand === "right" ? FACE_NORMAL_S : v3(-FACE_NORMAL_S.x, -FACE_NORMAL_S.y, -FACE_NORMAL_S.z);

// World frame W, fixed at address:
//   +Xw along the target line
//   +Yw up
//   +Zw = Xw x Yw, which is your right when looking down the target line
//
// A right handed golfer aims to their own left, so they stand on the -Zw side
// and the ball sits toward +Zw from them.
export const WORLD_UP: Vec3 = v3(0, 1, 0);
export const WORLD_TARGET: Vec3 = v3(1, 0, 0);
export const WORLD_RIGHT: Vec3 = v3(0, 0, 1);

export const GRAVITY = 9.80665;

/**
 * Build the address reference frame from a single still accelerometer reading.
 * Returns the quaternion that rotates a sensor frame vector into world.
 *
 * At rest the accelerometer reads the reaction to gravity, so it points up in
 * sensor coordinates. That fixes roll and pitch. Yaw comes from the mount: we
 * assume the golfer is square at address, so the forward axis flattened into the
 * horizontal plane points straight at them, and the target line is perpendicular
 * to it. This is the "square to target" assumption every later angle is measured
 * against.
 */
export function addressFrame(accel: Vec3, hand: Handedness): Quat {
    const upS = normalize(accel);
    // Horizontal direction from the ball back toward the golfer.
    const golferS = normalize(reject(FORWARD_AXIS_S, upS));
    // Right handed players stand on -Zw, lefties on +Zw. Flipping this is the
    // whole of the handedness difference, every signed angle follows from it.
    const zS = hand === "right" ? scale(golferS, -1) : golferS;
    const xS = cross(upS, zS);
    return fromBasis(xS, upS, zS);
}

/** Quaternion for a pose given the sensor axes expressed in world coordinates. */
export function fromSensorAxes(xs: Vec3, ys: Vec3, zs: Vec3): Quat {
    // fromBasis wants the world axes in sensor coordinates, which is the transpose.
    return fromBasis(v3(xs.x, ys.x, zs.x), v3(xs.y, ys.y, zs.y), v3(xs.z, ys.z, zs.z));
}

/** Signed horizontal angle off the target line, radians. Positive is right. */
export const horizontalAngle = (v: Vec3): number => Math.atan2(v.z, v.x);

/** Shortest signed difference between two angles, radians. */
export function wrapAngle(a: number): number {
    let x = a;
    while (x > Math.PI) x -= 2 * Math.PI;
    while (x < -Math.PI) x += 2 * Math.PI;
    return x;
}

export const DEG = Math.PI / 180;
export const toDeg = (rad: number): number => rad / DEG;
