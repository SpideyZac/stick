import { useCallback, useEffect, useRef, useState } from "react";
import { getClub } from "../data/clubs";
import { MockImuSource } from "../imu/mock/source";
import type { SwingId } from "../imu/mock/swings";
import type { ImuSource } from "../imu/types";
import { SwingDetector, type DetectState } from "../swing/detect";
import type { Handedness } from "../swing/frames";
import { type SwingAnalysis, analyzeSwing } from "../swing/pipeline";

export type RecorderStatus = "idle" | DetectState;

export interface Recorder {
    status: RecorderStatus;
    analysis: SwingAnalysis | null;
    error: string | null;
    start: () => void;
    stop: () => void;
    clear: () => void;
}

/**
 * Wires a sample source to the detector and the analysis.
 *
 * The source is only ever touched through the ImuSource interface, so this is
 * the single place a real BLE connection has to be introduced later.
 */
export function useSwingRecorder(clubId: string, hand: Handedness, mockSwing: SwingId): Recorder {
    const [status, setStatus] = useState<RecorderStatus>("idle");
    const [analysis, setAnalysis] = useState<SwingAnalysis | null>(null);
    const [error, setError] = useState<string | null>(null);

    const sourceRef = useRef<ImuSource | null>(null);
    const unsubscribeRef = useRef<(() => void) | null>(null);
    // Read inside the sample callback, so they must not go stale between renders.
    const clubRef = useRef(clubId);
    const handRef = useRef(hand);
    clubRef.current = clubId;
    handRef.current = hand;

    const stop = useCallback(() => {
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        sourceRef.current?.stop();
        sourceRef.current = null;
        setStatus("idle");
    }, []);

    const start = useCallback(() => {
        stop();
        setError(null);
        setAnalysis(null);

        const detector = new SwingDetector(
            (capture) => {
                try {
                    setAnalysis(analyzeSwing(capture, getClub(clubRef.current), handRef.current));
                } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not read that swing");
                }
                stop();
            },
            (next) => setStatus(next),
        );

        const source = new MockImuSource({
            swing: mockSwing,
            clubId: clubRef.current,
            hand: handRef.current,
        });
        sourceRef.current = source;
        unsubscribeRef.current = source.onSamples((batch) => detector.push(batch));
        setStatus("settling");
        void source.start();
    }, [mockSwing, stop]);

    const clear = useCallback(() => {
        stop();
        setAnalysis(null);
        setError(null);
    }, [stop]);

    // Never leave a timer running behind a closed screen.
    useEffect(() => stop, [stop]);

    return { status, analysis, error, start, stop, clear };
}

export const STATUS_TEXT: Record<RecorderStatus, string> = {
    idle: "Ready when you are",
    settling: "Settle in over the ball",
    still: "Holding steady, swing when ready",
    candidate: "Something moved, checking",
    capturing: "Swing away",
};
