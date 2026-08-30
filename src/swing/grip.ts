import type { ImuSample } from '../imu/types'
import type { Quat } from '../math/quat'
import { rotate } from '../math/quat'
import { type Vec3, add, addScaled, len, normalize, scale, sub, v3 } from '../math/vec3'
import { accelOf } from './calibrate'
import { GRAVITY, WORLD_UP } from './frames'

/**
 * Where the hands sit relative to the grip at address, and how far the arms
 * reach. Anthropometric, not measured. Only the replay depends on these, every
 * number the app reports comes from the integrated velocity instead.
 */
export const ARM_LENGTH = 0.62
/** Hub direction from the grip at address: up, and back toward the golfer. */
const HUB_TILT_FROM_VERTICAL = 32 * (Math.PI / 180)

export interface GripTrack {
  /** Grip velocity in world coordinates, one per sample. */
  velocity: Vec3[]
  /** Grip position relative to address, held on the arm sphere. */
  position: Vec3[]
  /** Hub the arms pivot about, relative to the address grip position. */
  hub: Vec3
  /** Accelerometer bias removed before integrating, m/s^2. */
  accelBias: Vec3
}

/**
 * Recover how the hands moved, from the accelerometer at the grip.
 *
 * The spec rules out double integrating for position, and rightly so. But
 * velocity is a different problem: it is one integration, not two, and it starts
 * from a boundary condition we actually know, because the club is sitting still
 * at address. Over the roughly one second to impact that holds up well enough to
 * be worth having, and it matters, since with the hands pinned at a point the
 * clubhead speed reads about twenty percent low.
 *
 * Position is still a double integration and still drifts. So the direction
 * comes from the integral and the distance comes from the arms, which cannot
 * drift because it is a fixed length. That kills the radial error, which is the
 * part that would visibly stretch and squash the golfer's arms. What is left
 * slides the hands a little along their own arc, which is hard to see.
 */
export function trackGrip(
  samples: readonly ImuSample[],
  orientation: readonly Quat[],
  stillWindow: readonly ImuSample[],
  addressQuat: Quat,
): GripTrack {
  const accelBias = estimateAccelBias(stillWindow, addressQuat)
  const n = samples.length
  const velocity: Vec3[] = new Array(n)
  const raw: Vec3[] = new Array(n)

  let v = v3(0, 0, 0)
  let p = v3(0, 0, 0)

  for (let i = 0; i < n; i++) {
    velocity[i] = v
    raw[i] = p
    if (i + 1 >= n) break

    const dt = samples[i + 1].t - samples[i].t
    // Specific force is acceleration minus gravity, so adding gravity back gives
    // what the grip is actually doing.
    const specific = sub(accelOf(samples[i]), accelBias)
    const a = addScaled(rotate(orientation[i], specific), WORLD_UP, -GRAVITY)

    // Trapezoid on position, which costs nothing and halves the drift.
    p = addScaled(addScaled(p, v, dt), a, 0.5 * dt * dt)
    v = addScaled(v, a, dt)
  }

  const hub = scale(
    v3(0, Math.cos(HUB_TILT_FROM_VERTICAL), -Math.sin(HUB_TILT_FROM_VERTICAL)),
    ARM_LENGTH,
  )

  return { velocity, position: raw.map((r) => onArmSphere(r, hub)), hub, accelBias }
}

/**
 * Hold a drifting position on the arm sphere. Direction comes from the integral,
 * distance from the arm, which is a fixed length and cannot drift.
 */
function onArmSphere(rawPosition: Vec3, hub: Vec3): Vec3 {
  const fromHub = sub(rawPosition, hub)
  const d = len(fromHub)
  if (d < 1e-6) return v3(0, 0, 0)
  return add(hub, scale(normalize(fromHub), ARM_LENGTH))
}

/**
 * Scale error in the accelerometer, read off the still moment at address.
 *
 * Only the part along gravity is recoverable. A sitting sensor reads one vector,
 * and there is no way to tell a sensor that is tilted from one that is biased
 * sideways: both move the reading the same way. So the sideways part gets
 * absorbed into the address frame as a small tilt, and what is left over here is
 * the magnitude, which is the piece that would otherwise integrate straight into
 * the velocity estimate.
 *
 * A calibrated sensor makes both small. An uncalibrated one costs roughly a
 * degree of face angle per twenty milli-g, and no amount of maths here recovers it.
 */
export function estimateAccelBias(
  stillWindow: readonly ImuSample[],
  addressQuat: Quat,
): Vec3 {
  if (stillWindow.length === 0) return v3(0, 0, 0)

  let sum = v3(0, 0, 0)
  for (const s of stillWindow) sum = add(sum, accelOf(s))
  const measured = scale(sum, 1 / stillWindow.length)

  const magnitude = len(measured)
  if (magnitude < 1e-6) return v3(0, 0, 0)
  // Whatever the reading is longer or shorter than one g, along its own direction.
  void addressQuat
  return scale(measured, (magnitude - GRAVITY) / magnitude)
}
