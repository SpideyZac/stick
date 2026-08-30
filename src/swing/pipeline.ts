import type { Club } from "../data/clubs";
import { effectiveShaftLength } from "../data/clubs";
import type { ImuSample } from "../imu/types";
import type { Quat } from "../math/quat";
import { type Vec3, add } from "../math/vec3";
import { type BallFlight, estimateFlight } from "../flight/ballflight";
import { type Calibration, calibrate } from "./calibrate";
import type { SwingCapture } from "./detect";
import type { Handedness } from "./frames";
import { trackGrip } from "./grip";
import { clubheadOffset } from "./kinematics";
import { integrateOrientation } from "./orient";
import { type Phases, segment } from "./phases";
import { type SwingStats, computeStats } from "./stats";
import { type StrikeLocation, computeStrikeLocation } from "./strike";

export interface SwingAnalysis {
    club: Club;
    hand: Handedness;
    calibration: Calibration;
    stats: SwingStats;
    strike: StrikeLocation;
    flight: BallFlight;
    phases: Phases;
    /** Orientation per sample, for the replay. */
    orientation: Quat[];
    /** Clubhead position, per sample, in the address frame. */
    clubheadPath: Vec3[];
    /** Where the hands were, per sample. Origin is the grip at address. */
    gripPath: Vec3[];
    /** Point the arms pivot about, for drawing the second segment. */
    hub: Vec3;
    /** Seconds since t=0, per sample. */
    times: number[];
    shaftLength: number;
}

/**
 * Everything from a captured swing to the numbers on screen. The UI knows about
 * this and nothing else, and the only thing feeding it is an ImuSource, so a
 * real BLE sensor drops in without touching any of this.
 */
export function analyzeSwing(capture: SwingCapture, club: Club, hand: Handedness): SwingAnalysis {
    const calibration = calibrate(capture.still, club, hand);
    const track = integrateOrientation(capture.samples, calibration);
    const grip = trackGrip(capture.samples, track.q, capture.still, hand);
    const phases = segment(capture.samples, track, capture.impactIndex);
    const stats = computeStats(capture.samples, track, phases, club, grip, hand);

    const shaftLength = effectiveShaftLength(club);
    const t0 = capture.samples[0].t;
    const clubheadPath = track.q.map((q, i) =>
        add(grip.position[i], clubheadOffset(q, shaftLength)),
    );
    const times = capture.samples.map((s: ImuSample) => s.t - t0);

    const strike = computeStrikeLocation(
        clubheadPath,
        times,
        track.q,
        track.omegaWorld,
        phases.impactIndex,
        club,
        hand,
    );
    const flight = estimateFlight(stats, club, strike, hand);

    return {
        club,
        hand,
        calibration,
        stats,
        strike,
        flight,
        phases,
        orientation: track.q,
        gripPath: grip.position,
        hub: grip.hub,
        clubheadPath,
        times,
        shaftLength,
    };
}
