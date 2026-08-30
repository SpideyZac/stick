import { getClub } from '../../data/clubs'
import { v3 } from '../../math/vec3'
import { type SwingParams, type SynthResult, synthesizeSwing } from './synth'

export type SwingId = 'good' | 'slice' | 'hook' | 'waggle'

/**
 * A steady mid iron swing. Everything else is this with a few numbers moved, so
 * differences between the canned swings are only ever the thing being modelled.
 */
const BASE: SwingParams = {
  club: getClub('7i'),
  hand: 'right',
  lieDeg: 62,
  planeYawDeg: 0,
  faceRollDeg: 0,
  impactLagDeg: 3,
  preRollSec: 0.6,
  settleSec: 0.7,
  backswingSec: 0.78,
  pauseSec: 0.05,
  downswingSec: 0.28,
  followSec: 0.3,
  sweepDeg: 200,
  waggles: [],
  // A real BMI270 turns up with a degree or two of bias on each axis. Left in
  // the mock on purpose, removing it is the biggest single win on drift.
  gyroBiasDps: v3(1.4, -0.9, 2.1),
  gyroNoiseDps: 0.5,
  accelNoiseG: 0.02,
  seed: 7,
}

export const SWING_PRESETS: Record<SwingId, SwingParams> = {
  // Square face, path just barely in to out.
  good: { ...BASE, planeYawDeg: 1.8, faceRollDeg: -1.2, seed: 11 },

  // Out to in path with the face open to it. Steep, which is what slicers do.
  slice: { ...BASE, planeYawDeg: 7, faceRollDeg: 7, seed: 23 },

  // In to out path with the face shut to it. Shallow, which is what hookers do.
  hook: { ...BASE, planeYawDeg: -7, faceRollDeg: -9, seed: 41 },

  // Same swing as `good`, but the golfer waggles three times first. The last one
  // is deliberately big and slow enough to survive the fast confirmation checks,
  // so something later has to throw it out.
  waggle: {
    ...BASE,
    planeYawDeg: 1.8,
    faceRollDeg: -1.2,
    settleSec: 1.8,
    seed: 11,
    waggles: [
      { atSec: 0.15, peakDps: 110, durSec: 0.18 },
      { atSec: 0.55, peakDps: 110, durSec: 0.32 },
      { atSec: 1.0, peakDps: 150, durSec: 0.5 },
    ],
  },
}

export const SWING_LABELS: Record<SwingId, string> = {
  good: 'Good swing',
  slice: 'Slice tendency',
  hook: 'Hook tendency',
  waggle: 'Waggle then swing',
}

export const SWING_IDS = Object.keys(SWING_PRESETS) as SwingId[]

const cache = new Map<string, SynthResult>()

/** Synthesis is deterministic, so the same club and swing only gets built once. */
export function getSwing(id: SwingId, clubId?: string): SynthResult {
  const key = `${id}:${clubId ?? BASE.club.id}`
  const hit = cache.get(key)
  if (hit) return hit

  const preset = SWING_PRESETS[id]
  const built = synthesizeSwing(clubId ? { ...preset, club: getClub(clubId) } : preset)
  cache.set(key, built)
  return built
}
