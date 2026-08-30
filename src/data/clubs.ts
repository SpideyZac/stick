export type ClubType = "iron" | "wedge" | "hybrid" | "wood";

export interface Club {
    id: string;
    label: string;
    type: ClubType;
    /** Playing length, meters. Butt of grip to sole. */
    length: number;
    /** Static loft, degrees. */
    loft: number;
    /** Ball speed / clubhead speed. Published typical values. */
    smash: number;
    /** Launch angle as a fraction of dynamic loft. Irons launch below their loft. */
    launchFactor: number;
    /** Face width, heel to toe, meters. */
    faceWidth: number;
    /** Face height, sole to top edge, meters. */
    faceHeight: number;
}

const IN = 0.0254;

// Standard men's lengths and lofts. Driver is deliberately absent, it is the one
// club that gets teed up and the address height calibration assumes a grounded club.
// Face width (heel to toe) and height (sole to top edge) are plausible estimates
// for each club type, not sourced manufacturer spec sheets. They only need to be
// roughly right relative to each other: a wedge's small face is far less
// forgiving of the same mis-hit offset than a wood's large one.
export const CLUBS: readonly Club[] = [
    {
        id: "3w",
        label: "3 Wood",
        type: "wood",
        length: 43 * IN,
        loft: 15,
        smash: 1.46,
        launchFactor: 0.9,
        faceWidth: 0.112,
        faceHeight: 0.046,
    },
    {
        id: "5w",
        label: "5 Wood",
        type: "wood",
        length: 42 * IN,
        loft: 18,
        smash: 1.45,
        launchFactor: 0.88,
        faceWidth: 0.105,
        faceHeight: 0.044,
    },
    {
        id: "7w",
        label: "7 Wood",
        type: "wood",
        length: 41 * IN,
        loft: 21,
        smash: 1.44,
        launchFactor: 0.86,
        faceWidth: 0.1,
        faceHeight: 0.042,
    },

    {
        id: "2h",
        label: "2 Hybrid",
        type: "hybrid",
        length: 40 * IN,
        loft: 17,
        smash: 1.44,
        launchFactor: 0.88,
        faceWidth: 0.088,
        faceHeight: 0.04,
    },
    {
        id: "3h",
        label: "3 Hybrid",
        type: "hybrid",
        length: 39.5 * IN,
        loft: 19,
        smash: 1.43,
        launchFactor: 0.86,
        faceWidth: 0.085,
        faceHeight: 0.039,
    },
    {
        id: "4h",
        label: "4 Hybrid",
        type: "hybrid",
        length: 39 * IN,
        loft: 22,
        smash: 1.42,
        launchFactor: 0.84,
        faceWidth: 0.082,
        faceHeight: 0.038,
    },
    {
        id: "5h",
        label: "5 Hybrid",
        type: "hybrid",
        length: 38.5 * IN,
        loft: 25,
        smash: 1.41,
        launchFactor: 0.82,
        faceWidth: 0.08,
        faceHeight: 0.037,
    },

    {
        id: "4i",
        label: "4 Iron",
        type: "iron",
        length: 38.5 * IN,
        loft: 24,
        smash: 1.38,
        launchFactor: 0.82,
        faceWidth: 0.09,
        faceHeight: 0.044,
    },
    {
        id: "5i",
        label: "5 Iron",
        type: "iron",
        length: 38 * IN,
        loft: 27,
        smash: 1.38,
        launchFactor: 0.8,
        faceWidth: 0.088,
        faceHeight: 0.045,
    },
    {
        id: "6i",
        label: "6 Iron",
        type: "iron",
        length: 37.5 * IN,
        loft: 30,
        smash: 1.37,
        launchFactor: 0.78,
        faceWidth: 0.086,
        faceHeight: 0.046,
    },
    {
        id: "7i",
        label: "7 Iron",
        type: "iron",
        length: 37 * IN,
        loft: 34,
        smash: 1.36,
        launchFactor: 0.76,
        faceWidth: 0.084,
        faceHeight: 0.047,
    },
    {
        id: "8i",
        label: "8 Iron",
        type: "iron",
        length: 36.5 * IN,
        loft: 38,
        smash: 1.35,
        launchFactor: 0.74,
        faceWidth: 0.082,
        faceHeight: 0.048,
    },
    {
        id: "9i",
        label: "9 Iron",
        type: "iron",
        length: 36 * IN,
        loft: 42,
        smash: 1.33,
        launchFactor: 0.72,
        faceWidth: 0.079,
        faceHeight: 0.049,
    },

    {
        id: "pw",
        label: "Pitching Wedge",
        type: "wedge",
        length: 35.5 * IN,
        loft: 46,
        smash: 1.31,
        launchFactor: 0.7,
        faceWidth: 0.076,
        faceHeight: 0.05,
    },
    {
        id: "gw",
        label: "Gap Wedge",
        type: "wedge",
        length: 35.25 * IN,
        loft: 51,
        smash: 1.29,
        launchFactor: 0.68,
        faceWidth: 0.074,
        faceHeight: 0.05,
    },
    {
        id: "sw",
        label: "Sand Wedge",
        type: "wedge",
        length: 35 * IN,
        loft: 56,
        smash: 1.26,
        launchFactor: 0.66,
        faceWidth: 0.072,
        faceHeight: 0.049,
    },
    {
        id: "lw",
        label: "Lob Wedge",
        type: "wedge",
        length: 34.75 * IN,
        loft: 60,
        smash: 1.23,
        launchFactor: 0.64,
        faceWidth: 0.07,
        faceHeight: 0.048,
    },
];

export const DEFAULT_CLUB_ID = "7i";

export function getClub(id: string): Club {
    const club = CLUBS.find((c) => c.id === id);
    if (!club) throw new Error(`unknown club: ${id}`);
    return club;
}

/** Distance from the butt of the grip down to the IMU. */
export const IMU_OFFSET_FROM_BUTT = 0.05;

/** Shaft length the sensor actually sees, butt offset removed. */
export const effectiveShaftLength = (club: Club): number => club.length - IMU_OFFSET_FROM_BUTT;
