import type { ImuSample, ImuSource } from "../types";
import {
    BATTERY_CHAR_UUID,
    CONTROL_CHAR_UUID,
    DATA_CHAR_UUID,
    PING,
    PING_INTERVAL_MS,
    REC_START,
    REC_STOP,
    SERVICE_UUID,
    decodeImuBatch,
    decodeText,
    encodeText,
} from "./protocol";

export type BleStatus = "disconnected" | "connecting" | "reconnecting" | "connected" | "error";

export interface BleState {
    status: BleStatus;
    error: string | null;
    battery: number | null;
    /** Non-zero while the link is being rebuilt after an unexpected drop. */
    retry: number;
}

/**
 * Web Bluetooth on every platform fails connects that are not really failures.
 * Windows famously loses the first GATT connect while it resolves the device's
 * random address, and both Windows and Linux will drop a link that is a few
 * hundred milliseconds old, mid service discovery, for no stated reason. The
 * error that surfaces is almost always some flavour of "GATT Server is
 * disconnected. Cannot retrieve services".
 *
 * The old code retried device.gatt.connect() alone, which does not help: by the
 * time getPrimaryService throws, the connect it would retry has already
 * succeeded. Everything from connect through the last startNotifications has to
 * be retried as one unit, and the stale link has to be torn down first or the
 * next attempt inherits it.
 */
const CONNECT_ATTEMPTS = 4;
const CONNECT_BACKOFF_MS = [250, 600, 1200];

/** Attempts made to rebuild the link after it drops on its own. */
const RECONNECT_ATTEMPTS = 6;
const RECONNECT_BACKOFF_MS = [400, 800, 1600, 3000, 5000, 5000];

/**
 * A gap in the device's clock this long means the link went away and came back,
 * rather than a packet arriving late.
 */
const CLOCK_GAP_MS = 250;
/** Time credited across such a gap, so the stream stays monotonic without lying. */
const GAP_BRIDGE_MS = 20;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const message = (e: unknown, fallback: string): string =>
    e instanceof Error ? e.message : fallback;

/** The user cancelled the browser's device picker. Not an error worth showing. */
const isUserCancel = (e: unknown): boolean =>
    e instanceof DOMException && (e.name === "NotFoundError" || e.name === "AbortError");

interface Link {
    device: BluetoothDevice;
    control: BluetoothRemoteGATTCharacteristic;
}

/**
 * Talks to the Stick over Web Bluetooth and doubles as the ImuSource the
 * recorder pulls samples from. Persists across record/stop cycles
 * (recorder.start()/stop() just add and remove a listener), so the GATT
 * connection and the browser's device picker only happen once.
 */
export class BleStickDevice implements ImuSource {
    readonly info = { name: "Stick", rateHz: 400 };

    private state: BleState = { status: "disconnected", error: null, battery: null, retry: 0 };
    private stateListeners = new Set<(s: BleState) => void>();
    private sampleListeners = new Set<(batch: ImuSample[]) => void>();
    private controlListeners = new Set<(recording: boolean) => void>();

    private device: BluetoothDevice | null = null;
    private control: BluetoothRemoteGATTCharacteristic | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;

    /** True between connect() and disconnect(): whether the link should exist. */
    private wanted = false;
    /** Guards against two reconnect ladders running at once. */
    private busy = false;

    private tBaseMs: number | null = null;
    private tOffsetSec = 0;
    private lastDeviceMs = 0;
    private lastEmittedSec = 0;

    onStateChange(cb: (s: BleState) => void): () => void {
        this.stateListeners.add(cb);
        cb(this.state);
        return () => this.stateListeners.delete(cb);
    }

    onControl(cb: (recording: boolean) => void): () => void {
        this.controlListeners.add(cb);
        return () => this.controlListeners.delete(cb);
    }

    private setState(patch: Partial<BleState>): void {
        this.state = { ...this.state, ...patch };
        for (const cb of this.stateListeners) cb(this.state);
    }

    /** Opens the browser's device picker, then brings the link up. */
    async connect(): Promise<void> {
        if (!navigator.bluetooth) {
            this.setState({ status: "error", error: "This browser doesn't support Web Bluetooth" });
            return;
        }
        if (this.busy) return;

        let device: BluetoothDevice;
        try {
            device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [SERVICE_UUID] }],
            });
        } catch (e) {
            if (isUserCancel(e)) {
                this.setState({ status: "disconnected", error: null });
            } else {
                this.setState({ status: "error", error: message(e, "Couldn't open the picker") });
            }
            return;
        }

        this.device = device;
        this.wanted = true;
        device.removeEventListener("gattserverdisconnected", this.handleDisconnected);
        device.addEventListener("gattserverdisconnected", this.handleDisconnected);

        this.setState({ status: "connecting", error: null, retry: 0 });
        await this.openWithRetries(CONNECT_ATTEMPTS, CONNECT_BACKOFF_MS, "connecting");
    }

    disconnect(): void {
        this.wanted = false;
        this.stopPinging();
        // Tell the device we are going before the radio link drops, so it can put
        // itself back on the air immediately rather than waiting out a timeout.
        void this.write(REC_STOP);
        this.device?.gatt?.disconnect();
    }

    /** Ask the device to start or stop recording, mirroring its own button. */
    async setRecording(on: boolean): Promise<void> {
        await this.write(on ? REC_START : REC_STOP);
    }

    // -- link -------------------------------------------------------------

    /**
     * Build the link, retrying the whole of it. Any step can fail with a
     * disconnect that has nothing to do with the step itself, so a partial
     * attempt is torn down and started again rather than resumed.
     */
    private async openWithRetries(
        attempts: number,
        backoff: readonly number[],
        status: BleStatus,
    ): Promise<boolean> {
        if (this.busy) return false;
        this.busy = true;
        try {
            let lastErr: unknown;
            for (let attempt = 0; attempt < attempts; attempt++) {
                if (!this.wanted || !this.device) return false;
                this.setState({ status, retry: attempt });
                try {
                    const link = await this.open(this.device);
                    this.control = link.control;
                    this.resetClock();
                    this.startPinging();
                    this.setState({ status: "connected", error: null, retry: 0 });
                    return true;
                } catch (e) {
                    lastErr = e;
                    this.teardown();
                    if (attempt < attempts - 1) {
                        await delay(backoff[Math.min(attempt, backoff.length - 1)]);
                    }
                }
            }
            if (this.wanted) {
                this.setState({
                    status: "error",
                    error: message(lastErr, "Couldn't reach the Stick"),
                    retry: 0,
                });
            }
            return false;
        } finally {
            this.busy = false;
        }
    }

    private async open(device: BluetoothDevice): Promise<Link> {
        if (!device.gatt) throw new Error("Device has no GATT server");
        // Always start from a clean slate. Reconnecting on top of a half-open link
        // is what produces "GATT Server is disconnected" three calls later.
        if (device.gatt.connected) device.gatt.disconnect();

        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(SERVICE_UUID);

        const data = await service.getCharacteristic(DATA_CHAR_UUID);
        const control = await service.getCharacteristic(CONTROL_CHAR_UUID);
        const battery = await service.getCharacteristic(BATTERY_CHAR_UUID);

        data.addEventListener("characteristicvaluechanged", this.handleData);
        control.addEventListener("characteristicvaluechanged", this.handleControl);
        battery.addEventListener("characteristicvaluechanged", this.handleBattery);

        // Subscribing to data is what tells the firmware to start streaming, so it
        // goes last, once everything that reads the stream is already listening.
        await control.startNotifications();
        await battery.startNotifications();
        await data.startNotifications();

        try {
            const initial = await battery.readValue();
            this.setState({ battery: initial.getUint8(0) });
        } catch {
            // A notification will fill this in shortly. Not worth failing over.
        }

        if (!device.gatt.connected) throw new Error("Link dropped during setup");
        return { device, control };
    }

    private teardown(): void {
        this.stopPinging();
        this.control = null;
        try {
            this.device?.gatt?.disconnect();
        } catch {
            // Already gone. Nothing to clean up.
        }
    }

    private handleDisconnected = (): void => {
        this.stopPinging();
        this.control = null;
        this.setState({ battery: null });

        if (!this.wanted) {
            this.setState({ status: "disconnected", error: null, retry: 0 });
            return;
        }
        // The link went away on its own. That is routine on this stack, so rebuild
        // it rather than dumping the golfer back at a Connect button: the device is
        // still paired, so no picker is needed and nothing is lost but a second.
        void this.openWithRetries(RECONNECT_ATTEMPTS, RECONNECT_BACKOFF_MS, "reconnecting");
    };

    // -- keepalive ---------------------------------------------------------

    private startPinging(): void {
        this.stopPinging();
        void this.write(PING);
        this.pingTimer = setInterval(() => void this.write(PING), PING_INTERVAL_MS);
    }

    private stopPinging(): void {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private async write(text: string): Promise<void> {
        const control = this.control;
        if (!control || !this.device?.gatt?.connected) return;
        try {
            const bytes = encodeText(text) as BufferSource;
            // Unacknowledged: a ping that needs a round trip to say "still here"
            // costs a connection interval every second for no benefit.
            if (control.writeValueWithoutResponse) {
                await control.writeValueWithoutResponse(bytes);
            } else {
                await control.writeValue(bytes);
            }
        } catch {
            // A failed write means the link is going or gone. The disconnect
            // handler owns recovery; there is nothing useful to do here.
        }
    }

    // -- stream ------------------------------------------------------------

    private resetClock(): void {
        this.tBaseMs = null;
    }

    /**
     * Device uptime to a seconds-since-first-sample clock that only ever moves
     * forward.
     *
     * The device's clock is its own uptime, so it jumps backwards if it reboots
     * and forwards across any stretch where the link was down. Either one would
     * be read by the detector as a wild change in sample rate, and it derives its
     * thresholds from that rate. So a jump is bridged with a small fixed step
     * instead: the stream stays monotonic and roughly honest, and a swing that
     * straddled the gap is not one anybody was going to analyse anyway.
     */
    private toSeconds(deviceMs: number): number {
        if (this.tBaseMs === null) {
            this.tBaseMs = deviceMs;
            this.tOffsetSec = this.lastEmittedSec;
            this.lastDeviceMs = deviceMs;
        } else if (deviceMs < this.lastDeviceMs || deviceMs - this.lastDeviceMs > CLOCK_GAP_MS) {
            this.tBaseMs = deviceMs;
            this.tOffsetSec = this.lastEmittedSec + GAP_BRIDGE_MS / 1000;
        }
        this.lastDeviceMs = deviceMs;
        const t = (deviceMs - this.tBaseMs) / 1000 + this.tOffsetSec;
        this.lastEmittedSec = t;
        return t;
    }

    private handleData = (e: Event): void => {
        const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const { timesMs, samples } = decodeImuBatch(value);
        if (samples.length === 0) return;

        const batch: ImuSample[] = new Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
            batch[i] = { t: this.toSeconds(timesMs[i]), ...samples[i] };
        }
        for (const cb of this.sampleListeners) cb(batch);
    };

    private handleControl = (e: Event): void => {
        const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const text = decodeText(value);
        if (text === REC_START) for (const cb of this.controlListeners) cb(true);
        else if (text === REC_STOP) for (const cb of this.controlListeners) cb(false);
    };

    private handleBattery = (e: Event): void => {
        const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.setState({ battery: value.getUint8(0) });
    };

    // The link streams continuously while it is up; start and stop only gate
    // whether samples reach the detector. See useSwingRecorder.
    async start(): Promise<void> {}
    stop(): void {}

    onSamples(cb: (batch: ImuSample[]) => void): () => void {
        this.sampleListeners.add(cb);
        return () => this.sampleListeners.delete(cb);
    }
}
