import { useEffect, useState } from "react";
import { DEFAULT_CLUB_ID, getClub } from "../data/clubs";
import type { SwingId } from "../imu/mock/swings";
import { useProfile } from "../profile/ProfileContext";
import type { SwingRecord } from "../profile/types";
import { CalibrateScreen } from "./CalibrateScreen";
import { ClubPicker } from "./ClubPicker";
import { HistoryScreen } from "./HistoryScreen";
import { RecordScreen } from "./RecordScreen";
import { StatsPanel } from "./StatsPanel";
import { SwingView } from "./SwingView";
import { useSwingRecorder } from "./useSwingRecorder";

type Screen = "setup" | "record" | "results" | "calibrate" | "history";

let swingCounter = 0;
const nextSwingId = (): string => `${Date.now()}-${++swingCounter}`;

export function App() {
    const { profile, setHand, resolveClub, addSwing } = useProfile();
    const [screen, setScreen] = useState<Screen>("setup");
    const [clubId, setClubId] = useState(DEFAULT_CLUB_ID);
    const [mockSwing, setMockSwing] = useState<SwingId>("good");

    const recorder = useSwingRecorder(clubId, profile.hand, mockSwing, resolveClub);

    // A finished swing is the only thing that moves us to the results screen.
    useEffect(() => {
        if (!recorder.analysis) return;
        setScreen("results");

        const { stats, flight, strike, club } = recorder.analysis;
        const record: SwingRecord = {
            id: nextSwingId(),
            ts: Date.now(),
            clubId: club.id,
            clubheadSpeedMps: stats.clubheadSpeedMps,
            ballSpeedMps: flight.ballSpeedMps,
            carryM: flight.carryM,
            apexM: flight.apexM,
            faceAngleDeg: stats.faceAngleDeg,
            pathAngleDeg: stats.pathAngleDeg,
            faceToPathDeg: stats.faceToPathDeg,
            attackAngleDeg: stats.attackAngleDeg,
            tempoRatio: stats.tempoRatio,
            strikeZone: strike.zone,
            offCenterM: strike.offCenterM,
            shape: flight.shape,
        };
        addSwing(record);
        // Only ever fires off a fresh analysis object, recording each swing once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recorder.analysis]);

    if (screen === "calibrate") {
        return (
            <div className="app">
                <CalibrateScreen onDone={() => setScreen("setup")} />
            </div>
        );
    }

    if (screen === "history") {
        return (
            <div className="app">
                <HistoryScreen onDone={() => setScreen("setup")} />
            </div>
        );
    }

    if (screen === "setup") {
        return (
            <div className="app">
                <ClubPicker
                    clubId={clubId}
                    hand={profile.hand}
                    onClub={setClubId}
                    onHand={setHand}
                    onDone={() => setScreen("record")}
                    onCalibrate={() => setScreen("calibrate")}
                    onHistory={() => setScreen("history")}
                />
            </div>
        );
    }

    if (screen === "results" && recorder.analysis) {
        return (
            <div className="app">
                <div className="screen">
                    <header className="screen-head row">
                        <h1>{getClub(clubId).label}</h1>
                        <button
                            type="button"
                            className="link"
                            onClick={() => {
                                recorder.clear();
                                setScreen("record");
                            }}
                        >
                            Done
                        </button>
                    </header>
                    <div className="scroll">
                        <SwingView analysis={recorder.analysis} />
                        <StatsPanel analysis={recorder.analysis} />
                    </div>
                    <footer className="screen-foot">
                        <button
                            type="button"
                            className="primary"
                            onClick={() => {
                                recorder.clear();
                                setScreen("record");
                                recorder.start();
                            }}
                        >
                            Hit another
                        </button>
                    </footer>
                </div>
            </div>
        );
    }

    return (
        <div className="app">
            <RecordScreen
                clubId={clubId}
                status={recorder.status}
                error={recorder.error}
                mockSwing={mockSwing}
                onMockSwing={setMockSwing}
                onStart={recorder.start}
                onStop={recorder.stop}
                onChangeClub={() => {
                    recorder.stop();
                    setScreen("setup");
                }}
            />
        </div>
    );
}
