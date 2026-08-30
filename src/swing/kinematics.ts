import type { Quat } from '../math/quat'
import { rotate } from '../math/quat'
import { type Vec3, cross, scale } from '../math/vec3'
import { FACE_NORMAL_S, SHAFT_AXIS_S } from './frames'

/**
 * Forward kinematics for the clubhead.
 *
 * The grip is the origin and the clubhead hangs off it by the shaft length,
 * rotated by the current orientation. That turns position into geometry instead
 * of a double integration of the accelerometer, which would drift hopelessly
 * over a swing.
 *
 * The hands really do travel during a swing, so this understates clubhead speed
 * a little. Every angle we report is directional, so none of them care.
 */
export const clubheadOffset = (q: Quat, shaftLength: number): Vec3 =>
  scale(rotate(q, SHAFT_AXIS_S), shaftLength)

/** Clubhead velocity from rigid body rotation about the grip. */
export const clubheadVelocity = (omegaWorld: Vec3, offset: Vec3): Vec3 =>
  cross(omegaWorld, offset)

/** Where the face is pointing, in world coordinates. */
export const faceNormal = (q: Quat): Vec3 => rotate(q, FACE_NORMAL_S)

/** Unit vector down the shaft toward the clubhead, in world coordinates. */
export const shaftDirection = (q: Quat): Vec3 => rotate(q, SHAFT_AXIS_S)
