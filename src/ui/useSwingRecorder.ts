import { useCallback, useEffect, useRef, useState } from "react";
import type { Club } from "../data/clubs";
import type { ImuSource } from "../imu/types";
import { SwingDetector, type DetectState } from "../swing/detect";
import type { Handedness } from "../swing/frames";
import { type Mount, fitMount } from "../swing/mount";
import { type SwingAnalysis, analyzeSwing } from "../swing/pipeline";

export type RecorderStatus = "idle" | DetectState;

export interface Recorder {
    status: RecorderStatus;
    analysis: SwingAnalysis | null;
    error: string | null;
    /** Set when the swing just recorded was also the one that taught the mount. */
    learnedMount: Mount | null;
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
export function useSwingRecorder(
    clubId: string,
    hand: Handedness,
    resolveClub: (clubId: string) => Club,
    createSource: () => ImuSource,
    mount: Mount | null,
    onMount: (mount: Mount) => void,
): Recorder {
    const [status, setStatus] = useState<RecorderStatus>("idle");
    const [analysis, setAnalysis] = useState<SwingAnalysis | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [learnedMount, setLearnedMount] = useState<Mount | null>(null);

    const sourceRef = useRef<ImuSource | null>(null);
    const unsubscribeRef = useRef<(() => void) | null>(null);
    // Read inside the sample callback, so they must not go stale between renders.
    const clubRef = useRef(clubId);
    const handRef = useRef(hand);
    const resolveClubRef = useRef(resolveClub);
    const createSourceRef = useRef(createSource);
    const mountRef = useRef(mount);
    const onMountRef = useRef(onMount);
    clubRef.current = clubId;
    handRef.current = hand;
    resolveClubRef.current = resolveClub;
    createSourceRef.current = createSource;
    mountRef.current = mount;
    onMountRef.current = onMount;

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
        setLearnedMount(null);

        const detector = new SwingDetector(
            (capture) => {
                try {
                    // With no mount on file yet, this swing has to teach it before it
                    // can be read. Detection itself never needed one -- it works off
                    // rotation magnitudes, which do not care which way up the sensor
                    // is -- so the very first swing anyone makes is enough to bootstrap
                    // the whole thing.
                    let mount = mountRef.current;
                    if (!mount) {
                        const fit = fitMount(capture.samples, capture.still, handRef.current);
                        if (!fit.mount) {
                            setError(fit.warning);
                            stop();
                            return;
                        }
                        mount = fit.mount;
                        setLearnedMount(mount);
                        onMountRef.current(mount);
                    }

                    setAnalysis(
                        analyzeSwing(
                            capture,
                            resolveClubRef.current(clubRef.current),
                            handRef.current,
                            mount,
                        ),
                    );
                } catch (e) {
                    setError(e instanceof Error ? e.message : "Could not read that swing");
                }
                stop();
            },
            (next) => setStatus(next),
        );

        const source = createSourceRef.current();
        sourceRef.current = source;
        unsubscribeRef.current = source.onSamples((batch) => detector.push(batch));
        setStatus("settling");
        void source.start();
    }, [stop]);

    const clear = useCallback(() => {
        stop();
        setAnalysis(null);
        setError(null);
        setLearnedMount(null);
    }, [stop]);

    // Never leave a timer running behind a closed screen.
    useEffect(() => stop, [stop]);

    return { status, analysis, error, learnedMount, start, stop, clear };
}

export const STATUS_TEXT: Record<RecorderStatus, string> = {
    idle: "Ready when you are",
    settling: "Settle in over the ball",
    still: "Holding steady, swing when ready",
    candidate: "Something moved, checking",
    capturing: "Swing away",
};
