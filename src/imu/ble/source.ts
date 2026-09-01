import type { ImuSample, ImuSource } from "../types";
import {
    AUTH_CHAR_UUID,
    BATTERY_CHAR_UUID,
    CONTROL_CHAR_UUID,
    DATA_CHAR_UUID,
    STATUS_CHAR_UUID,
    SERVICE_UUID,
    decodeImuPacket,
    decodeText,
    encodeText,
} from "./protocol";

export type BleStatus =
    "disconnected" | "connecting" | "needs-key" | "authenticating" | "connected" | "error";

export interface BleState {
    status: BleStatus;
    error: string | null;
    battery: number | null;
}

const AUTH_TIMEOUT_MS = 5000;

// Windows' Bluetooth stack is known to fail the first GATT connect attempt
// while it resolves the device's random address (IRK/RPA resolution) --
// this is a documented OS-level quirk, not something under our control.
// Retrying a couple of times with a short delay reliably clears it.
const CONNECT_RETRIES = 3;
const CONNECT_RETRY_DELAY_MS = 700;

/**
 * Talks to the Stick over Web Bluetooth and doubles as the ImuSource the
 * recorder pulls samples from once authenticated. Persists across
 * record/stop cycles (recorder.start()/stop() just add/remove a listener),
 * so the GATT connection and the browser's device picker only happen once.
 */
export class BleStickDevice implements ImuSource {
    readonly info = { name: "Stick", rateHz: 100 };

    private state: BleState = { status: "disconnected", error: null, battery: null };
    private stateListeners = new Set<(s: BleState) => void>();
    private sampleListeners = new Set<(batch: ImuSample[]) => void>();
    private controlListeners = new Set<(recording: boolean) => void>();

    private device: BluetoothDevice | null = null;
    private authChar: BluetoothRemoteGATTCharacteristic | null = null;
    private tBaseMs: number | null = null;
    private authWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

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

    /**
     * Wraps device.gatt.connect() with a few retries. See CONNECT_RETRIES
     * comment above -- this is working around a Windows-specific Bluetooth
     * stack quirk, not a real connectivity failure.
     */
    private async connectGatt(device: BluetoothDevice): Promise<BluetoothRemoteGATTServer> {
        let lastErr: unknown;
        for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
            try {
                return await device.gatt!.connect();
            } catch (e) {
                lastErr = e;
                if (attempt < CONNECT_RETRIES) {
                    await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
                }
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error("Couldn't connect");
    }

    /** Opens the browser's device picker and connects, but doesn't unlock the link yet. */
    async connect(): Promise<void> {
        if (!navigator.bluetooth) {
            this.setState({ status: "error", error: "This browser doesn't support Web Bluetooth" });
            return;
        }

        this.setState({ status: "connecting", error: null });
        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [SERVICE_UUID] }],
            });
            this.device = device;
            device.addEventListener("gattserverdisconnected", this.handleDisconnected);

            const server = await this.connectGatt(device);
            const service = await server.getPrimaryService(SERVICE_UUID);

            this.authChar = await service.getCharacteristic(AUTH_CHAR_UUID);

            const statusChar = await service.getCharacteristic(STATUS_CHAR_UUID);
            await statusChar.startNotifications();
            statusChar.addEventListener("characteristicvaluechanged", this.handleStatus);

            const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
            await dataChar.startNotifications();
            dataChar.addEventListener("characteristicvaluechanged", this.handleData);

            const controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
            await controlChar.startNotifications();
            controlChar.addEventListener("characteristicvaluechanged", this.handleControl);

            const batteryChar = await service.getCharacteristic(BATTERY_CHAR_UUID);
            await batteryChar.startNotifications();
            batteryChar.addEventListener("characteristicvaluechanged", this.handleBattery);
            try {
                const initial = await batteryChar.readValue();
                this.setState({ battery: initial.getUint8(0) });
            } catch {
                // Notification will fill this in shortly; not fatal.
            }

            this.setState({ status: "needs-key" });
        } catch (e) {
            this.setState({
                status: "error",
                error: e instanceof Error ? e.message : "Couldn't connect",
            });
        }
    }

    /** Writes the pairing key and waits for the device to accept or reject it. */
    async submitKey(key: string): Promise<void> {
        if (!this.authChar) {
            this.setState({ status: "error", error: "Not connected" });
            return;
        }
        this.setState({ status: "authenticating", error: null });

        const authed = new Promise<void>((resolve, reject) => {
            this.authWaiter = { resolve, reject };
        });

        try {
            await this.authChar.writeValueWithResponse(encodeText(key) as BufferSource);
        } catch (e) {
            this.authWaiter = null;
            // handleDisconnected already set a clearer status/error for this case.
            if (this.device) {
                this.setState({
                    status: "needs-key",
                    error: e instanceof Error ? e.message : "Couldn't send the key",
                });
            }
            return;
        }

        const timeout = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("Device didn't respond")), AUTH_TIMEOUT_MS),
        );

        try {
            await Promise.race([authed, timeout]);
            this.tBaseMs = null;
            this.setState({ status: "connected", error: null });
        } catch (e) {
            if (this.device) {
                this.setState({
                    status: "needs-key",
                    error: e instanceof Error ? e.message : "Wrong key",
                });
            }
        } finally {
            this.authWaiter = null;
        }
    }

    disconnect(): void {
        this.device?.gatt?.disconnect();
    }

    private handleDisconnected = (): void => {
        // If we were mid-auth, the device hung up before we got an answer
        // (e.g. it gave up waiting for the key) — surface that instead of
        // silently going back to "disconnected".
        const wasAuthing =
            this.state.status === "needs-key" || this.state.status === "authenticating";
        this.authWaiter?.reject(new Error("Device closed the connection"));
        this.authWaiter = null;
        this.authChar = null;
        this.device = null;
        this.tBaseMs = null;
        this.setState({
            status: "disconnected",
            error: wasAuthing ? "Device gave up waiting — connect again" : null,
            battery: null,
        });
    };

    private handleStatus = (e: Event): void => {
        const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const text = decodeText(value);
        if (text === "AUTH_OK") this.authWaiter?.resolve();
        else if (text === "AUTH_FAIL") this.authWaiter?.reject(new Error("Wrong key"));
    };

    private handleData = (e: Event): void => {
        const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const { tMs, sample } = decodeImuPacket(value);
        if (this.tBaseMs === null) this.tBaseMs = tMs;
        const t = (tMs - this.tBaseMs) / 1000;
        const batch: ImuSample[] = [{ t, ...sample }];
        for (const cb of this.sampleListeners) cb(batch);
    };

    private handleControl = (e: Event): void => {
        const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const text = decodeText(value);
        if (text === "REC_START") for (const cb of this.controlListeners) cb(true);
        else if (text === "REC_STOP") for (const cb of this.controlListeners) cb(false);
    };

    private handleBattery = (e: Event): void => {
        const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.setState({ battery: value.getUint8(0) });
    };
    // The link streams continuously once authenticated; start/stop just
    // gate whether samples reach the detector; see useSwingRecorder.
    async start(): Promise<void> {}
    stop(): void {}

    onSamples(cb: (batch: ImuSample[]) => void): () => void {
        this.sampleListeners.add(cb);
        return () => this.sampleListeners.delete(cb);
    }
}
