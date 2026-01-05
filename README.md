# hedge-fetch

**Adaptive, speculative request hedging for the modern web.** `hedgehog-fetch` is a high-performance wrapper around the Fetch API designed to eliminate "tail latency" (the slow P95/P99 requests). By intelligently firing a second "speculative" request when the first one takes too long, Hedgehog ensures your users never wait on a stray slow server.

## Key Features

* **Adaptive P95 Delay:** No hardcoded timeouts. Hedgehog learns your network's latency and hedges exactly when a request is statistically "late."
* **Idempotency Safety:** Automatically handles `Idempotency-Key` headers for `POST` requests to prevent duplicate server-side actions.
* **Zero Leakage:** Uses modern `AbortSignal.any()` to ensure that once a winner is found, the loser is aborted immediately—no dangling connections.
* **Plugin-Ready Buckets:** Ship with a local token bucket, or plug in **Redis** to coordinate hedging budgets across a global cluster.
* **Developer Visibility:** Built-in hooks and response decoration (`res.isHedged`) for deep observability.

---

## Installation

```bash
npm install hedge-fetch
```

## Quick Start

```typescript
import { HedgedContext, LocalTokenBucket, LatencyTracker } from 'hedge-fetch';

// 1. Initialize the context
const hedge = new HedgedContext(
  new LocalTokenBucket(10), // Allow 10% hedging overhead
  new LatencyTracker()      // Adaptive learning
);

// 2. Use it just like native fetch
const response = await hedge.fetch('https://api.example.com/data', {
  timeoutMs: 5000, // Global safety net
  onHedge: () => console.log('Hedging triggered!')
});

// 3. Check if the hedge saved the day
if ((response as any).isHedged) {
  console.log('Speculative request won!');
}

```

---

## Deep Dive: How it Works

### 1. The Adaptive Delay (P95 Algorithm)

Instead of guessing a timeout (e.g., "wait 200ms"), Hedgehog uses the `LatencyTracker`. It maintains a sliding window of recent request durations and calculates the **95th percentile**. If your primary request hasn't responded by the P95 mark, it is statistically likely to be a "tail latency" request, and Hedgehog fires the speculative request.

### 2. Idempotency & Safety

Hedging `POST` or `PATCH` requests is usually dangerous. Hedgehog makes it safe:

* **Safe Methods:** `GET`, `HEAD`, `OPTIONS` are hedged by default.
* **Unsafe Methods:** `POST` is only hedged if `forceHedge: true` is passed.
* **Auto-Key:** If enabled, Hedgehog generates a `UUID` and attaches it to the `Idempotency-Key` header, ensuring your backend doesn't process the same action twice.

### 3. Distributed Budgets (Redis)

To prevent your fleet of servers from DDOSing your own backend during a slowdown, Hedgehog uses a **Token Bucket**. You can implement the `IHedgeBucket` interface to sync this budget across multiple instances using Redis.

```typescript
class RedisBucket implements IHedgeBucket {
  async canHedge() {
    const tokens = await redis.get('hedge_tokens');
    return parseInt(tokens) > 0;
  }
  // ...
}

```

---

## Technical Reference

### `HedgeFetchOptions`

Extends the standard `RequestInit` with:

| Option | Type | Description |
| --- | --- | --- |
| `timeoutMs` | `number` | The global safety net. Aborts everything if no response in X ms. |
| `forceHedge` | `boolean` | Bypass safety checks for non-idempotent methods. |
| `onHedge` | `() => void` | Callback when the speculative request is fired. |
| `onPrimaryWin` | `(ms) => void` | Callback when the first request succeeds. |
| `onSpeculativeWin` | `(ms) => void` | Callback when the second request succeeds. |

### Response Decoration

Successful responses from a speculative request are decorated with a non-enumerable property:

```typescript
const res = await hedge.fetch(...);
console.log(res.isHedged); // true if the speculative request won

```

---

## Best Practices

1. **Backend Support:** Ensure your backend ignores duplicate `Idempotency-Key` headers for the best experience.
2. **Budgeting:** Start with a 5-10% budget (`LocalTokenBucket`) to improve latency without significantly increasing server cost.
3. **Global Timeouts:** Always set a `timeoutMs` to prevent "hanging" UI states in extreme network failure scenarios.

---


## Contributing

Contributions are welcome! If you have ideas for new resilience patterns (like Rate Limiting or Timeouts), feel free to open an issue or a PR.

---

## License

MIT © Ali nazari


**Built with ❤️ for the Node.js community.** *Star this repo if it helped you sleep better at night!* ⭐
