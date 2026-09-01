import { useEffect, useRef, useState } from "react";
import { BleStickDevice, type BleState } from "../imu/ble/source";

export interface BleDevice extends BleState {
    source: BleStickDevice;
    connect: () => void;
    submitKey: (key: string) => void;
    disconnect: () => void;
    onControl: (cb: (recording: boolean) => void) => () => void;
}

const supported = typeof navigator !== "undefined" && !!navigator.bluetooth;

/**
 * One BleStickDevice instance lives for the life of the app. Recreating it
 * per connect attempt would mean re-prompting the browser's device picker
 * every time the recorder starts/stops.
 */
export function useBleDevice(): BleDevice {
    const deviceRef = useRef<BleStickDevice>();
    if (!deviceRef.current) deviceRef.current = new BleStickDevice();
    const device = deviceRef.current;

    const [state, setState] = useState<BleState>({
        status: supported ? "disconnected" : "error",
        error: supported ? null : "This browser doesn't support Web Bluetooth",
        battery: null,
    });

    useEffect(() => device.onStateChange(setState), [device]);

    return {
        ...state,
        source: device,
        connect: () => void device.connect(),
        submitKey: (key: string) => void device.submitKey(key),
        disconnect: () => device.disconnect(),
        onControl: (cb) => device.onControl(cb),
    };
}
