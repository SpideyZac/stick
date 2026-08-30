export interface Vec3 {
  x: number
  y: number
  z: number
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z })

export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z })

export const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})

export const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
})

export const scale = (a: Vec3, s: number): Vec3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s,
})

export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
})

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

export const lenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z

export const len = (a: Vec3): number => Math.sqrt(lenSq(a))

export function normalize(a: Vec3): Vec3 {
  const l = len(a)
  return l > 1e-12 ? scale(a, 1 / l) : v3(0, 0, 0)
}

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

/** Angle between two vectors in radians. Clamped so rounding cannot NaN the acos. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const d = dot(normalize(a), normalize(b))
  return Math.acos(Math.min(1, Math.max(-1, d)))
}

/** Component of a perpendicular to unit vector n. */
export const reject = (a: Vec3, n: Vec3): Vec3 => addScaled(a, n, -dot(a, n))

/** Rodrigues rotation of v about an axis by angle radians. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = normalize(axis)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return addScaled(addScaled(scale(v, c), cross(k, v), s), k, (1 - c) * dot(k, v))
}
