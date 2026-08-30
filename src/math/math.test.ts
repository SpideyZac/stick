import { describe, expect, it } from 'vitest'
import { angleBetween, cross, dot, len, normalize, sub, v3 } from './vec3'
import {
  IDENTITY,
  angleBetweenQuats,
  conj,
  fromAngularRate,
  fromAxisAngle,
  fromTo,
  mul,
  rotate,
  scaleRotation,
} from './quat'
import { fitPlane } from './plane'

const DEG = Math.PI / 180
const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('vec3', () => {
  it('cross product is right handed', () => {
    const c = cross(v3(1, 0, 0), v3(0, 1, 0))
    expect(c).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('normalize of a zero vector does not produce NaN', () => {
    expect(normalize(v3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('angleBetween is clamped against rounding', () => {
    close(angleBetween(v3(1, 0, 0), v3(1, 0, 0)), 0)
    close(angleBetween(v3(1, 0, 0), v3(-1, 0, 0)), Math.PI)
  })
})

describe('quat', () => {
  it('rotates a vector about an axis', () => {
    const q = fromAxisAngle(v3(0, 1, 0), 90 * DEG)
    const r = rotate(q, v3(1, 0, 0))
    close(r.x, 0, 1e-12)
    close(r.z, -1, 1e-12)
  })

  it('mul composes rotations in apply order', () => {
    const a = fromAxisAngle(v3(0, 0, 1), 30 * DEG)
    const b = fromAxisAngle(v3(0, 0, 1), 60 * DEG)
    close(angleBetweenQuats(mul(b, a), fromAxisAngle(v3(0, 0, 1), 90 * DEG)), 0, 1e-9)
  })

  it('conj undoes a rotation', () => {
    const q = fromAxisAngle(v3(0.3, 0.5, 0.8), 1.1)
    close(angleBetweenQuats(mul(conj(q), q), IDENTITY), 0, 1e-9)
  })

  it('fromTo lands a onto b', () => {
    const a = normalize(v3(0.2, 0.9, -0.3))
    const b = normalize(v3(-0.7, 0.1, 0.5))
    const r = rotate(fromTo(a, b), a)
    close(len(sub(r, b)), 0, 1e-9)
  })

  it('fromTo handles antiparallel vectors', () => {
    const r = rotate(fromTo(v3(0, 1, 0), v3(0, -1, 0)), v3(0, 1, 0))
    close(r.y, -1, 1e-9)
  })

  it('fromAngularRate matches a closed form rotation', () => {
    const rate = v3(0, 2, 0) // rad/s about +Y
    const dt = 0.25
    close(angleBetweenQuats(fromAngularRate(rate, dt), fromAxisAngle(v3(0, 1, 0), 0.5)), 0, 1e-9)
  })

  it('fromAngularRate small-angle branch stays near identity', () => {
    const q = fromAngularRate(v3(1e-9, 0, 0), 0.0025)
    close(angleBetweenQuats(q, IDENTITY), 0, 1e-9)
  })

  it('integrating a constant rate matches the closed form', () => {
    // 400 Hz for 1 second at 180 dps about +Z should land on 180 degrees.
    const rate = v3(0, 0, Math.PI)
    const dt = 1 / 400
    let q = { ...IDENTITY }
    for (let i = 0; i < 400; i++) q = mul(q, fromAngularRate(rate, dt))
    close(angleBetweenQuats(q, fromAxisAngle(v3(0, 0, 1), Math.PI)), 0, 1e-9)
  })

  it('scaleRotation takes a fraction of the angle', () => {
    const q = fromAxisAngle(v3(0, 1, 0), 60 * DEG)
    close(angleBetweenQuats(scaleRotation(q, 0.5), fromAxisAngle(v3(0, 1, 0), 30 * DEG)), 0, 1e-9)
  })
})

describe('fitPlane', () => {
  it('recovers the normal of a known plane', () => {
    // Points on the XZ plane, so the normal must be +/- Y.
    const pts = []
    for (let i = 0; i < 40; i++) {
      const t = i * 0.1
      pts.push(v3(Math.cos(t), 0, Math.sin(t)))
    }
    const { normal } = fitPlane(pts)
    close(Math.abs(dot(normal, v3(0, 1, 0))), 1, 1e-6)
  })

  it('recovers a tilted plane', () => {
    const tilt = fromAxisAngle(v3(0, 0, 1), 55 * DEG)
    const expected = rotate(tilt, v3(0, 1, 0))
    const pts = []
    for (let i = 0; i < 40; i++) {
      const t = i * 0.15
      pts.push(rotate(tilt, v3(Math.cos(t), 0, Math.sin(t))))
    }
    const { normal } = fitPlane(pts)
    close(Math.abs(dot(normal, expected)), 1, 1e-6)
  })

  it('returns a centroid at the middle of the cloud', () => {
    const { centroid } = fitPlane([v3(-1, 0, 0), v3(1, 0, 0), v3(0, 0, 1), v3(0, 0, -1)])
    close(len(centroid), 0, 1e-12)
  })
})
