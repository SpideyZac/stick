import { type Vec3, v3 } from './vec3'

/**
 * Best fit plane through a point cloud. Returns the unit normal and the
 * centroid. The normal is the eigenvector of the covariance matrix with the
 * smallest eigenvalue, which is the direction the points vary in least.
 */
export function fitPlane(points: readonly Vec3[]): { normal: Vec3; centroid: Vec3 } {
  const n = points.length
  if (n < 3) return { normal: v3(0, 1, 0), centroid: v3(0, 0, 0) }

  let cx = 0
  let cy = 0
  let cz = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
    cz += p.z
  }
  cx /= n
  cy /= n
  cz /= n

  let xx = 0
  let xy = 0
  let xz = 0
  let yy = 0
  let yz = 0
  let zz = 0
  for (const p of points) {
    const dx = p.x - cx
    const dy = p.y - cy
    const dz = p.z - cz
    xx += dx * dx
    xy += dx * dy
    xz += dx * dz
    yy += dy * dy
    yz += dy * dz
    zz += dz * dz
  }

  const { values, vectors } = jacobiEigen3([
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ])

  let min = 0
  if (values[1] < values[min]) min = 1
  if (values[2] < values[min]) min = 2

  return {
    normal: v3(vectors[0][min], vectors[1][min], vectors[2][min]),
    centroid: v3(cx, cy, cz),
  }
}

type Mat3 = number[][]

/**
 * Jacobi eigenvalue iteration for a symmetric 3x3. Column j of `vectors` is the
 * eigenvector for `values[j]`. Overkill-free and converges in a handful of
 * sweeps at this size.
 */
export function jacobiEigen3(input: Mat3): { values: number[]; vectors: Mat3 } {
  const a: Mat3 = input.map((row) => row.slice())
  const v: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]

  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2])
    if (off < 1e-14) break

    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue

        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c

        for (let k = 0; k < 3; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p]
          const vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }

  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v }
}
