import { type Vec3, cross, dot, len, normalize as nv, v3 } from "./vec3";

export interface Quat {
    w: number;
    x: number;
    y: number;
    z: number;
}

export const IDENTITY: Quat = { w: 1, x: 0, y: 0, z: 0 };

export const quat = (w = 1, x = 0, y = 0, z = 0): Quat => ({ w, x, y, z });

export const conj = (q: Quat): Quat => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });

export function normalize(q: Quat): Quat {
    const l = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
    if (l < 1e-12) return { ...IDENTITY };
    const s = 1 / l;
    return { w: q.w * s, x: q.x * s, y: q.y * s, z: q.z * s };
}

/** Hamilton product. Applying a then b to a vector is mul(b, a). */
export const mul = (a: Quat, b: Quat): Quat => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});

/** Rotate a vector by a unit quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
    // t = 2 * (qvec x v); result = v + q.w * t + qvec x t
    const tx = 2 * (q.y * v.z - q.z * v.y);
    const ty = 2 * (q.z * v.x - q.x * v.z);
    const tz = 2 * (q.x * v.y - q.y * v.x);
    return {
        x: v.x + q.w * tx + q.y * tz - q.z * ty,
        y: v.y + q.w * ty + q.z * tx - q.x * tz,
        z: v.z + q.w * tz + q.x * ty - q.y * tx,
    };
}

export function fromAxisAngle(axis: Vec3, angle: number): Quat {
    const a = nv(axis);
    const h = angle * 0.5;
    const s = Math.sin(h);
    return { w: Math.cos(h), x: a.x * s, y: a.y * s, z: a.z * s };
}

export function toAxisAngle(q: Quat): { axis: Vec3; angle: number } {
    const n = normalize(q);
    const w = Math.min(1, Math.max(-1, n.w < 0 ? -n.w : n.w));
    const sign = n.w < 0 ? -1 : 1;
    const s = Math.sqrt(1 - w * w);
    const angle = 2 * Math.acos(w);
    if (s < 1e-9) return { axis: v3(1, 0, 0), angle: 0 };
    return { axis: v3((sign * n.x) / s, (sign * n.y) / s, (sign * n.z) / s), angle };
}

/**
 * Rotation increment from an angular velocity over dt, via the exponential map.
 * Small-angle branch keeps this stable when the club is basically still.
 */
export function fromAngularRate(w: Vec3, dt: number): Quat {
    const theta = len(w) * dt;
    if (theta < 1e-7) {
        return normalize({ w: 1, x: w.x * dt * 0.5, y: w.y * dt * 0.5, z: w.z * dt * 0.5 });
    }
    const h = theta * 0.5;
    const s = Math.sin(h) / (theta / dt);
    return { w: Math.cos(h), x: w.x * s, y: w.y * s, z: w.z * s };
}

/** Shortest arc rotation taking unit vector a onto unit vector b. */
export function fromTo(a: Vec3, b: Vec3): Quat {
    const ua = nv(a);
    const ub = nv(b);
    const d = dot(ua, ub);
    if (d > 1 - 1e-9) return { ...IDENTITY };
    if (d < -1 + 1e-9) {
        // Antiparallel, any perpendicular axis gives a valid 180 degree turn.
        const axis = Math.abs(ua.x) < 0.9 ? cross(ua, v3(1, 0, 0)) : cross(ua, v3(0, 1, 0));
        return fromAxisAngle(axis, Math.PI);
    }
    const c = cross(ua, ub);
    return normalize({ w: 1 + d, x: c.x, y: c.y, z: c.z });
}

/** Scale a rotation to a fraction of its angle. Used for partial ZUPT corrections. */
export function scaleRotation(q: Quat, t: number): Quat {
    const { axis, angle } = toAxisAngle(q);
    if (angle < 1e-9) return { ...IDENTITY };
    return fromAxisAngle(axis, angle * t);
}

/** Angle in radians between two orientations. */
export function angleBetweenQuats(a: Quat, b: Quat): number {
    const rel = mul(conj(a), b);
    return toAxisAngle(rel).angle;
}

/**
 * Quaternion from three orthonormal basis vectors. Pass the world axes expressed
 * in sensor coordinates; the result rotates a sensor-frame vector into world.
 */
export function fromBasis(xw: Vec3, yw: Vec3, zw: Vec3): Quat {
    // Rows of the rotation matrix are the world axes in sensor coordinates.
    const m00 = xw.x,
        m01 = xw.y,
        m02 = xw.z;
    const m10 = yw.x,
        m11 = yw.y,
        m12 = yw.z;
    const m20 = zw.x,
        m21 = zw.y,
        m22 = zw.z;
    const tr = m00 + m11 + m22;

    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        return normalize({
            w: 0.25 * s,
            x: (m21 - m12) / s,
            y: (m02 - m20) / s,
            z: (m10 - m01) / s,
        });
    }
    if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        return normalize({
            w: (m21 - m12) / s,
            x: 0.25 * s,
            y: (m01 + m10) / s,
            z: (m02 + m20) / s,
        });
    }
    if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        return normalize({
            w: (m02 - m20) / s,
            x: (m01 + m10) / s,
            y: 0.25 * s,
            z: (m12 + m21) / s,
        });
    }
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    return normalize({ w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s });
}
