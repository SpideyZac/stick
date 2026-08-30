/** A golf ball, and its geometry. Fixed on purpose, not worth exposing as a setting. */
export const BALL = { massKg: 0.04593, diameterM: 0.04267 } as const;

export const BALL_RADIUS_M = BALL.diameterM / 2;
