import type { ShotShape } from "../flight/ballflight";
import type { Handedness } from "../swing/frames";
import type { StrikeZone } from "../swing/strike";

/** Per-club overrides layered on top of the stock estimates in data/clubs.ts. */
export interface ClubOverride {
    smash?: number;
    launchFactor?: number;
    faceWidth?: number;
    faceHeight?: number;
}

export interface SwingRecord {
    id: string;
    ts: number;
    clubId: string;
    clubheadSpeedMps: number;
    ballSpeedMps: number;
    carryM: number;
    apexM: number;
    faceAngleDeg: number;
    pathAngleDeg: number;
    faceToPathDeg: number;
    attackAngleDeg: number;
    tempoRatio: number;
    strikeZone: StrikeZone;
    offCenterM: number;
    shape: ShotShape;
}

export interface Profile {
    hand: Handedness;
    clubOverrides: Record<string, ClubOverride>;
    swings: SwingRecord[];
}

export const DEFAULT_PROFILE: Profile = {
    hand: "right",
    clubOverrides: {},
    swings: [],
};
