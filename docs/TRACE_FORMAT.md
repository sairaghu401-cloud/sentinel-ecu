# Trace format

Import supports standard classical CAN frames only. The synthetic gateway schema is intentionally vehicle-specific; importing an unrelated real trace will not automatically infer its IDs, payloads or timing.

## CSV

The required header is `timestamp_ms,id,data` with an optional `label` column. No additional CSV columns are accepted. Labels are `normal`, `attack`, or empty/omitted. Quotes and escaped quotes follow CSV conventions. Blank lines and whole lines starting with `#` are ignored.

| Field | Representation |
|---|---|
| `timestamp_ms` | Finite nonnegative milliseconds, nondecreasing |
| `id` | Decimal integer or `0x`-prefixed hexadecimal, 0–2047 |
| `data` | Zero to eight hexadecimal bytes, separated by spaces |
| `label` | Evaluation ground truth only; never used by detection |

The parser derives DLC from the payload length. The engine checks the expected per-ID DLC independently. A malformed frame is rejected; a well-formed frame that violates a gateway rule can be evaluated and blocked.

## Candump

```text
(0.000000) can0 120#0001020304050607
(0.010000) can0 777#AABB
```

Timestamps are seconds and IDs/payloads are hexadecimal. Only the compact data-frame form is accepted; CAN FD (`##`), extended IDs, remote requests and error frames are rejected. Candump has no ground-truth labels, so accuracy metrics are unavailable for those frames.

## Import boundaries

The complete file must parse before any session is replaced. Inputs are limited to 2 MiB and 20,000 frame rows. Arrival times are normalized to start at zero while preserving relative gaps. Large gaps are skipped without generating synthetic normal traffic. Exported CSV preserves input fields and labels for a bounded recent frame window; JSON includes decisions, reasons, cumulative counts and provenance. A replayed exported window may not reproduce the original full-session decisions because earlier state and queued context may be absent.
