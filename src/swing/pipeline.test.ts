import { describe, expect, it } from 'vitest'
import { getClub } from '../data/clubs'
import { getSwing } from '../imu/mock/swings'
import type { SwingId } from '../imu/mock/swings'
import { SwingDetector, type SwingCapture } from './detect'
import { analyzeSwing } from './pipeline'

const CLUB = getClub('7i')
const MPH = 2.23694
const YARDS = 1.09361

function capture(id: SwingId): SwingCapture {
  const { samples } = getSwing(id)
  let out: SwingCapture | null = null
  const d = new SwingDetector((c) => (out = c))
  for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8))
  if (!out) throw new Error(`no capture for ${id}`)
  return out
}

const analyze = (id: SwingId) => analyzeSwing(capture(id), CLUB, 'right')

describe('round trip against ground truth', () => {
  // This is the test that proves the chain. The synthesizer knows exactly what
  // face angle, path, and speed it produced. Everything in between, detection,
  // bias, integration, drift, kinematics, has to give those numbers back from
  // nothing but noisy quantized samples.
  for (const id of ['good', 'slice', 'hook'] as const) {
    it(`recovers the ${id} swing`, () => {
      const { stats } = analyze(id)
      const truth = getSwing(id).truth

      expect(stats.faceAngleDeg, 'face').toBeCloseTo(truth.faceAngleDeg, 0)
      expect(stats.pathAngleDeg, 'path').toBeCloseTo(truth.pathAngleDeg, 0)
      expect(stats.faceToPathDeg, 'face to path').toBeCloseTo(truth.faceToPathDeg, 0)
      // Attack angle is the touchiest number here. It is a small vertical
      // component of a large velocity vector, so the same fraction of a percent
      // that leaves speed inside half a metre per second shows up as a degree.
      expect(Math.abs(stats.attackAngleDeg - truth.attackAngleDeg), 'attack').toBeLessThan(1.5)
      expect(stats.clubheadSpeedMps, 'speed').toBeCloseTo(truth.clubheadSpeedMps, 0)
    })
  }

  it('recovers timing', () => {
    const { stats } = analyze('good')
    const truth = getSwing('good').truth
    expect(stats.backswingSec).toBeCloseTo(truth.backswingSec, 1)
    // Downswing is measured from the top, so it takes in the transition pause.
    expect(stats.downswingSec).toBeGreaterThan(truth.downswingSec)
    expect(stats.downswingSec).toBeLessThan(truth.downswingSec + 0.12)
  })

  it('survives the waggles and still gets the same answer', () => {
    const clean = analyze('good').stats
    const waggled = analyze('waggle').stats
    expect(waggled.faceToPathDeg).toBeCloseTo(clean.faceToPathDeg, 0)
    expect(waggled.clubheadSpeedMps).toBeCloseTo(clean.clubheadSpeedMps, 0)
  })
})

describe('swing stats', () => {
  it('reports a tempo near the classic three to one', () => {
    const { stats } = analyze('good')
    expect(stats.tempoRatio).toBeGreaterThan(1.8)
    expect(stats.tempoRatio).toBeLessThan(3.6)
  })

  it('finds a pause at the top', () => {
    const { stats } = analyze('good')
    expect(stats.transitionPauseSec).toBeGreaterThan(0)
    expect(stats.transitionPauseSec).toBeLessThan(0.35)
  })

  it('peaks late in the downswing, near impact', () => {
    const { stats } = analyze('good')
    expect(stats.peakRateDps).toBeGreaterThan(1500)
    expect(stats.peakRateSec).toBeGreaterThan(stats.impactSec - 0.1)
    expect(stats.peakRateSec).toBeLessThanOrEqual(stats.impactSec)
  })

  it('fits a swing plane close to the lie angle of the club', () => {
    const { stats } = analyze('good')
    expect(stats.swingPlaneDeg).toBeGreaterThan(50)
    expect(stats.swingPlaneDeg).toBeLessThan(75)
  })

  it('separates the three swings by face to path', () => {
    const good = analyze('good').stats
    const slice = analyze('slice').stats
    const hook = analyze('hook').stats
    expect(slice.faceToPathDeg).toBeGreaterThan(6)
    expect(hook.faceToPathDeg).toBeLessThan(-6)
    expect(Math.abs(good.faceToPathDeg)).toBeLessThan(2.5)
  })

  it('calibrates cleanly with no warning', () => {
    expect(analyze('good').calibration.warning).toBeNull()
  })
})

describe('ball flight', () => {
  it('carries a seven iron a believable distance', () => {
    const { flight, stats } = analyze('good')
    const carryYards = flight.carryM * YARDS
    const ballMph = flight.ballSpeedMps * MPH
    const clubMph = stats.clubheadSpeedMps * MPH

    // Roughly 64 mph clubhead, so about 88 mph ball speed and 140 yards carry.
    expect(clubMph).toBeGreaterThan(55)
    expect(ballMph).toBeCloseTo(clubMph * CLUB.smash, 0)
    expect(carryYards).toBeGreaterThan(110)
    expect(carryYards).toBeLessThan(175)
  })

  it('delofts the club by the attack angle', () => {
    const { flight, stats } = analyze('good')
    expect(flight.dynamicLoftDeg).toBeCloseTo(CLUB.loft + stats.attackAngleDeg, 6)
    expect(flight.dynamicLoftDeg).toBeLessThan(CLUB.loft) // irons hit down
    expect(flight.launchAngleDeg).toBeLessThan(flight.dynamicLoftDeg)
  })

  it('curves a slice right and a hook left', () => {
    const slice = analyze('slice').flight
    const hook = analyze('hook').flight
    expect(slice.offlineM).toBeGreaterThan(0)
    expect(hook.offlineM).toBeLessThan(0)
    expect(slice.shape).toBe('slice')
    expect(hook.shape).toBe('hook')
  })

  it('leaves a good swing near straight', () => {
    const good = analyze('good').flight
    expect(Math.abs(good.offlineM * YARDS)).toBeLessThan(12)
  })

  it('costs a slice distance against a straight strike', () => {
    // Same clubhead speed, but sidespin and a steeper strike give up carry.
    expect(analyze('slice').flight.carryM).toBeLessThan(analyze('good').flight.carryM)
  })

  it('reaches a sensible apex and lands back on the ground', () => {
    const { flight } = analyze('good')
    expect(flight.apexM).toBeGreaterThan(10)
    expect(flight.apexM).toBeLessThan(50)
    expect(flight.path.length).toBeGreaterThan(20)
    expect(flight.path[flight.path.length - 1].y).toBeCloseTo(0, 2)
  })

  it('flies further with a longer club', () => {
    const cap = capture('good')
    const seven = analyzeSwing(cap, getClub('7i'), 'right')
    const four = analyzeSwing(cap, getClub('4i'), 'right')
    expect(four.flight.carryM).toBeGreaterThan(seven.flight.carryM)
  })

  it('spins more with a wedge than a long iron', () => {
    const cap = capture('good')
    expect(analyzeSwing(cap, getClub('sw'), 'right').flight.backspinRpm).toBeGreaterThan(
      analyzeSwing(cap, getClub('4i'), 'right').flight.backspinRpm,
    )
  })
})

describe('analysis output for the replay', () => {
  it('hands back a clubhead path and matching times', () => {
    const a = analyze('good')
    expect(a.clubheadPath.length).toBe(a.orientation.length)
    expect(a.times.length).toBe(a.orientation.length)
    expect(a.times[0]).toBe(0)
    expect(a.times[a.times.length - 1]).toBeGreaterThan(1)
  })

  it('covers address through impact and into the follow through', () => {
    const a = analyze('good')
    expect(a.stats.impactSec).toBeLessThan(a.times[a.times.length - 1])
    expect(a.times[a.times.length - 1] - a.stats.impactSec).toBeGreaterThan(0.25)
  })
})
