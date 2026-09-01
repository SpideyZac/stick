import { getClub } from "../data/clubs";
import { SWING_IDS, SWING_LABELS, type SwingId } from "../imu/mock/swings";
import type { BleDevice } from "./useBleDevice";
import { STATUS_TEXT, type RecorderStatus } from "./useSwingRecorder";

interface Props {
    clubId: string;
    /** False until a swing has taught the app how the Stick is strapped on. */
    hasMount: boolean;
    status: RecorderStatus;
    error: string | null;
    mockSwing: SwingId;
    onMockSwing: (id: SwingId) => void;
    onStart: () => void;
    onStop: () => void;
    onChangeClub: () => void;
    device: BleDevice;
}

function DeviceRow({ device }: { device: BleDevice }) {
    if (device.status === "disconnected" || device.status === "error") {
        return (
            <div className="dev-source">
                <span>{device.error ?? "No device connected"}</span>
                <button type="button" className="link" onClick={device.connect}>
                    Connect Stick
                </button>
            </div>
        );
    }

    if (device.status === "connecting") {
        return (
            <div className="dev-source">
                <span>
                    {device.retry > 0
                        ? `Connecting… (attempt ${device.retry + 1})`
                        : "Choose your Stick in the browser prompt…"}
                </span>
            </div>
        );
    }

    // Dropped links are routine on this stack and get rebuilt without the golfer
    // touching anything, so this says what is happening rather than offering a
    // button that would only do the same thing again.
    if (device.status === "reconnecting") {
        return (
            <div className="dev-source">
                <span>Lost the Stick, reconnecting… (attempt {device.retry + 1})</span>
                <button type="button" className="link" onClick={device.disconnect}>
                    Give up
                </button>
            </div>
        );
    }

    return (
        <div className="dev-source">
            <span>Stick connected{device.battery !== null ? ` · ${device.battery}%` : ""}</span>
            <button type="button" className="link" onClick={device.disconnect}>
                Disconnect
            </button>
        </div>
    );
}

export function RecordScreen({
    clubId,
    hasMount,
    status,
    error,
    mockSwing,
    onMockSwing,
    onStart,
    onStop,
    onChangeClub,
    device,
}: Props) {
    const recording = status !== "idle";
    const connected = device.status === "connected";

    return (
        <div className="screen">
            <header className="screen-head">
                <button type="button" className="link" onClick={onChangeClub}>
                    {getClub(clubId).label}
                    <span className="chev"> change</span>
                </button>
            </header>

            <div className="record-body">
                <div className={`status status-${status}`}>
                    <span className="status-dot" />
                    {STATUS_TEXT[status]}
                </div>
                {error ? <p className="warning">{error}</p> : null}
                {hasMount ? (
                    <p className="muted center">
                        {connected
                            ? "Tap record, or press the button on the Stick."
                            : "Tap record and take your time getting set up."}
                    </p>
                ) : (
                    // Nothing is known yet about which way up the Stick went on the
                    // shaft, and this swing is what works it out. Worth saying so: it
                    // is the one swing where grounding the club properly matters to
                    // every swing afterwards, not just to this one.
                    <p className="muted center">
                        First swing sets up the Stick. Ground the club behind the ball, settle, then
                        make one normal swing.
                    </p>
                )}
            </div>

            <footer className="screen-foot">
                {connected ? (
                    <DeviceRow device={device} />
                ) : (
                    <>
                        {/* Stand-in source until a Stick is connected. */}
                        <label className="dev-source">
                            <span>Mock source</span>
                            <select
                                value={mockSwing}
                                onChange={(e) => onMockSwing(e.target.value as SwingId)}
                                disabled={recording}
                            >
                                {SWING_IDS.map((id) => (
                                    <option key={id} value={id}>
                                        {SWING_LABELS[id]}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <DeviceRow device={device} />
                    </>
                )}

                <button
                    type="button"
                    className={recording ? "record on" : "record"}
                    onClick={recording ? onStop : onStart}
                >
                    {recording ? "Stop" : "Record"}
                </button>
            </footer>
        </div>
    );
}
