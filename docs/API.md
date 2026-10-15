# Local API

The base URL defaults to `http://127.0.0.1:8787`. All mutations require JSON objects with `Content-Type: application/json`. Browser calls must originate from the same address. Errors return a non-success status and `{ "error": "explanation" }`. Do not expose this single-user server directly on a network.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Version and readiness |
| GET | `/api/state` | Current snapshot, counters and recent evidence |
| GET | `/api/catalog` | Scenario and synthetic signal definitions |
| GET | `/api/events` | SSE stream with named `state` events |
| POST | `/api/control` | Start, pause, step, speed, reset, analyst, clear attacks, recover |
| POST | `/api/attack` | Schedule an attack in simulated time |
| POST | `/api/import` | Parse and evaluate a trace into a fresh paused session |
| GET | `/api/export?format=json` | Session report with provenance and retained evidence |
| GET | `/api/export?format=csv` | Retained frames as CSV |
| POST | `/api/validation` | Run synthetic experiments in a worker |
| GET | `/api/validation` | Validation activity and latest result |
| GET | `/api/sessions` | Metadata for up to 30 locally saved sessions |

Control examples:

Catalog scenarios include `intensities`, an array of `{level,label,description}` for levels 1–5. Active attacks include `intensity`, `strength` (the same descriptor), `startsAtMs` and `endsAtMs`. See `INTENSITY.md` for generator parameters and scope. Selecting a different level does not modify an already-injected attack.

Snapshots expose `analyst.processed` and `analyst.outliers` as cumulative session counters for completed, delayed payload observations. `analyst.lastObservation` is null or `{id,atMs,score,abnormal}`; `analyst.activeHolds` contains currently unexpired `{id,untilMs}` entries. Offline analysis stops processing and clears holds; session counters are retained until reset. Scores describe payload deviation, not flood detection.

`safety.requestCriteria` reports the current request gates: `elevatedRisk` (risk ≥ 65), `sustainedThreat` (unexpired sequential confirmation), and `criticalSignalEvidence` (brake, steering or powertrain evidence within 1200 modeled ms). These describe request eligibility, not recovery eligibility or overall network health. A latched degradation remains until explicit eligible recovery.

```json
{"action":"start"}
{"action":"pause"}
{"action":"step","milliseconds":100}
{"action":"speed","speed":2}
{"action":"reset","seed":42,"profile":"urban"}
{"action":"analyst","connected":false}
{"action":"clear-attacks"}
{"action":"recover"}
```

Each line above is a separate request object. Step accepts 1–10,000 simulated milliseconds and requires pause. Allowed speeds are 0.5, 1, 2, 5, and 10. Reset accepts a 32-bit unsigned seed and Urban or Highway profile, saves the previous session and leaves the new session paused. Recovery requires an eligible safety state. Imported sessions must be reset before starting, stepping, or injecting synthetic attacks.

An attack request:

```json
{"type":"payload","targetId":288,"durationMs":5000,"intensity":2}
```

Types are `spoofing`, `replay`, `flooding`, `fuzzing`, `payload`, and `stealth`. Duration is 100–60,000 milliseconds and intensity is 1–5. Use `/api/catalog` for valid target IDs. Attack duration advances only with simulated time.

Import request:

```json
{"format":"candump","text":"(1.000000) can0 777#AABB\n(1.010000) can0 777#CCDD"}
```

Imports are capped at 2 MiB and 20,000 rows. All frames are validated before the current session is replaced. The importer normalizes timestamps; the engine drains pending work for 500 simulated milliseconds after the final arrival. No synthetic normal frames are added. Unknown labels are excluded from confusion metrics. JSON export includes decisions, reasons and source/retention/timing caveats; CSV preserves input fields and evaluator labels for trace replay.

Validation request: `{"seed":42}`. A concurrent second validation receives HTTP 409. The UI remains usable while the worker evaluates the suite. SSE clients are bounded and slow clients are disconnected rather than growing an unbounded write buffer.
