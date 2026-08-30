import { type Club, effectiveShaftLength } from '../../data/clubs'
import { type Quat, conj, fromAngularRate, mul, normalize as qnorm, rotate } from '../../math/quat'
import {
  type Vec3,
  add,
  addScaled,
  cross,
  len,
  normalize,
  reject,
  rotateAbout,
  sub,
  scale,
  v3,
} from '../../math/vec3'
import {
  DEG,
  FACE_NORMAL_S,
  GRAVITY,
  type Handedness,
  SHAFT_AXIS_S,
  fromSensorAxes,
  horizontalAngle,
} from '../../swing/frames'
import { ACCEL_LSB, GYRO_LSB, type ImuSample, quantize } from '../types'
import { gaussian, mulberry32 } from './rng'

export interface Waggle {
  /** Start time measured from the beginning of the still period. */
  atSec: number
  peakDps: number
  durSec: number
}

export interface SwingParams {
  club: Club
  hand: Handedness
  /** Shaft angle off the ground at address. */
  lieDeg: number
  /** Swing plane yaw about vertical. Negative swings in to out. */
  planeYawDeg: number
  /** Face rotation added through the downswing. Positive opens the face. */
  faceRollDeg: number
  /** Unsettled time right after the record tap, before the golfer goes still. */
  preRollSec: number
  settleSec: number
  backswingSec: number
  pauseSec: number
  downswingSec: number
  followSec: number
  /** Degrees short of a full return to address at impact. Makes irons hit down. */
  impactLagDeg: number
  /** Total shaft rotation in the backswing, about the plane normal. */
  sweepDeg: number
  waggles: Waggle[]
  gyroBiasDps: Vec3
  gyroNoiseDps: number
  accelNoiseG: number
  /** Accelerometer bias. Small, but it integrates into grip velocity error. */
  accelBiasG: Vec3
  seed: number
}

export interface SwingTruth {
  /** Noise free orientation, sensor to world, one per sample. */
  q: Quat[]
  /** Noise free angular velocity in world coordinates, one per sample. */
  omegaW: Vec3[]
  /** Where the grip really was, relative to its address position. */
  gripPos: Vec3[]
  /** And how fast it was moving. The analysis has to recover this from accel. */
  gripVel: Vec3[]
  takeawayIndex: number
  topIndex: number
  impactIndex: number
  addressQuat: Quat
  faceAngleDeg: number
  pathAngleDeg: number
  faceToPathDeg: number
  clubheadSpeedMps: number
  attackAngleDeg: number
  backswingSec: number
  downswingSec: number
}

export interface SynthResult {
  samples: ImuSample[]
  truth: SwingTruth
  rateHz: number
}

// The hands sit up and back from the grip. The synthesizer swings the grip on an
// arc about this hub so the accelerometer sees real motion, unlike the fixed grip
// model the analysis uses. Keeping the two models different is the point, it
// stops the pipeline being tested against its own assumptions.
const HUB = v3(0, 0.55, -0.35)
/** Hands turn a good deal less than the shaft, the rest is wrist hinge. */
const HAND_FRACTION = 0.3
const IMPACT_PEAK_G = 16

/** Address pose with the club grounded and the face square to the target. */
export function addressPose(lieDeg: number, hand: Handedness): Quat {
  const fromVertical = (90 - lieDeg) * DEG
  const side = hand === 'right' ? 1 : -1
  const zs = v3(0, -Math.cos(fromVertical), side * Math.sin(fromVertical))
  const xs = normalize(reject(v3(0, 0, -side), zs))
  const ys = cross(zs, xs)
  return fromSensorAxes(xs, ys, zs)
}

export function synthesizeSwing(p: SwingParams): SynthResult {
  const rateHz = 400
  const dt = 1 / rateHz
  const rand = mulberry32(p.seed)

  const tTakeaway = p.preRollSec + p.settleSec
  const tTop = tTakeaway + p.backswingSec
  const tDownStart = tTop + p.pauseSec
  const tImpact = tDownStart + p.downswingSec
  const total = tImpact + p.followSec
  const n = Math.round(total / dt)

  const q0 = addressPose(p.lieDeg, p.hand)
  const shaft0 = rotate(q0, SHAFT_AXIS_S)

  // Swing plane normal. Backswing is positive about it, and yawing it about
  // vertical is what makes the path in to out or out to in.
  const baseNormal = normalize(cross(v3(1, 0, 0), shaft0))
  const planeNormal = rotateAbout(baseNormal, v3(0, 1, 0), p.planeYawDeg * DEG)

  const sweep = p.sweepDeg * DEG
  const backAmp = sweep / p.backswingSec
  // Stopping just short of a full return puts impact before the low point of the
  // arc, which is what gives an iron its descending blow.
  const downAmp = (2.6 * (sweep - p.impactLagDeg * DEG)) / p.downswingSec
  const rollRate = (p.faceRollDeg * DEG) / p.downswingSec

  // Pass one: integrate orientation and trace the grip arc.
  const q: Quat[] = new Array(n)
  const omegaW: Vec3[] = new Array(n)
  const grip: Vec3[] = new Array(n)
  const handRadius = len(HUB)
  const handStart = normalize(scale(HUB, -1))

  let cur = q0
  let phi = 0
  for (let i = 0; i < n; i++) {
    const t = i * dt
    const planeRate =
      swingRate(t, p, tTakeaway, tTop, tDownStart, tImpact, backAmp, downAmp) + waggleRate(t, p)
    const shaftW = rotate(cur, SHAFT_AXIS_S)
    const roll = t >= tDownStart && t < tImpact ? rollRate : 0

    let w = addScaled(scale(planeNormal, planeRate), shaftW, roll)
    if (t < p.preRollSec) w = addScaled(w, prerollAxis(t), prerollRate(t, p.preRollSec))

    q[i] = cur
    omegaW[i] = w
    // The hands trail the shaft, so the grip arc only gets a fraction of the sweep.
    grip[i] = addScaled(HUB, rotateAbout(handStart, planeNormal, phi * HAND_FRACTION), handRadius)

    phi += planeRate * dt
    cur = qnorm(mul(fromAngularRate(w, dt), cur))
  }

  const takeawayIndex = Math.round(tTakeaway / dt)
  const topIndex = Math.round(tTop / dt)
  const impactIndex = Math.min(n - 1, Math.round(tImpact / dt))

  // Pass two: turn the motion into what the chip would actually report.
  const samples: ImuSample[] = new Array(n)
  const bias = scale(p.gyroBiasDps, DEG)
  const accelBias = scale(p.accelBiasG, GRAVITY)
  const gyroSigma = p.gyroNoiseDps * DEG
  const accelSigma = p.accelNoiseG * GRAVITY

  for (let i = 0; i < n; i++) {
    const gripAccel = secondDifference(grip, i, dt)
    // Specific force is acceleration minus gravity, which is why a still sensor
    // reads one g upward instead of zero.
    const specific = addScaled(gripAccel, v3(0, GRAVITY, 0), 1)
    let aS = rotate(conj(q[i]), specific)
    const gS = rotate(conj(q[i]), omegaW[i])

    const spike = impactSpike(i, impactIndex)
    if (spike > 0) aS = addScaled(aS, FACE_NORMAL_S, -spike * IMPACT_PEAK_G * GRAVITY)

    samples[i] = {
      t: i * dt,
      ax: quantize(aS.x + accelBias.x + gaussian(rand) * accelSigma, ACCEL_LSB),
      ay: quantize(aS.y + accelBias.y + gaussian(rand) * accelSigma, ACCEL_LSB),
      az: quantize(aS.z + accelBias.z + gaussian(rand) * accelSigma, ACCEL_LSB),
      gx: quantize(gS.x + bias.x + gaussian(rand) * gyroSigma, GYRO_LSB),
      gy: quantize(gS.y + bias.y + gaussian(rand) * gyroSigma, GYRO_LSB),
      gz: quantize(gS.z + bias.z + gaussian(rand) * gyroSigma, GYRO_LSB),
    }
  }

  // Grip motion, expressed relative to where the grip sat at address, which is
  // the origin the analysis works in.
  const gripPos = grip.map((g) => sub(g, grip[0]))
  const gripVel = gripPos.map((_, i) => firstDifference(gripPos, i, dt))

  return {
    samples,
    rateHz,
    truth: {
      q,
      omegaW,
      gripPos,
      gripVel,
      takeawayIndex,
      topIndex,
      impactIndex,
      addressQuat: q0,
      backswingSec: p.backswingSec,
      downswingSec: p.downswingSec,
      ...truthStatsAt(q, omegaW, gripVel, impactIndex, effectiveShaftLength(p.club)),
    },
  }
}

/**
 * Ground truth angles read straight off the clean orientation. The pipeline has
 * to recover these from noisy, biased, quantized samples.
 */
export function truthStatsAt(
  q: readonly Quat[],
  omegaW: readonly Vec3[],
  gripVel: readonly Vec3[],
  impactIndex: number,
  shaft: number,
) {
  const i = impactIndex
  const faceW = rotate(q[i], FACE_NORMAL_S)
  const r = scale(rotate(q[i], SHAFT_AXIS_S), shaft)
  // The hands are moving too, so the clubhead carries both terms. Leaving the
  // grip term out is what made the old fixed grip model read about 20 percent low.
  const v = add(gripVel[i], cross(omegaW[i], r))
  const horizontal = Math.hypot(v.x, v.z)
  return {
    faceAngleDeg: horizontalAngle(faceW) / DEG,
    pathAngleDeg: horizontalAngle(v) / DEG,
    faceToPathDeg: (horizontalAngle(faceW) - horizontalAngle(v)) / DEG,
    clubheadSpeedMps: len(v),
    attackAngleDeg: Math.atan2(v.y, horizontal) / DEG,
  }
}

function swingRate(
  t: number,
  p: SwingParams,
  tTakeaway: number,
  tTop: number,
  tDownStart: number,
  tImpact: number,
  backAmp: number,
  downAmp: number,
): number {
  if (t < tTakeaway) return 0
  if (t < tTop) {
    // Raised cosine, so the club eases into the takeaway and out again at the top.
    const u = (t - tTakeaway) / p.backswingSec
    return backAmp * (1 - Math.cos(2 * Math.PI * u))
  }
  if (t < tDownStart) return 0
  if (t < tImpact) {
    // Rising profile peaking at impact, which is where a real swing peaks.
    const u = (t - tDownStart) / p.downswingSec
    return -downAmp * Math.pow(u, 1.6)
  }
  return -downAmp * Math.exp(-(t - tImpact) / 0.09)
}

/**
 * Waggles are a full sine cycle, so they reverse and end up back where they
 * started. That reversal is what separates them from a takeaway.
 */
function waggleRate(t: number, p: SwingParams): number {
  let sum = 0
  for (const w of p.waggles) {
    const s = p.preRollSec + w.atSec
    if (t >= s && t < s + w.durSec) {
      sum += w.peakDps * DEG * Math.sin((2 * Math.PI * (t - s)) / w.durSec)
    }
  }
  return sum
}

// Small wandering motion right after the record tap, before the golfer settles.
const prerollRate = (t: number, dur: number): number =>
  8 * DEG * Math.sin(t * 7.3) * (1 - t / dur)

const prerollAxis = (t: number): Vec3 => normalize(v3(Math.sin(t * 2.1), 1, Math.cos(t * 1.7)))

/** Central second difference, clamped at the ends. */
function secondDifference(p: Vec3[], i: number, dt: number): Vec3 {
  const a = p[Math.max(0, i - 1)]
  const b = p[i]
  const c = p[Math.min(p.length - 1, i + 1)]
  const s = 1 / (dt * dt)
  return v3((a.x - 2 * b.x + c.x) * s, (a.y - 2 * b.y + c.y) * s, (a.z - 2 * b.z + c.z) * s)
}

/** Two sample impact hit. Real contact is well under one sample at 400 Hz. */
function impactSpike(i: number, impactIndex: number): number {
  if (i === impactIndex) return 1
  if (i === impactIndex + 1) return 0.45
  return 0
}



/** Central first difference, clamped at the ends. */
function firstDifference(p: Vec3[], i: number, dt: number): Vec3 {
  const a = p[Math.max(0, i - 1)]
  const b = p[Math.min(p.length - 1, i + 1)]
  const span = (Math.min(p.length - 1, i + 1) - Math.max(0, i - 1)) * dt
  if (span <= 0) return v3(0, 0, 0)
  return v3((b.x - a.x) / span, (b.y - a.y) / span, (b.z - a.z) / span)
}
