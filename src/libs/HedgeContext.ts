import type { ResponseLabels } from "./hedgedFetch";
import type { IHedgeBucket } from "./interfaces/IHedgeBucket";
import type { IHedgeFetchOptions } from "./interfaces/IHedgeFetchOptions";
import type { LatencyTracker } from "./LatencyTracket";

export class HedgedContext {

    constructor(
        private bucket: IHedgeBucket,
        private tracker: LatencyTracker,
    ) {
    }

    // The logic to decide if a response is "Acceptable" or "Retryable"
    private async handleResponse(res: Response, label: ResponseLabels) {
        // 4xx errors are terminal (Client fault). Return them immediately.
        // 2xx are successes. Return them.
        if (res.ok || (res.status >= 400 && res.status < 500)) {
            return { res, label };
        }

        // 5xx errors are retryable. Throw so Promise.any ignores this result!
        throw new Error(`Retryable HTTP Error: ${res.status}`);
    }



    async fetch(url: string, init: IHedgeFetchOptions): Promise<Response> {

        const {
            onHedge, onPrimaryWin, onSpeculativeWin,
            signal: userSignal,
            forceHedge = false,
            autoIdempotency,
            timeoutMs,
            ...standardFetchOptions
        } = init


        if (userSignal && userSignal.aborted) throw userSignal.reason

        // Prepare Headers and Idempotency
        const method = (standardFetchOptions.method ?? 'GET').toUpperCase();

        const headers = new Headers(standardFetchOptions.headers);
        const isSafeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(method);

        if (method === 'POST' && (forceHedge || autoIdempotency)) {
            if (!headers.has('Idempotency-Key') && autoIdempotency) {
                headers.set('Idempotency-Key', crypto.randomUUID());
            }
        }

        const startTime = performance.now()

        // Setup Abort Controllers
        const primaryController = new AbortController();
        const speculativeController = new AbortController();
        const globalTimeoutController = new AbortController();

        const primarySignal = userSignal
            ? AbortSignal.any([
                userSignal,
                primaryController.signal,
                globalTimeoutController.signal
            ].filter(Boolean) as AbortSignal[])
            : primaryController.signal


        const speculativeSignal = userSignal
            ? AbortSignal.any([
                userSignal,
                speculativeController.signal,
                globalTimeoutController.signal
            ].filter(Boolean) as AbortSignal[])
            : speculativeController.signal


        const waitToHedgeMs = this.tracker.getWaitTime()
        let timerId: NodeJS.Timeout | null = null;
        let globalTimeoutId: NodeJS.Timeout | null = null;

        // A manual trigger to wake up the hedge immediately if Primary fails
        let forceImmediateHedge: (value?: any) => void
        const failFastSignal = new Promise((res) => {
            forceImmediateHedge = res;
        })


        if (timeoutMs) {
            globalTimeoutId = setTimeout(() => {
                globalTimeoutController.abort(`Request timed out after ${timeoutMs}ms`);
            }, timeoutMs);
        }

        const primaryLatencyStart = performance.now()
        // Start Primary
        const primaryRequest = fetch(url, { ...standardFetchOptions, headers, signal: primarySignal, })
            .then(async res => {
                // Headers arrived! Record latency immediately
                const primaryLatencyDuration = performance.now() - primaryLatencyStart;
                this.tracker.add(primaryLatencyDuration)

                return await this.handleResponse(res, 'primary')
            })
            .catch((error) => {
                // If primary fails (Network error OR 5xx), wake up the hedge!
                forceImmediateHedge?.()
                throw error;
            })


        // Prepare Speculative (Lazy Load)
        let speculativeRequest: Promise<{ res: Response, label: ResponseLabels }> | null = null;

        const canHedge = (isSafeMethod || forceHedge);

        if (canHedge) {
            speculativeRequest = Promise.race([
                // Wait for timer...
                new Promise(res => { timerId = setTimeout(res, waitToHedgeMs); }),
                // ...OR wait for primary to fail (Fail Fast)
                failFastSignal
            ]).then(async () => {

                // We only pay the "Plugin Latency" cost if we are actually going to hedge.
                const stillHasBudget = await this.bucket.canHedge()

                if (!stillHasBudget) {
                    // If the budget ran out while we were waiting, we just wait for Primary.
                    return new Promise(() => { })
                }

                const hedgeHeaders = new Headers(headers);
                hedgeHeaders.set('X-Hedge-Attempt', 'true')

                // Once we wake up, check budget again (double check) and pay
                console.log("Hedge triggered due to timeout or primary failure");
                onHedge?.() // Trigger the hook!
                this.bucket.consumeHedge();
                const res = await fetch(url, { ...standardFetchOptions, headers: hedgeHeaders, signal: speculativeSignal })
                return await this.handleResponse(res, 'speculative')
            })
        }

        try {

            // The Race
            // If we can't hedge, we just await primary. Otherwise, we race.
            const fastestResponse = await (speculativeRequest
                ? Promise.any([
                    primaryRequest,
                    speculativeRequest
                ])
                : primaryRequest
            )

            const totalDuration = performance.now() - startTime;

            // Cleanup Winner/Loser
            if (fastestResponse.label === 'primary') {
                if (fastestResponse.res.ok) this.bucket.inc(); // Only reward 200 OK
                speculativeController.abort();
                onPrimaryWin?.(totalDuration) // Hook 2: Primary won
            } else {
                Object.defineProperty(fastestResponse.res, 'isHedged', {
                    value: true,
                    writable: false,
                    enumerable: false // Keeps it "hidden" but accessible
                })
                primaryController.abort()
                onSpeculativeWin?.(totalDuration) // Hook 3: Hedge won!
            }

            return fastestResponse.res;

        } catch (error) {

            // Total Failure Cleanup
            primaryController.abort();
            speculativeController.abort();

            if (error instanceof AggregateError) {
                console.error("All attempts failed:", error.errors);
                throw new Error("Service Unavailable: Hedged request failed.");
            } else {
                console.error("An unexpected error occurred:", error);
            }

            throw error;

        } finally {
            if (timerId) clearTimeout(timerId);
            if (timeoutMs) clearTimeout(globalTimeoutId as NodeJS.Timeout)
        }
    }
}
