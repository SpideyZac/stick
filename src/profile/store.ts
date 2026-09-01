import { type Club, getClub } from "../data/clubs";
import type { Mount } from "../swing/mount";
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
            mount: readMount(parsed.mount),
        };
    } catch {
        return DEFAULT_PROFILE;
    }
}

/**
 * A mount off a stale or hand-edited profile has to be checked rather than
 * trusted: it silently rotates every reading, so a malformed one would not throw,
 * it would just quietly report the wrong swing.
 */
function readMount(raw: unknown): Mount | null {
    if (!raw || typeof raw !== "object") return null;
    const m = raw as Partial<Mount>;
    const q = m.q;
    if (!q || ![q.w, q.x, q.y, q.z].every((n) => typeof n === "number" && Number.isFinite(n))) {
        return null;
    }
    if (Math.abs(Math.hypot(q.w, q.x, q.y, q.z) - 1) > 1e-3) return null;
    return {
        q: { w: q.w, x: q.x, y: q.y, z: q.z },
        lieAngleDeg: numberOr(m.lieAngleDeg, 0),
        ts: numberOr(m.ts, 0),
    };
}

const numberOr = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

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
