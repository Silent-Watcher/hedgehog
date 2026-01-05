import type { ILatencyTracker } from "./interfaces/ILatencyTracker";

export class LatencyTracker implements ILatencyTracker {
    private samples: number[] = [];
    private readonly maxSamples = 100;
    private currentP95: number = 150; // Our starting "smoothed" value
    private readonly alpha = 0.2;     // The smoothing weight
    private readonly minFloor = 25;   // Our safety floor

    add(ms: number) {
        if (this.samples.length >= this.maxSamples) {
            this.samples.shift();
        }
        this.samples.push(ms);

        // Every time we add a sample, we update our smoothed P95
        this.updateSmoothedP95();
    }

    private updateSmoothedP95() {

        if (this.samples.length < 5) return; // Wait for a tiny bit of data

        const rawP95 = this.calculateRawP95();

        // Cold Start / Seeding Phase
        if (this.samples.length < 20) {
            // Overwrite quickly to learn the environment
            this.currentP95 = rawP95;
        } else {
            // Apply the smoothing formula
            this.currentP95 = (this.currentP95 * (1 - this.alpha)) + (rawP95 * this.alpha);
        }
    }

    private calculateRawP95() {
        const sorted = [...this.samples].sort((a, b) => a - b);
        const index = Math.floor(sorted.length * 0.95) - 1;
        const newRawP95 = Number(sorted[Math.max(0, index)]);
        return newRawP95
    }

    getWaitTime(): number {
        //Never go below the floor
        return Math.max(this.minFloor, Math.round(this.currentP95));
    }
}