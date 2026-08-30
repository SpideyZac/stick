import { type Club, getClub } from "../data/clubs";
import { DEFAULT_PROFILE, type Profile, type SwingRecord } from "./types";

const STORAGE_KEY = "stick.profile.v1";

/** Oldest swings drop off past this, so localStorage doesn't grow without bound. */
export const MAX_SWINGS = 500;

export function loadProfile(): Profile {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_PROFILE;
        const parsed = JSON.parse(raw) as Partial<Profile>;
        return {
            hand: parsed.hand === "left" ? "left" : "right",
            clubOverrides: parsed.clubOverrides ?? {},
            swings: Array.isArray(parsed.swings) ? parsed.swings : [],
        };
    } catch {
        return DEFAULT_PROFILE;
    }
}

export function saveProfile(profile: Profile): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

export function appendSwing(swings: SwingRecord[], record: SwingRecord): SwingRecord[] {
    const next = [...swings, record];
    return next.length > MAX_SWINGS ? next.slice(next.length - MAX_SWINGS) : next;
}

/** Stock club merged with whatever this profile has overridden for it. */
export function resolveClub(clubId: string, profile: Profile): Club {
    const club = getClub(clubId);
    const override = profile.clubOverrides[clubId];
    return override ? { ...club, ...override } : club;
}
