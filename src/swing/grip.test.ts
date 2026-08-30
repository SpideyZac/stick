import { describe, expect, it } from 'vitest'
import { getClub } from '../data/clubs'
import { getSwing } from '../imu/mock/swings'
import type { SwingId } from '../imu/mock/swings'
import { len, sub } from '../math/vec3'
import { calibrate } from './calibrate'
import { SwingDetector, type SwingCapture } from './detect'
import { ARM_LENGTH, trackGrip } from './grip'
import { integrateOrientation } from './orient'

const CLUB = getClub('7i')

function capture(id: SwingId): SwingCapture {
  const { samples } = getSwing(id)
  let out: SwingCapture | null = null
  const d = new SwingDetector((c) => (out = c))
  for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8))
  if (!out) throw new Error(`no capture for ${id}`)
  return out
}

function track(id: SwingId) {
  const cap = capture(id)
  const cal = calibrate(cap.still, CLUB, 'right')
  const orientation = integrateOrientation(cap.samples, cal)
  const grip = trackGrip(cap.samples, orientation.q, cap.still, cal.addressQuat)
  const truth = getSwing(id).truth
  return { cap, grip, truth, offset: Math.round(cap.samples[0].t * 400) }
}

describe('grip velocity from the accelerometer', () => {
  it('starts from rest, because the club is sitting still at address', () => {
    const { grip } = track('good')
    expect(len(grip.velocity[0])).toBe(0)
  })

  it('recovers hand speed at impact', () => {
    for (const id of ['good', 'slice', 'hook'] as const) {
      const { grip, truth, cap, offset } = track(id)
      const got = grip.velocity[cap.impactIndex]
      const want = truth.gripVel[offset + cap.impactIndex]
      // One integration from a known zero start, over about a second.
      expect(len(sub(got, want)), `${id} vector`).toBeLessThan(0.8)
      expect(len(got), `${id} speed`).toBeCloseTo(len(want), 0)
    }
  })

  it('finds hands moving at a realistic speed through the ball', () => {
    const { grip, cap } = track('good')
    const mps = len(grip.velocity[cap.impactIndex])
    // Amateur hands run about five to eight metres per second at contact.
    expect(mps).toBeGreaterThan(4)
    expect(mps).toBeLessThan(9)
  })

  it('tracks the whole hand path, not just the moment of impact', () => {
    const { grip, truth, cap, offset } = track('good')
    let worst = 0
    for (let i = 0; i < cap.impactIndex; i++) {
      worst = Math.max(worst, len(sub(grip.velocity[i], truth.gripVel[offset + i])))
    }
    expect(worst).toBeLessThan(1.2)
  })

  it('holds the hands on the arm sphere so they never stretch or collapse', () => {
    // This is the whole reason position is constrained rather than integrated.
    const { grip } = track('good')
    for (const p of grip.position) {
      expect(len(sub(p, grip.hub))).toBeCloseTo(ARM_LENGTH, 6)
    }
  })

  it('puts the hands back near address height at impact', () => {
    const { grip, cap } = track('good')
    const start = grip.position[0]
    const atImpact = grip.position[cap.impactIndex]
    // Hands travel forward through the ball but do not climb much.
    expect(Math.abs(atImpact.y - start.y)).toBeLessThan(0.25)
  })

  it('moves the hands a sensible distance over the swing', () => {
    const { grip, cap } = track('good')
    const travel = len(sub(grip.position[cap.impactIndex], grip.position[0]))
    expect(travel).toBeGreaterThan(0.15)
    expect(travel).toBeLessThan(1.4)
  })
})
