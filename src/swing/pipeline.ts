import type { Club } from '../data/clubs'
import { effectiveShaftLength } from '../data/clubs'
import type { ImuSample } from '../imu/types'
import type { Quat } from '../math/quat'
import type { Vec3 } from '../math/vec3'
import { type BallFlight, estimateFlight } from '../flight/ballflight'
import { type Calibration, calibrate } from './calibrate'
import type { SwingCapture } from './detect'
import type { Handedness } from './frames'
import { clubheadOffset } from './kinematics'
import { integrateOrientation } from './orient'
import { type Phases, segment } from './phases'
import { type SwingStats, computeStats } from './stats'

export interface SwingAnalysis {
  club: Club
  hand: Handedness
  calibration: Calibration
  stats: SwingStats
  flight: BallFlight
  phases: Phases
  /** Orientation per sample, for the replay. */
  orientation: Quat[]
  /** Clubhead position relative to the grip, per sample. */
  clubheadPath: Vec3[]
  /** Seconds since t=0, per sample. */
  times: number[]
  shaftLength: number
}

/**
 * Everything from a captured swing to the numbers on screen. The UI knows about
 * this and nothing else, and the only thing feeding it is an ImuSource, so a
 * real BLE sensor drops in without touching any of this.
 */
export function analyzeSwing(
  capture: SwingCapture,
  club: Club,
  hand: Handedness,
): SwingAnalysis {
  const calibration = calibrate(capture.still, club, hand)
  const track = integrateOrientation(capture.samples, calibration)
  const phases = segment(capture.samples, track, capture.impactIndex)
  const stats = computeStats(capture.samples, track, phases, club)
  const flight = estimateFlight(stats, club)

  const shaftLength = effectiveShaftLength(club)
  const t0 = capture.samples[0].t

  return {
    club,
    hand,
    calibration,
    stats,
    flight,
    phases,
    orientation: track.q,
    clubheadPath: track.q.map((q) => clubheadOffset(q, shaftLength)),
    times: capture.samples.map((s: ImuSample) => s.t - t0),
    shaftLength,
  }
}
