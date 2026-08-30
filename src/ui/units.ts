/**
 * SI everywhere inside the app, converted only here at the edge. Display is
 * imperial because that is what a US driving range talks in.
 */
export const MPH_PER_MPS = 2.23694;
export const YARDS_PER_METER = 1.09361;
export const FEET_PER_METER = 3.28084;

export const mph = (mps: number): number => mps * MPH_PER_MPS;
export const yards = (meters: number): number => meters * YARDS_PER_METER;
export const feet = (meters: number): number => meters * FEET_PER_METER;

export const DEGREE = "\u00b0";

export const fixed = (value: number, places = 1): string =>
    Number.isFinite(value) ? value.toFixed(places) : "-";

/**
 * Signed value with a direction word, which reads better than a minus sign.
 * The unit has to be passed in, since these are not all angles.
 */
export function sided(
    value: number,
    left = "left",
    right = "right",
    places = 1,
    unit = DEGREE,
): string {
    if (!Number.isFinite(value)) return "-";
    const magnitude = Math.abs(value).toFixed(places);
    if (Math.abs(value) < 0.5 * 10 ** -places) return `0${unit}`;
    return `${magnitude}${unit} ${value > 0 ? right : left}`;
}

/** Tempo reads as a ratio against one, the way golfers talk about it. */
export const tempo = (ratio: number): string =>
    Number.isFinite(ratio) && ratio > 0 ? `${ratio.toFixed(1)} : 1` : "-";
