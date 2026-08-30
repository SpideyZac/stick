import { describe, expect, it } from "vitest";
import { getClub } from "../data/clubs";
import type { Quat } from "../math/quat";
import { type Vec3, v3 } from "../math/vec3";
import { computeStrikeLocation } from "./strike";
import { fromSensorAxes } from "./frames";

const CLUB = getClub("7i");
const RATE_HZ = 400;
const DT = 1 / RATE_HZ;
const N = 20;
const IMPACT_INDEX = 12;

// Simplified address-like pose: face normal points straight down the target
// line (ball flight direction), shaft points straight down, and the toe-heel
// axis is world -Z. Physically a 90 degree lie angle, which nothing here cares
// about: the point is a known, hand-checkable basis to decompose offsets
// against, not a realistic swing.
const Q: Quat = fromSensorAxes(v3(0, 0, -1), v3(1, 0, 0), v3(0, -1, 0));

/**
 * Builds inputs for computeStrikeLocation where the clubhead sits at address
 * (index 0) at the origin, and follows a straight line through the fit window
 * around IMPACT_INDEX that has its true closest approach to the ball at
 * exactly `offset` (in world coordinates) from the ball's position. Zero
 * angular velocity keeps the orientation constant at Q throughout, so the
 * face-local decomposition is exactly the one derived by hand in the comment
 * above.
 */
function buildCase(offset: Vec3) {
    const n = N;
    const times = Array.from({ length: n }, (_, i) => i * DT);
    const q: Quat[] = new Array(n).fill(Q);
    const omegaWorld: Vec3[] = new Array(n).fill(v3(0, 0, 0));
    const clubheadPath: Vec3[] = new Array(n).fill(v3(0, 0, 0));

    // Ball sits one radius above wherever the clubhead rests at address (index 0).
    const ballRadius = 0.021335;
    const ball = v3(0, ballRadius, 0);
    const contactPoint = v3(ball.x + offset.x, ball.y + offset.y, ball.z + offset.z);

    // Velocity perpendicular to the offset, so the true closest approach of the
    // resulting straight line to the ball is exactly at contactPoint.
    const velocity = v3(40, 0, 0);
    const tContact = IMPACT_INDEX * DT;

    const hi = IMPACT_INDEX - 2; // SHOCK_BACKOFF
    const lo = hi - 5 + 1; // FIT_SPAN
    for (let i = lo; i <= hi; i++) {
        const dt = times[i] - tContact;
        clubheadPath[i] = v3(
            contactPoint.x + velocity.x * dt,
            contactPoint.y + velocity.y * dt,
            contactPoint.z + velocity.z * dt,
        );
    }

    return { clubheadPath, times, q, omegaWorld };
}

describe("computeStrikeLocation", () => {
    it("recovers a known toe-and-thin offset, sign and magnitude", () => {
        const { clubheadPath, times, q, omegaWorld } = buildCase(v3(0, 0.008, -0.01));
        const strike = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "right",
        );

        expect(strike.rawHeelToeM).toBeCloseTo(0.01, 6);
        expect(strike.rawHighLowM).toBeCloseTo(0.008, 6);
        expect(strike.contactPoint.z).toBeCloseTo(-0.01, 6);
    });

    it("recovers a known heel offset with the opposite sign", () => {
        const { clubheadPath, times, q, omegaWorld } = buildCase(v3(0, 0, 0.01));
        const strike = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "right",
        );

        expect(strike.rawHeelToeM).toBeCloseTo(-0.01, 6);
    });

    it("flips heel and toe for a left handed golfer", () => {
        const { clubheadPath, times, q, omegaWorld } = buildCase(v3(0, 0, -0.01));
        const right = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "right",
        );
        const left = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "left",
        );
        expect(Math.sign(right.rawHeelToeM)).toBe(-Math.sign(left.rawHeelToeM));
    });

    it("classifies a true center strike, well inside the noise floor", () => {
        const { clubheadPath, times, q, omegaWorld } = buildCase(v3(0, 0, 0));
        const strike = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "right",
        );
        expect(strike.zone).toBe("center");
        expect(strike.contactMade).toBe(true);
    });

    it("classifies a strike well past the noise floor as top", () => {
        const { clubheadPath, times, q, omegaWorld } = buildCase(v3(0, 0.11, 0));
        const strike = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "right",
        );
        expect(strike.zone).toBe("top");
        expect(strike.faceHitFracY).toBeGreaterThan(0);
    });

    it("classifies a strike well past the noise floor toward the toe", () => {
        const { clubheadPath, times, q, omegaWorld } = buildCase(v3(0, 0, -0.09));
        const strike = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "right",
        );
        expect(strike.zone).toBe("toe");
        expect(strike.faceHitFracX).toBeGreaterThan(0);
    });

    it("reads a whiff when the offset is off the face and ball entirely", () => {
        const { clubheadPath, times, q, omegaWorld } = buildCase(v3(0, 0.5, 0));
        const strike = computeStrikeLocation(
            clubheadPath,
            times,
            q,
            omegaWorld,
            IMPACT_INDEX,
            CLUB,
            "right",
        );
        expect(strike.zone).toBe("whiff");
        expect(strike.contactMade).toBe(false);
    });
});
