import type { Handedness } from "../../swing/frames";
import type { ImuSample, ImuSource } from "../types";
import { type SwingId, getSwing } from "./swings";

/** Samples per notification. Matches how a real BLE link would pack them. */
const BATCH = 8;
const BATCH_MS = (BATCH / 400) * 1000;

export interface MockOptions {
    swing: SwingId;
    clubId?: string;
    /** Which hand the mock swing is synthesized for. Defaults to right. */
    hand?: Handedness;
    /** Playback speed multiplier. 1 is real time. */
    speed?: number;
    /** Keep looping once the swing runs out. */
    loop?: boolean;
}

/**
 * Plays a canned swing back at a realistic rate, in batches, so the rest of the
 * app sees the same arrival pattern it will see over BLE. Swapping in a real
 * BMI270 source means implementing ImuSource and nothing else.
 */
export class MockImuSource implements ImuSource {
    readonly info = { name: "Mock BMI270", rateHz: 400 };

    private samples: ImuSample[] = [];
    private listeners = new Set<(batch: ImuSample[]) => void>();
    private cursor = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private tOffset = 0;

    constructor(private opts: MockOptions) {}

    async start(): Promise<void> {
        this.stop();
        this.samples = getSwing(this.opts.swing, this.opts.clubId, this.opts.hand).samples;
        this.cursor = 0;
        this.tOffset = 0;

        const period = BATCH_MS / (this.opts.speed ?? 1);
        this.timer = setInterval(() => this.tick(), period);
    }

    stop(): void {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    onSamples(cb: (batch: ImuSample[]) => void): () => void {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    private tick(): void {
        if (this.cursor >= this.samples.length) {
            if (!this.opts.loop) {
                this.stop();
                return;
            }
            // Timestamps have to keep climbing across a loop or the detector sees time
            // jump backwards.
            this.tOffset += this.samples[this.samples.length - 1].t + 1 / 400;
            this.cursor = 0;
        }

        const end = Math.min(this.cursor + BATCH, this.samples.length);
        const batch: ImuSample[] = [];
        for (let i = this.cursor; i < end; i++) {
            const s = this.samples[i];
            batch.push(this.tOffset === 0 ? s : { ...s, t: s.t + this.tOffset });
        }
        this.cursor = end;

        for (const cb of this.listeners) cb(batch);
    }
}
