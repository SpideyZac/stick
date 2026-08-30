import { useMemo, useState } from "react";
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { CLUBS } from "../data/clubs";
import { useProfile } from "../profile/ProfileContext";
import type { StrikeZone } from "../swing/strike";
import { fixed, mph, yards } from "./units";

const ZONE_ORDER: StrikeZone[] = ["center", "toe", "heel", "thin", "top", "fat", "whiff"];

function average(values: number[]): number {
    if (values.length === 0) return NaN;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

export function HistoryScreen({ onDone }: { onDone: () => void }) {
    const { profile, clearHistory } = useProfile();
    const clubsHit = useMemo(
        () => Array.from(new Set(profile.swings.map((s) => s.clubId))),
        [profile.swings],
    );
    const [clubId, setClubId] = useState<string | null>(
        profile.swings.at(-1)?.clubId ?? clubsHit[0] ?? null,
    );
    const [confirmClear, setConfirmClear] = useState(false);

    const activeClubId = clubId && clubsHit.includes(clubId) ? clubId : clubsHit[0];
    const swings = useMemo(
        () => (activeClubId ? profile.swings.filter((s) => s.clubId === activeClubId) : []),
        [profile.swings, activeClubId],
    );

    const avgSpeed = average(swings.map((s) => s.clubheadSpeedMps));
    const avgCarry = average(swings.map((s) => s.carryM));
    const avgSmash = average(
        swings.map((s) => s.ballSpeedMps / s.clubheadSpeedMps).filter(Number.isFinite),
    );
    const zoneCounts = ZONE_ORDER.map((zone) => ({
        zone,
        count: swings.filter((s) => s.strikeZone === zone).length,
    })).filter((z) => z.count > 0);

    const chartData = swings.map((s, i) => ({
        index: i + 1,
        clubheadMph: mph(s.clubheadSpeedMps),
        carryYd: yards(s.carryM),
        faceAngleDeg: s.faceAngleDeg,
        pathAngleDeg: s.pathAngleDeg,
    }));

    return (
        <div className="screen">
            <header className="screen-head row">
                <h1>Stats</h1>
                <button type="button" className="link" onClick={onDone}>
                    Done
                </button>
            </header>

            <div className="scroll">
                {clubsHit.length === 0 ? (
                    <p className="muted">No swings recorded yet. Hit a few and check back here.</p>
                ) : (
                    <>
                        <select
                            className="history-club-select"
                            value={activeClubId ?? ""}
                            onChange={(e) => setClubId(e.target.value)}
                        >
                            {CLUBS.filter((c) => clubsHit.includes(c.id)).map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.label}
                                </option>
                            ))}
                        </select>

                        <div className="stat-row headline">
                            <div className="stat">
                                <span className="stat-label">Swings</span>
                                <span className="stat-value">{swings.length}</span>
                            </div>
                            <div className="stat">
                                <span className="stat-label">Avg clubhead</span>
                                <span className="stat-value">{fixed(mph(avgSpeed), 0)} mph</span>
                            </div>
                            <div className="stat">
                                <span className="stat-label">Avg carry</span>
                                <span className="stat-value">{fixed(yards(avgCarry), 0)} yd</span>
                            </div>
                            <div className="stat">
                                <span className="stat-label">Avg smash</span>
                                <span className="stat-value">{fixed(avgSmash, 2)}</span>
                            </div>
                        </div>

                        {zoneCounts.length > 0 ? (
                            <div className="stat-row">
                                {zoneCounts.map(({ zone, count }) => (
                                    <div className="stat" key={zone}>
                                        <span className="stat-label">{zone}</span>
                                        <span className="stat-value">{count}</span>
                                    </div>
                                ))}
                            </div>
                        ) : null}

                        {chartData.length > 1 ? (
                            <>
                                <h2 className="group-label">Clubhead speed &amp; carry</h2>
                                <div className="chart-box">
                                    <ResponsiveContainer width="100%" height={180}>
                                        <LineChart data={chartData}>
                                            <CartesianGrid
                                                strokeDasharray="3 3"
                                                stroke="var(--line)"
                                            />
                                            <XAxis
                                                dataKey="index"
                                                stroke="var(--dim)"
                                                fontSize={11}
                                            />
                                            <YAxis stroke="var(--dim)" fontSize={11} />
                                            <Tooltip />
                                            <Line
                                                type="monotone"
                                                dataKey="clubheadMph"
                                                name="Clubhead (mph)"
                                                stroke="var(--accent)"
                                                dot={false}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="carryYd"
                                                name="Carry (yd)"
                                                stroke="var(--warn)"
                                                dot={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>

                                <h2 className="group-label">Face &amp; path</h2>
                                <div className="chart-box">
                                    <ResponsiveContainer width="100%" height={180}>
                                        <LineChart data={chartData}>
                                            <CartesianGrid
                                                strokeDasharray="3 3"
                                                stroke="var(--line)"
                                            />
                                            <XAxis
                                                dataKey="index"
                                                stroke="var(--dim)"
                                                fontSize={11}
                                            />
                                            <YAxis stroke="var(--dim)" fontSize={11} />
                                            <Tooltip />
                                            <Line
                                                type="monotone"
                                                dataKey="faceAngleDeg"
                                                name="Face (deg)"
                                                stroke="var(--accent)"
                                                dot={false}
                                            />
                                            <Line
                                                type="monotone"
                                                dataKey="pathAngleDeg"
                                                name="Path (deg)"
                                                stroke="var(--warn)"
                                                dot={false}
                                            />
                                        </LineChart>
                                    </ResponsiveContainer>
                                </div>
                            </>
                        ) : null}
                    </>
                )}

                {profile.swings.length > 0 ? (
                    <button
                        type="button"
                        className="link"
                        onClick={() => {
                            if (confirmClear) {
                                clearHistory();
                                setConfirmClear(false);
                            } else {
                                setConfirmClear(true);
                            }
                        }}
                    >
                        {confirmClear ? "Tap again to clear all history" : "Clear history"}
                    </button>
                ) : null}
            </div>
        </div>
    );
}
