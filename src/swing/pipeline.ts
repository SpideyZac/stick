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
import { type ImpactEstimate, findImpact } from "./impact";
import { clubheadOffset } from "./kinematics";
import { type Mount, applyMount } from "./mount";
import { integrateOrientation } from "./orient";
import { type Phases, findTop, segment } from "./phases";
import { type SwingStats, computeStats } from "./stats";
import { type StrikeLocation, ballPosition, computeStrikeLocation } from "./strike";

export interface SwingAnalysis {
    club: Club;
    hand: Handedness;
    /** How the sensor was strapped on, or null if it was taken to be square already. */
    mount: Mount | null;
    calibration: Calibration;
    stats: SwingStats;
    strike: StrikeLocation;
    flight: BallFlight;
    phases: Phases;
    /** How contact was placed, and how well the reconstruction agrees it happened. */
    impact: ImpactEstimate;
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
 *
 * The order matters more than it looks. Contact is not something the raw stream
 * announces, it is something the reconstructed swing reveals, so orientation,
 * the grip track and the clubhead path all have to exist before it can be
 * placed. See src/swing/impact.ts for why that is the right way round.
 */
export function analyzeSwing(
    capture: SwingCapture,
    club: Club,
    hand: Handedness,
    mount: Mount | null,
): SwingAnalysis {
    // Everything below works in the sensor frame of src/swing/frames.ts, so the
    // stream is put into that frame once, here, and nothing downstream has to know
    // or care which way up the unit was strapped to the shaft.
    const samples = applyMount(capture.samples, mount);
    const still = applyMount(capture.still, mount);

    const calibration = calibrate(still, club, hand);
    const track = integrateOrientation(samples, calibration);
    const grip = trackGrip(samples, track.q, still, hand);

    const shaftLength = effectiveShaftLength(club);
    const t0 = samples[0].t;
    const clubheadPath = track.q.map((q, i) =>
        add(grip.position[i], clubheadOffset(q, shaftLength)),
    );
    const times = samples.map((s: ImuSample) => s.t - t0);

    const top = findTop(samples, track);
    const impact = findImpact({
        samples,
        times,
        track,
        clubheadPath,
        ball: ballPosition(clubheadPath),
        topIndex: top.topIndex,
    });

    const phases = segment(samples, track, top.topIndex, impact.index);
    const stats = computeStats(samples, track, phases, club, grip, hand);

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
        mount,
        calibration,
        stats,
        strike,
        flight,
        phases,
        impact,
        orientation: track.q,
        gripPath: grip.position,
        hub: grip.hub,
        clubheadPath,
        times,
        shaftLength,
    };
}
