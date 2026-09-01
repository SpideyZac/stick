import { useState } from "react";
import { getClub } from "../data/clubs";
import { SWING_IDS, SWING_LABELS, type SwingId } from "../imu/mock/swings";
import type { BleDevice } from "./useBleDevice";
import { STATUS_TEXT, type RecorderStatus } from "./useSwingRecorder";

interface Props {
    clubId: string;
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
    const [key, setKey] = useState("");

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
                <span>Choose your Stick in the browser prompt…</span>
            </div>
        );
    }

    if (device.status === "needs-key" || device.status === "authenticating") {
        return (
            <form
                className="dev-key"
                onSubmit={(e) => {
                    e.preventDefault();
                    device.submitKey(key);
                }}
            >
                <input
                    type="text"
                    inputMode="text"
                    autoCapitalize="off"
                    autoCorrect="off"
                    placeholder="Device key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    disabled={device.status === "authenticating"}
                />
                <button
                    type="submit"
                    className="link"
                    disabled={device.status === "authenticating"}
                >
                    {device.status === "authenticating" ? "Checking…" : "Unlock"}
                </button>
                {device.error ? <p className="warning">{device.error}</p> : null}
            </form>
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
                <p className="muted center">
                    {connected
                        ? "Tap record, or press the button on the Stick."
                        : "Tap record and take your time getting set up."}
                </p>
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
