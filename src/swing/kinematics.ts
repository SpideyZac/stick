import type { Quat } from "../math/quat";
import { rotate } from "../math/quat";
import { type Vec3, add, cross, scale } from "../math/vec3";
import { type Handedness, SHAFT_AXIS_S, faceNormalS } from "./frames";

/**
 * Forward kinematics for the clubhead.
 *
 * Offset of the clubhead from the grip: the shaft length, rotated by the current
 * orientation. That turns the club's own geometry into geometry rather than a
 * double integration of the accelerometer, which would drift hopelessly.
 *
 * This is an offset, not a position. Where the grip itself is comes from
 * `trackGrip`, because the hands travel a long way during a swing and pretending
 * otherwise reads about twenty percent low on clubhead speed.
 */
export const clubheadOffset = (q: Quat, shaftLength: number): Vec3 =>
    scale(rotate(q, SHAFT_AXIS_S), shaftLength);

/** Clubhead velocity: the hands carry it along, and it rotates about them. */
export const clubheadVelocity = (omegaWorld: Vec3, offset: Vec3, gripVelocity: Vec3): Vec3 =>
    add(gripVelocity, cross(omegaWorld, offset));

/** Where the face is pointing, in world coordinates. */
export const faceNormal = (q: Quat, hand: Handedness): Vec3 => rotate(q, faceNormalS(hand));

/** Unit vector down the shaft toward the clubhead, in world coordinates. */
export const shaftDirection = (q: Quat): Vec3 => rotate(q, SHAFT_AXIS_S);
