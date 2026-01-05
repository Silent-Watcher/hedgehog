import type { IHedgeBucket } from "./interfaces/IHedgeBucket";

class HedgeBucket implements IHedgeBucket {
    private tokens = 0;
    // Maximum "burst" allowed
    private readonly maxTokens = 10;
    private readonly hedgeCost = 1;
    // This allows hedging 5% of traffic
    private readonly gainPerRequest = 0.05;

    canHedge(): boolean {
        return this.tokens >= this.hedgeCost;
    }

    consumeHedge() {
        this.tokens -= this.hedgeCost;
    }

    inc() {
        this.tokens = Math.min(this.maxTokens, this.tokens + this.gainPerRequest);
    }
}

export const globalBucket = new HedgeBucket();