import { describe, expect, it } from "vitest";
import { conj, rotate } from "../math/quat";
import { cross, len, normalize, reject, sub, v3 } from "../math/vec3";
import {
    DEG,
    FACE_NORMAL_S,
    FORWARD_AXIS_S,
    GRAVITY,
    SHAFT_AXIS_S,
    addressFrame,
    fromSensorAxes,
    horizontalAngle,
    toDeg,
} from "./frames";

const close = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThan(tol);

/**
 * A grounded club at address with a square face, built directly from world
 * geometry so the frame constants can be checked against something independent.
 */
export function addressPose(lieDeg = 60) {
    const fromVertical = (90 - lieDeg) * DEG;
    // Shaft runs down and out to the ball, which sits on the +Zw side of a righty.
    const zs = v3(0, -Math.cos(fromVertical), Math.sin(fromVertical));
    // Forward axis faces the golfer at -Zw, squared up against the shaft.
    const xs = normalize(reject(v3(0, 0, -1), zs));
    const ys = cross(zs, xs);
    return fromSensorAxes(xs, ys, zs);
}

describe("address frame", () => {
    it("shaft axis points down toward the ball at the lie angle", () => {
        const shaftW = rotate(addressPose(60), SHAFT_AXIS_S);
        close(len(shaftW), 1, 1e-9);
        expect(shaftW.y).toBeLessThan(0);
        expect(shaftW.z).toBeGreaterThan(0);
        close(toDeg(Math.asin(-shaftW.y)), 60, 1e-6);
    });

    it("face is square to the target line at address", () => {
        const faceW = rotate(addressPose(60), FACE_NORMAL_S);
        close(toDeg(horizontalAngle(faceW)), 0, 1e-6);
        expect(faceW.x).toBeGreaterThan(0); // points at the target, not away from it
    });

    it("forward axis leans toward the golfer", () => {
        const fwd = rotate(addressPose(60), FORWARD_AXIS_S);
        expect(fwd.z).toBeLessThan(0);
    });

    it("recovers the pose from a still gravity reading", () => {
        const q = addressPose(60);
        // At rest the accelerometer reads the reaction to gravity, so up, in sensor coords.
        const accelS = rotate(conj(q), v3(0, GRAVITY, 0));
        const recovered = addressFrame(accelS, "right");

        for (const axis of [v3(1, 0, 0), v3(0, 1, 0), v3(0, 0, 1)]) {
            close(len(sub(rotate(recovered, axis), rotate(q, axis))), 0, 1e-6);
        }
    });

    it("works at a different lie angle", () => {
        const q = addressPose(68);
        const accelS = rotate(conj(q), v3(0, GRAVITY, 0));
        const shaftW = rotate(addressFrame(accelS, "right"), SHAFT_AXIS_S);
        close(toDeg(Math.asin(-shaftW.y)), 68, 1e-6);
    });

    it("mirrors the target line for a left handed golfer", () => {
        const accelS = rotate(conj(addressPose(60)), v3(0, GRAVITY, 0));
        const probe = normalize(v3(0.3, -0.8, 0.5));
        const r = rotate(addressFrame(accelS, "right"), probe);
        const l = rotate(addressFrame(accelS, "left"), probe);
        // Same handedness of gravity, opposite target line and opposite sideways axis.
        close(l.y, r.y, 1e-6);
        close(l.x, -r.x, 1e-6);
        close(l.z, -r.z, 1e-6);
    });
});
