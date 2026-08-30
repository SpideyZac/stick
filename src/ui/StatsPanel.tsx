import { shapeLabel } from "../flight/ballflight";
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

export function StatsPanel({ analysis }: { analysis: SwingAnalysis }) {
    const { stats, strike, flight, calibration } = analysis;

    return (
        <div className="stats">
            {calibration.warning ? <p className="warning">{calibration.warning}</p> : null}

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
            </div>

            <div className="stat-row">
                <Stat
                    label="Face to path"
                    value={sided(stats.faceToPathDeg, "closed", "open")}
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
                    note={stats.faceAngleDeg > 0 ? "open" : "closed"}
                />
                <Stat
                    label="Path"
                    value={`${fixed(stats.pathAngleDeg)}${DEGREE}`}
                    note={stats.pathAngleDeg > 0 ? "in to out" : "out to in"}
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
