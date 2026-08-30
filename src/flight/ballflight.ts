import type { Club } from '../data/clubs'
import { type Vec3, addScaled, cross, len, normalize, rotateAbout, v3 } from '../math/vec3'
import { DEG, GRAVITY, WORLD_UP } from '../swing/frames'
import type { SwingStats } from '../swing/stats'

// A golf ball, and the air it flies through. Fixed on purpose, none of this is
// worth exposing as a setting.
const BALL = {
  massKg: 0.04593,
  diameterM: 0.04267,
} as const
const AIR_DENSITY = 1.225
const AREA = (Math.PI * BALL.diameterM * BALL.diameterM) / 4
const FORCE_K = (0.5 * AIR_DENSITY * AREA) / BALL.massKg

// Both coefficients rise with the spin ratio, spin surface speed over airspeed.
// Modelling that rather than fixing them matters: a low spin long iron launches
// much flatter than a wedge, and constant coefficients would leave it with more
// lift than it earns and rob it of the carry it should get.
const LIFT_PER_SPIN_RATIO = 1.0
const MAX_LIFT_COEFFICIENT = 0.33
const BASE_DRAG = 0.21
const DRAG_PER_SPIN_RATIO = 0.25

/** Ball starts closer to where the face points than where the club is moving. */
const FACE_WEIGHT = 0.85
/** Degrees of spin axis tilt per degree of face to path. */
const SPIN_AXIS_PER_DEGREE = 3.5
const MAX_SPIN_AXIS = 40
/** Rough backspin from dynamic loft. Enough to size the lift, no more. */
const SPIN_PER_LOFT_RPM = 220

const STEP = 0.001
const MAX_FLIGHT_SEC = 15

export type ShotShape = 'straight' | 'draw' | 'fade' | 'hook' | 'slice'

export interface BallFlight {
  dynamicLoftDeg: number
  launchAngleDeg: number
  /** Horizontal direction the ball starts on, relative to the target line. */
  startDirectionDeg: number
  ballSpeedMps: number
  backspinRpm: number
  /** Positive tilts the ball right, negative left. */
  spinAxisDeg: number
  carryM: number
  /** Sideways miss at landing. Positive right, negative left. */
  offlineM: number
  apexM: number
  shape: ShotShape
  /** Sampled trajectory for drawing, world coordinates. */
  path: Vec3[]
}

/**
 * A reasonable estimate, not a launch monitor.
 *
 * We have no spin data, so face to path stands in for the spin axis. That is the
 * right proxy: face to path is what actually curves a golf ball, and it is the
 * one thing a grip mounted gyro can see clearly.
 */
export function estimateFlight(stats: SwingStats, club: Club): BallFlight {
  const dynamicLoftDeg = Math.max(1, club.loft + stats.attackAngleDeg)
  const launchAngleDeg = dynamicLoftDeg * club.launchFactor
  const ballSpeedMps = stats.clubheadSpeedMps * club.smash
  const backspinRpm = SPIN_PER_LOFT_RPM * dynamicLoftDeg
  const spinAxisDeg = clamp(
    stats.faceToPathDeg * SPIN_AXIS_PER_DEGREE,
    -MAX_SPIN_AXIS,
    MAX_SPIN_AXIS,
  )
  const startDirectionDeg =
    FACE_WEIGHT * stats.faceAngleDeg + (1 - FACE_WEIGHT) * stats.pathAngleDeg

  const launch = launchAngleDeg * DEG
  const start = startDirectionDeg * DEG
  const velocity = v3(
    ballSpeedMps * Math.cos(launch) * Math.cos(start),
    ballSpeedMps * Math.sin(launch),
    ballSpeedMps * Math.cos(launch) * Math.sin(start),
  )

  const spinRadPerSec = (backspinRpm * 2 * Math.PI) / 60
  const { path, carryM, offlineM, apexM } = integrate(
    velocity,
    spinAxisDeg * DEG,
    spinRadPerSec * (BALL.diameterM / 2),
  )

  return {
    dynamicLoftDeg,
    launchAngleDeg,
    startDirectionDeg,
    ballSpeedMps,
    backspinRpm,
    spinAxisDeg,
    carryM,
    offlineM,
    apexM,
    shape: classify(offlineM),
    path,
  }
}

/**
 * Forward Euler at 1ms with quadratic drag and a tilted Magnus lift.
 * `spinSurfaceMps` is the speed of the ball's surface due to spin, which is what
 * the spin ratio is measured against.
 */
function integrate(v0: Vec3, spinAxisRad: number, spinSurfaceMps: number) {
  let p = v3(0, 0, 0)
  let v = v0
  const path: Vec3[] = [p]
  let apexM = 0

  for (let step = 0; step * STEP < MAX_FLIGHT_SEC; step++) {
    const speed = len(v)
    if (speed < 1e-6) break

    const vHat = normalize(v)
    // Lift acts across the flight path. Tilting it about the path is what turns
    // backspin into a curve, so this one rotation is the whole shot shape.
    const right = normalize(cross(vHat, WORLD_UP))
    const liftDir = rotateAbout(normalize(cross(right, vHat)), vHat, spinAxisRad)

    const spinRatio = spinSurfaceMps / speed
    const lift = Math.min(MAX_LIFT_COEFFICIENT, LIFT_PER_SPIN_RATIO * spinRatio)
    const drag = BASE_DRAG + DRAG_PER_SPIN_RATIO * spinRatio

    let a = v3(0, -GRAVITY, 0)
    a = addScaled(a, vHat, -FORCE_K * drag * speed * speed)
    a = addScaled(a, liftDir, FORCE_K * lift * speed * speed)

    const next = addScaled(p, v, STEP)
    v = addScaled(v, a, STEP)

    if (next.y <= 0 && p.y > 0) {
      // Land exactly on the ground rather than a step past it.
      const f = p.y / (p.y - next.y)
      p = addScaled(p, { x: next.x - p.x, y: next.y - p.y, z: next.z - p.z }, f)
      path.push(p)
      break
    }

    p = next
    apexM = Math.max(apexM, p.y)
    // One point every 20ms is plenty to draw a smooth arc.
    if (step % 20 === 0) path.push(p)
  }

  return { path, carryM: p.x, offlineM: p.z, apexM }
}

function classify(offlineM: number): ShotShape {
  const yards = offlineM * 1.09361
  const magnitude = Math.abs(yards)
  if (magnitude < 4) return 'straight'
  if (magnitude < 18) return yards > 0 ? 'fade' : 'draw'
  return yards > 0 ? 'slice' : 'hook'
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

export const shapeLabel: Record<ShotShape, string> = {
  straight: 'Straight',
  draw: 'Draw',
  fade: 'Fade',
  hook: 'Hook',
  slice: 'Slice',
}

export const spinAxisSummary = (flight: BallFlight): string =>
  `${Math.abs(flight.spinAxisDeg).toFixed(0)} deg ${flight.spinAxisDeg > 0 ? 'right' : 'left'}`

