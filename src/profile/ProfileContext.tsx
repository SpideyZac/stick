import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Club } from "../data/clubs";
import type { Handedness } from "../swing/frames";
import { appendSwing, loadProfile, resolveClub as resolveClubAgainst, saveProfile } from "./store";
import type { ClubOverride, Profile, SwingRecord } from "./types";

interface ProfileApi {
    profile: Profile;
    setHand: (hand: Handedness) => void;
    setClubOverride: (clubId: string, patch: ClubOverride) => void;
    resetClubOverride: (clubId: string) => void;
    addSwing: (record: SwingRecord) => void;
    clearHistory: () => void;
    resolveClub: (clubId: string) => Club;
}

const ProfileCtx = createContext<ProfileApi | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
    const [profile, setProfile] = useState<Profile>(() => loadProfile());

    const update = useCallback((next: Profile) => {
        setProfile(next);
        saveProfile(next);
    }, []);

    const setHand = useCallback(
        (hand: Handedness) => update({ ...profile, hand }),
        [profile, update],
    );

    const setClubOverride = useCallback(
        (clubId: string, patch: ClubOverride) => {
            const existing = profile.clubOverrides[clubId] ?? {};
            const merged: ClubOverride = { ...existing };
            for (const [key, value] of Object.entries(patch)) {
                if (value !== undefined) (merged as Record<string, number>)[key] = value;
            }
            update({
                ...profile,
                clubOverrides: { ...profile.clubOverrides, [clubId]: merged },
            });
        },
        [profile, update],
    );

    const resetClubOverride = useCallback(
        (clubId: string) => {
            const next = { ...profile.clubOverrides };
            delete next[clubId];
            update({ ...profile, clubOverrides: next });
        },
        [profile, update],
    );

    const addSwing = useCallback(
        (record: SwingRecord) =>
            update({ ...profile, swings: appendSwing(profile.swings, record) }),
        [profile, update],
    );

    const clearHistory = useCallback(() => update({ ...profile, swings: [] }), [profile, update]);

    const resolveClub = useCallback(
        (clubId: string) => resolveClubAgainst(clubId, profile),
        [profile],
    );

    const api = useMemo<ProfileApi>(
        () => ({
            profile,
            setHand,
            setClubOverride,
            resetClubOverride,
            addSwing,
            clearHistory,
            resolveClub,
        }),
        [profile, setHand, setClubOverride, resetClubOverride, addSwing, clearHistory, resolveClub],
    );

    return <ProfileCtx.Provider value={api}>{children}</ProfileCtx.Provider>;
}

export function useProfile(): ProfileApi {
    const ctx = useContext(ProfileCtx);
    if (!ctx) throw new Error("useProfile must be used within a ProfileProvider");
    return ctx;
}
