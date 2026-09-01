import { shapeLabel } from "../flight/ballflight";
import type { ImpactSource } from "../swing/impact";
import type { Mount } from "../swing/mount";
import type { StrikeZone } from "../swing/strike";
import type { SwingAnalysis } from "../swing/pipeline";
import { DEGREE, fixed, mph, sided, tempo, yards } from "./units";

const zoneLabel: Record<StrikeZone, string> = {
    center: "Center",
    toe: "Toe",
    heel: "Heel",
    thin: "Thin",
    top: "Top",
    fat: "Fat",
    whiff: "Whiff",
};

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
    return (
        <div className="stat">
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value}</span>
            {note ? <span className="stat-note">{note}</span> : null}
        </div>
    );
}

/**
 * How contact was placed, in the golfer's terms. Worth showing: every angle on
 * this panel is read at that instant, so knowing the club came back through the
 * ball is knowing whether the rest of the numbers mean anything.
 */
const impactNote: Record<ImpactSource, string> = {
    shock: "found the strike",
    return: "found the ball, no strike felt",
    proximity: "estimated from the arc",
    "peak-rate": "estimated, low confidence",
};

export function StatsPanel({
    analysis,
    learnedMount,
}: {
    analysis: SwingAnalysis;
    /** Set when this swing was also the one that taught the mount. */
    learnedMount?: Mount | null;
}) {
    const { stats, strike, flight, calibration, impact, hand } = analysis;
    // "Open/closed" and "in to out/out to in" are named relative to the
    // golfer, so a left-handed swing reads the opposite sign of a righty's.
    const mirror = hand === "right" ? 1 : -1;

    return (
        <div className="stats">
            {learnedMount ? (
                <p className="muted">
                    Stick set up from this swing: shaft {fixed(learnedMount.lieAngleDeg, 0)}
                    {DEGREE} off the ground at address. Every swing from here reads against that.
                    Redo it from Calibrate if the strap moves.
                </p>
            ) : null}
            {calibration.warning ? <p className="warning">{calibration.warning}</p> : null}
            {impact.passedBall ? null : (
                <p className="warning">
                    The clubhead came no closer than {fixed(impact.approachM * 100, 0)} cm to where
                    the ball was at address, so this reads like an air swing. Everything below is
                    measured at the low point of the arc instead.
                </p>
            )}

            <div className="stat-row headline">
                <Stat label="Tempo" value={tempo(stats.tempoRatio)} note="back : down" />
                <Stat label="Clubhead" value={`${fixed(mph(stats.clubheadSpeedMps), 0)} mph`} />
                <Stat
                    label="Carry"
                    value={`${fixed(yards(flight.carryM), 0)} yd`}
                    note={shapeLabel[flight.shape]}
                />
            </div>

            <div className="stat-row">
                <Stat
                    label="Strike"
                    value={zoneLabel[strike.zone]}
                    note={
                        strike.contactMade
                            ? `${fixed(strike.offCenterM * 1000, 0)} mm off center`
                            : "no contact"
                    }
                />
                <Stat
                    label="Contact at"
                    value={`${fixed(impact.sec, 2)} s`}
                    note={impactNote[impact.source]}
                />
            </div>

            <div className="stat-row">
                <Stat
                    label="Face to path"
                    value={sided(stats.faceToPathDeg * mirror, "closed", "open")}
                    note="what curves it"
                />
                <Stat
                    label="Curve"
                    value={sided(yards(flight.offlineM), "left", "right", 0, " yd")}
                />
            </div>

            <div className="stat-row">
                <Stat
                    label="Face"
                    value={`${fixed(stats.faceAngleDeg)}${DEGREE}`}
                    note={stats.faceAngleDeg * mirror > 0 ? "open" : "closed"}
                />
                <Stat
                    label="Path"
                    value={`${fixed(stats.pathAngleDeg)}${DEGREE}`}
                    note={stats.pathAngleDeg * mirror > 0 ? "in to out" : "out to in"}
                />
                <Stat
                    label="Attack"
                    value={`${fixed(stats.attackAngleDeg)}${DEGREE}`}
                    note="down is minus"
                />
            </div>

            <div className="stat-row">
                <Stat label="Backswing" value={`${fixed(stats.backswingSec, 2)} s`} />
                <Stat label="Downswing" value={`${fixed(stats.downswingSec, 2)} s`} />
                <Stat label="Pause" value={`${fixed(stats.transitionPauseSec, 2)} s`} />
            </div>

            <div className="stat-row">
                <Stat label="Swing plane" value={`${fixed(stats.swingPlaneDeg, 0)}${DEGREE}`} />
                <Stat label="Peak turn" value={`${fixed(stats.peakRateDps, 0)} dps`} />
                <Stat label="Ball speed" value={`${fixed(mph(flight.ballSpeedMps), 0)} mph`} />
            </div>

            <div className="stat-row">
                <Stat label="Launch" value={`${fixed(flight.launchAngleDeg)}${DEGREE}`} />
                <Stat label="Dynamic loft" value={`${fixed(flight.dynamicLoftDeg)}${DEGREE}`} />
                <Stat label="Apex" value={`${fixed(yards(flight.apexM), 0)} yd`} />
            </div>
        </div>
    );
}
