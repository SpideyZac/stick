import { describe, expect, it } from 'vitest'
import { getClub } from '../data/clubs'
import { getSwing } from '../imu/mock/swings'
import type { ImuSample } from '../imu/types'
import { angleBetweenQuats, rotate } from '../math/quat'
import { len, v3 } from '../math/vec3'
import { biasDps, calibrate } from './calibrate'
import { SwingDetector, type SwingCapture } from './detect'
import { DEG, GRAVITY, toDeg } from './frames'
import { clubheadOffset } from './kinematics'
import { integrateOrientation } from './orient'

const CLUB = getClub('7i')

function capture(id: 'good' | 'slice' | 'hook' | 'waggle'): SwingCapture {
  const { samples } = getSwing(id)
  let out: SwingCapture | null = null
  const d = new SwingDetector((c) => (out = c))
  for (let i = 0; i < samples.length; i += 8) d.push(samples.slice(i, i + 8))
  if (!out) throw new Error(`no capture for ${id}`)
  return out
}

describe('calibration', () => {
  it('recovers the gyro bias the mock injected', () => {
    const cal = calibrate(capture('good').still, CLUB, 'right')
    // The mock uses (1.4, -0.9, 2.1) dps, magnitude about 2.7.
    expect(biasDps(cal)).toBeGreaterThan(2);
    expect(biasDps(cal)).toBeLessThan(3.5)
    expect(toDeg(cal.gyroBias.x)).toBeCloseTo(1.4, 0)
    expect(toDeg(cal.gyroBias.y)).toBeCloseTo(-0.9, 0)
    expect(toDeg(cal.gyroBias.z)).toBeCloseTo(2.1, 0)
  })

  it('recovers the pose the golfer actually settled into', () => {
    const cap = capture('good')
    const cal = calibrate(cap.still, CLUB, 'right')
    // Not the nominal starting pose. The golfer fidgets for half a second after
    // tapping record, so they settle about a degree off it, and the reference
    // frame has to be where they really ended up.
    const settled = getSwing('good').truth.q[Math.round(cap.still[0].t * 400)]
    // The floor here is accelerometer bias, not the maths. A sensor sitting still
    // gives one vector, and a few milli-g of sideways bias looks exactly like a
    // fraction of a degree of tilt. Nothing recovers that without a second reference.
    expect(toDeg(angleBetweenQuats(cal.addressQuat, settled))).toBeLessThan(1)
  })

  it('reads back the lie angle and a sane grip height', () => {
    const cal = calibrate(capture('good').still, CLUB, 'right')
    expect(cal.lieAngleDeg).toBeCloseTo(62, 0)
    expect(cal.gripHeight).toBeGreaterThan(0.6)
    expect(cal.gripHeight).toBeLessThan(0.95)
    expect(cal.warning).toBeNull()
  })

  it('flags a club that is not grounded at address', () => {
    // Sensor lying flat, so the shaft is horizontal rather than down at a ball.
    const flat: ImuSample[] = Array.from({ length: 100 }, (_, i) => ({
      t: i / 400,
      ax: 0,
      ay: 0,
      az: GRAVITY,
      gx: 0,
      gy: 0,
      gz: 0,
    }))
    const cal = calibrate(flat, CLUB, 'right')
    expect(cal.warning).toMatch(/off the ground/)
  })

  it('flags a sensor that is not actually still', () => {
    const moving: ImuSample[] = Array.from({ length: 100 }, (_, i) => ({
      t: i / 400,
      ax: 0,
      ay: GRAVITY * 1.6,
      az: 0,
      gx: 0,
      gy: 0,
      gz: 0,
    }))
    expect(calibrate(moving, CLUB, 'right').warning).toMatch(/instead of 1g/)
  })
})

describe('orientation integration', () => {
  /** Line the capture up against the synthesizer's clean orientation array. */
  function trackAgainstTruth(id: 'good' | 'slice' | 'hook') {
    const cap = capture(id)
    const cal = calibrate(cap.still, CLUB, 'right')
    const track = integrateOrientation(cap.samples, cal)
    const truth = getSwing(id).truth
    const offset = Math.round(cap.samples[0].t * 400)
    return { cap, cal, track, truth, offset }
  }

  it('tracks the true orientation through the whole swing', () => {
    const { track, truth, offset } = trackAgainstTruth('good')
    let worst = 0
    for (let i = 0; i < track.q.length; i++) {
      worst = Math.max(worst, toDeg(angleBetweenQuats(track.q[i], truth.q[offset + i])))
    }
    // Roughly two seconds of integration off a biased, quantized gyro.
    expect(worst).toBeLessThan(4)
  })

  it('is still accurate at the moment that matters, impact', () => {
    for (const id of ['good', 'slice', 'hook'] as const) {
      const { cap, track, truth, offset } = trackAgainstTruth(id)
      const err = toDeg(angleBetweenQuats(track.q[cap.impactIndex], truth.q[offset + cap.impactIndex]))
      expect(err, id).toBeLessThan(3)
    }
  })

  it('would drift much worse without the bias correction', () => {
    const cap = capture('good')
    const cal = calibrate(cap.still, CLUB, 'right')
    const truth = getSwing('good').truth
    const offset = Math.round(cap.samples[0].t * 400)

    const withBias = integrateOrientation(cap.samples, { ...cal, gyroBias: v3(0, 0, 0) })
    const corrected = integrateOrientation(cap.samples, cal)

    const last = cap.samples.length - 1
    const errRaw = toDeg(angleBetweenQuats(withBias.q[last], truth.q[offset + last]))
    const errFixed = toDeg(angleBetweenQuats(corrected.q[last], truth.q[offset + last]))
    expect(errFixed).toBeLessThan(errRaw)
  })

  it('applies gravity corrections at address and again near the top', () => {
    const { track, cap } = trackAgainstTruth('good')
    expect(track.zuptCount).toBeGreaterThan(10)

    // Corrections have to stop once the club is really moving.
    const cal = calibrate(cap.still, CLUB, 'right')
    const mid = integrateOrientation(cap.samples.slice(cap.impactIndex - 40, cap.impactIndex), cal)
    expect(mid.zuptCount).toBe(0)
  })

  it('holds orientation over a long still stretch', () => {
    // Three seconds of nothing but bias and noise. This is the drift worst case,
    // and the whole reason the bias is estimated at all.
    const cal0 = calibrate(capture('good').still, CLUB, 'right')
    const truth = cal0.addressQuat
    const gravityS = rotate(
      { w: cal0.addressQuat.w, x: -cal0.addressQuat.x, y: -cal0.addressQuat.y, z: -cal0.addressQuat.z },
      v3(0, GRAVITY, 0),
    )
    const bias = v3(1.4 * DEG, -0.9 * DEG, 2.1 * DEG)
    const still: ImuSample[] = Array.from({ length: 1200 }, (_, i) => ({
      t: i / 400,
      ax: gravityS.x,
      ay: gravityS.y,
      az: gravityS.z,
      gx: bias.x,
      gy: bias.y,
      gz: bias.z,
    }))

    const cal = calibrate(still.slice(0, 100), CLUB, 'right')
    const track = integrateOrientation(still, cal)
    expect(toDeg(angleBetweenQuats(track.q[track.q.length - 1], truth))).toBeLessThan(0.5)
  })

  it('drifts badly over that same stretch if the bias is left in', () => {
    const cal0 = calibrate(capture('good').still, CLUB, 'right')
    const gravityS = rotate(
      { w: cal0.addressQuat.w, x: -cal0.addressQuat.x, y: -cal0.addressQuat.y, z: -cal0.addressQuat.z },
      v3(0, GRAVITY, 0),
    )
    const still: ImuSample[] = Array.from({ length: 1200 }, (_, i) => ({
      t: i / 400,
      ax: gravityS.x,
      ay: gravityS.y,
      az: gravityS.z,
      gx: 1.4 * DEG,
      gy: -0.9 * DEG,
      gz: 2.1 * DEG,
    }))
    const uncorrected = integrateOrientation(still, { ...cal0, gyroBias: v3(0, 0, 0) })
    const err = toDeg(angleBetweenQuats(uncorrected.q[1199], cal0.addressQuat))
    // Gravity corrections claw back tilt, but yaw has nothing to pull it back.
    expect(err).toBeGreaterThan(2)
  })

  it('reports peak rotation in the right ballpark', () => {
    const { track } = trackAgainstTruth('good')
    const peak = Math.max(...track.rateDps)
    expect(peak).toBeGreaterThan(1500)
    expect(peak).toBeLessThan(2000)
  })
})

describe('forward kinematics', () => {
  it('hangs the clubhead a shaft length off the grip', () => {
    const cal = calibrate(capture('good').still, CLUB, 'right')
    const offset = clubheadOffset(cal.addressQuat, 0.89)
    expect(len(offset)).toBeCloseTo(0.89, 9)
    // At address it is below the grip and out toward the ball.
    expect(offset.y).toBeLessThan(-0.7)
    expect(offset.z).toBeGreaterThan(0)
  })

  it('sweeps the clubhead through a full arc across the swing', () => {
    const cap = capture('good')
    const cal = calibrate(cap.still, CLUB, 'right')
    const track = integrateOrientation(cap.samples, cal)
    const heights = track.q.map((q) => clubheadOffset(q, 0.89).y)
    // It goes up and over in the backswing, and comes back down to the ball.
    expect(Math.max(...heights)).toBeGreaterThan(0.5)
    expect(heights[cap.impactIndex]).toBeCloseTo(heights[0], 1)
  })

  it('keeps the clubhead on a sphere about the grip', () => {
    const cap = capture('good')
    const cal = calibrate(cap.still, CLUB, 'right')
    const track = integrateOrientation(cap.samples, cal)
    for (const q of track.q) expect(len(clubheadOffset(q, 0.89))).toBeCloseTo(0.89, 6)
  })
})

describe('frames sanity', () => {
  it('address face normal points down the target line', () => {
    const cal = calibrate(capture('good').still, CLUB, 'right')
    const face = rotate(cal.addressQuat, v3(0, 1, 0))
    expect(Math.abs(Math.atan2(face.z, face.x)) / DEG).toBeLessThan(1)
  })
})
