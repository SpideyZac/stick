import { describe, expect, it, vi } from 'vitest'
import { GYRO_RANGE_DPS, ACCEL_RANGE_G, type ImuSample } from '../types'
import { MockImuSource } from './source'
import { SWING_IDS, getSwing } from './swings'

const DEG = Math.PI / 180
const gyroMag = (s: ImuSample) => Math.hypot(s.gx, s.gy, s.gz) / DEG
const accelMag = (s: ImuSample) => Math.hypot(s.ax, s.ay, s.az) / 9.80665

describe('synthesized swings', () => {
  it('stay inside the sensor ranges the spec picked', () => {
    for (const id of SWING_IDS) {
      const { samples } = getSwing(id)
      const peakGyro = Math.max(...samples.map(gyroMag))
      const peakAccel = Math.max(...samples.map(accelMag))
      expect(peakGyro, `${id} gyro`).toBeLessThan(GYRO_RANGE_DPS)
      expect(peakAccel, `${id} accel`).toBeLessThan(ACCEL_RANGE_G)
      // If the mock never gets near the range there is no headroom being tested.
      expect(peakGyro, `${id} gyro`).toBeGreaterThan(1200)
    }
  })

  it('reads one g and near zero rotation while the golfer is still', () => {
    const { samples, truth } = getSwing('good')
    // Sample well inside the still window, before the takeaway.
    const i = truth.takeawayIndex - 40
    expect(accelMag(samples[i])).toBeCloseTo(1, 1)
    // Only bias and noise should be left here.
    expect(gyroMag(samples[i])).toBeLessThan(6)
  })

  it('puts a hard accel spike at impact and nowhere else', () => {
    const { samples, truth } = getSwing('good')
    expect(accelMag(samples[truth.impactIndex])).toBeGreaterThan(12)
    const beforeImpact = samples.slice(0, truth.impactIndex - 2).map(accelMag)
    expect(Math.max(...beforeImpact)).toBeLessThan(12)
  })

  it('produces a plausible mid iron swing', () => {
    const { truth } = getSwing('good')
    const mph = truth.clubheadSpeedMps * 2.23694
    expect(mph).toBeGreaterThan(55)
    expect(mph).toBeLessThan(85)
    expect(truth.attackAngleDeg).toBeLessThan(0) // irons hit down
    expect(truth.attackAngleDeg).toBeGreaterThan(-9)
  })

  it('shapes the three swings the way their names say', () => {
    const good = getSwing('good').truth
    const slice = getSwing('slice').truth
    const hook = getSwing('hook').truth

    // Face to path is what curves the ball, so that is what has to separate.
    expect(slice.faceToPathDeg).toBeGreaterThan(6)
    expect(hook.faceToPathDeg).toBeLessThan(-6)
    expect(Math.abs(good.faceToPathDeg)).toBeLessThan(2)

    // A slice comes over the top, out to in. A hook comes from the inside.
    expect(slice.pathAngleDeg).toBeLessThan(0)
    expect(hook.pathAngleDeg).toBeGreaterThan(0)

    // And the steeper the out to in, the more it digs.
    expect(slice.attackAngleDeg).toBeLessThan(hook.attackAngleDeg)
  })

  it('gives the waggle swing the same shape as the clean one', () => {
    const good = getSwing('good').truth
    const waggle = getSwing('waggle').truth
    expect(waggle.faceToPathDeg).toBeCloseTo(good.faceToPathDeg, 1)
    // But it takes longer to get going, because of the waggles.
    expect(waggle.takeawayIndex).toBeGreaterThan(good.takeawayIndex)
  })

  it('has waggles that cross the takeaway threshold', () => {
    // Otherwise the detector is not actually being asked anything.
    const { samples, truth } = getSwing('waggle')
    const still = samples.slice(0, truth.takeawayIndex - 5).map(gyroMag)
    expect(Math.max(...still)).toBeGreaterThan(60)
  })

  it('is deterministic', () => {
    const a = getSwing('slice').samples
    const b = getSwing('slice').samples
    expect(a[500]).toEqual(b[500])
  })
})

describe('MockImuSource', () => {
  it('delivers every sample in order, in batches', async () => {
    vi.useFakeTimers()
    const src = new MockImuSource({ swing: 'good' })
    const got: ImuSample[] = []
    src.onSamples((b) => {
      expect(b.length).toBeGreaterThan(0)
      got.push(...b)
    })

    await src.start()
    await vi.advanceTimersByTimeAsync(10_000)
    src.stop()
    vi.useRealTimers()

    const expected = getSwing('good').samples
    expect(got.length).toBe(expected.length)
    expect(got[0]).toEqual(expected[0])
    expect(got[got.length - 1]).toEqual(expected[expected.length - 1])
    for (let i = 1; i < got.length; i++) expect(got[i].t).toBeGreaterThan(got[i - 1].t)
  })

  it('keeps timestamps climbing across a loop', async () => {
    vi.useFakeTimers()
    const src = new MockImuSource({ swing: 'good', loop: true })
    const got: ImuSample[] = []
    src.onSamples((b) => got.push(...b))

    await src.start()
    await vi.advanceTimersByTimeAsync(5000)
    src.stop()
    vi.useRealTimers()

    const n = getSwing('good').samples.length
    expect(got.length).toBeGreaterThan(n)
    for (let i = 1; i < got.length; i++) expect(got[i].t).toBeGreaterThan(got[i - 1].t)
  })

  it('unsubscribes cleanly', async () => {
    vi.useFakeTimers()
    const src = new MockImuSource({ swing: 'good' })
    let count = 0
    const off = src.onSamples(() => count++)
    await src.start()
    await vi.advanceTimersByTimeAsync(100)
    const seen = count
    off()
    await vi.advanceTimersByTimeAsync(500)
    src.stop()
    vi.useRealTimers()
    expect(count).toBe(seen)
  })
})
