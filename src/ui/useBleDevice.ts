import { useEffect, useRef, useState } from "react";
import { BleStickDevice, type BleState } from "../imu/ble/source";

export interface BleDevice extends BleState {
    source: BleStickDevice;
    connect: () => void;
    disconnect: () => void;
    setRecording: (on: boolean) => void;
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
        retry: 0,
    });

    useEffect(() => device.onStateChange(setState), [device]);

    // A page that goes away without hanging up leaves the device believing a
    // website is still listening. It works that out from the missing pings, but
    // saying so costs nothing and puts it back on the air straight away.
    useEffect(() => {
        const bye = () => device.disconnect();
        window.addEventListener("pagehide", bye);
        return () => window.removeEventListener("pagehide", bye);
    }, [device]);

    return {
        ...state,
        source: device,
        connect: () => void device.connect(),
        disconnect: () => device.disconnect(),
        setRecording: (on: boolean) => void device.setRecording(on),
        onControl: (cb) => device.onControl(cb),
    };
}
