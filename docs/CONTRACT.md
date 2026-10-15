# Implementation contract

This local software laboratory models the supplied Sentinel ECU concept. It has no physical CAN adapter or actuator connection. Node.js 22+ ESM, no runtime dependencies, browser-native frontend. Bind only to 127.0.0.1 by default.

## Engine module src/simulation.js

Exports `Simulation`, `SCENARIOS`, `SIGNALS`.

`new Simulation({seed:42, profile:'urban'})`; profile urban or highway. Fixed time steps with `advance(milliseconds)` (integer 1..10000); method itself advances simulated time, regardless of running flag. `setRunning(boolean)`, `setSpeed(number)` (0.5,1,2,5,10), `setAnalyst(boolean)`, `injectAttack({type,targetId,durationMs,intensity})`, `clearAttacks()`, `requestRecovery()`, `reset({seed,profile})`, `ingest(frame)` for imported trace. `snapshot()` returns object below. `report()` returns exportable complete summary with recent/bounded evidence. `getFrames()` returns retained frames, chronological. Simulation uses bounded buffers. Labelled ground truth is exclusively for metrics, never a detector input. Frame ingest input: `{timestampMs,id,data:[bytes],dlc?,label?:'normal'|'attack',attackType?}`; input validation must reject invalid frames. Imported timestamps are monotonic. Inject attack types spoofing,replay,flooding,fuzzing,payload,stealth. targetId numeric; optional default 0x120. durationMs 100..60000; intensity 1..5.

Snapshot fields (all always present):

```
{
  version:'1.0.0', seed:42, profile:'urban', running:false, speed:1, timeMs:0,
  status:'OBSERVE'|'WARN'|'FILTER'|'REQUEST_DEGRADE', risk:0..100,
  analyst:{connected:true,trained:true,trainingSamples:integer,description:string},
  safety:{state:'NORMAL'|'REQUESTED'|'DEGRADED',reason:string,requestedAtMs:null|number,activatedAtMs:null|number,recoveryEligible:boolean},
  metrics:{received:0,forwarded:0,blocked:0,dropped:0,alerts:0,busLoadPct:0,queueDepth:0,processingP50Us:0,processingP95Us:0,simulatedLatencyP95Us:0,tp:0,fp:0,tn:0,fn:0,precision:null|number,recall:null|number,falsePositiveRate:null|number},
  vehicle:{speedKph:0,rpm:0,brakePct:0,steeringDeg:0,batteryPct:0,motorEnabled:true},
  activeAttacks:[{type,targetId,endsAtMs}],
  frames:[{seq,timestampMs,id,dlc,data:[bytes],signal:string,decision:'FORWARD'|'BLOCK'|'DROP',reasons:[string],risk:number,anomalyScore:number,latencyUs:number,label:'normal'|'attack'|'unknown'}],
  events:[{id,timestampMs,severity:'info'|'warning'|'critical',title,detail}],
  series:[{timeMs,received,forwarded,blocked,risk,busLoadPct}],
  rules:[{key,name,enabled:true,description}],
  signals:[{id,name,periodMs,criticality}],
  sprt:{value,upperThreshold,lowerThreshold},
  limits:{frameCapacity,eventCapacity,seriesCapacity},
  model:{kind:string,description:string}
}
```

Snapshot frames/events newest first, series oldest first; getFrames chronological. Counters cumulative. Per-second series values are per-bucket counts, risk and load current. Host processing metrics are explicitly measured and not deterministic. Other behavior deterministic for same seed/commands. A gateway-local rule engine is independent of analyst state. Safety task acknowledges requests after modeled delay and latches until explicit eligible recovery. Rule failures can filter immediately; graded status reflects accumulated evidence, SPRT and criticality. Recovery only once attacks are cleared and a quiet interval passes. SCENARIOS array `{id,name,description}`; SIGNALS array `{id,name,periodMs,criticality}`.

## Dataset and validation modules

`src/datasets.js` exports `parseTrace(text,format)` returning `{frames,warnings,format}`, format 'csv' or 'candump'. CSV canonical header `timestamp_ms,id,data,label`; id is explicit hex `0x120` or decimal; data space separated hex, max 8 bytes; labels normal/attack optional, omitted unknown. Candump `(seconds) can0 120#000102` standard frames only. Max 20,000 rows, max 2MB, finite monotonic timestamps normalized to first row=0. Reject whole input on error with line-specific message. Blank lines/comments allowed. No CAN-FD or extended IDs support. No formulas executed. Export `framesToCsv(frames)` escapes cells.

`src/experiments.js` exports `runValidation({seed=42,durationMs=6000}={})`, returns `{createdAt,seed,datasetKind:'synthetic',summary:{passed,total},cases:[{name,profile,attack,passed,checks:[{name,passed,detail}],metrics,baseline:{tp,fp,tn,fn,precision,recall,falsePositiveRate},notes}],limitations:[...]}`. Cases cover clean urban/highway, each attack, analyst disconnected, safety latch/recovery, deterministic replay as practical. Duration bounded <=15000, seeded synthetic training distinct from validation, do not claim real cross-dataset results. Baseline ID whitelist only applied against the same frames. Integration adapter changes can be coordinated with engine agent.

## HTTP server API

GET `/api/health`: `{status:'ok',version:'1.0.0'}`
GET `/api/state`: snapshot plus `{sessionId, storage:{enabled,path}}`
GET `/api/catalog`: `{scenarios:SCENARIOS,signals:SIGNALS}`
GET `/api/events`: SSE named `state`, full snapshot every 250ms; browser can fall back to polling.
POST `/api/control`: `{action:'start'|'pause'|'step'|'reset'|'speed'|'analyst'|'clear-attacks'|'recover', milliseconds?:100,seed?:42,profile?:'urban',speed?:1,connected?:true}` => snapshot. Start runs interval advancing 50*speed ms every 50ms. Reset starts a new session and remains paused.
POST `/api/attack`: `{type,targetId:288,durationMs:5000,intensity:2}` => snapshot
POST `/api/validation`: `{seed?:42}` => validation result; browser show pending state.
POST `/api/import`: `{format:'csv'|'candump',text:'...'}` => `{summary, snapshot}`. Replay into fresh isolated engine, display imported run as current paused session; all rows synchronous, no normal traffic generation; analyst uses synthetic training and schema. Import is a declared synthetic schema comparison; arbitrary IDs will be unknown.
GET `/api/export?format=json|csv`: attachment report or retained frames. JSON includes provenance, limits and actual versus modeled metrics.
GET `/api/sessions`: `{sessions:[{id,createdAt,profile,seed,timeMs,received,blocked,status}]}` recent local snapshots persisted. POST `/api/sessions/load`: `{id}` restores a saved report for frontend review? OMIT for v1, sessions list is optional read-only history.

Errors JSON `{error:'clear message'}`, non-2xx. Body limits, no cross-origin control, explicit actions validation, safe static path routing, bounded SSE and queues. Server persistence in `data/`, atomic JSON summaries with bounded sessions. Graceful shutdown.

## UI contract

Vehicle workbench (see DESIGN.md): warm paper, olive structural elements, a dark vehicle schematic, amber actions and red blocks; Barlow typography, local Tabler components, compact evidence tables. Primary action Run simulation; initially paused clearly displayed. Tabs Overview, Traffic inspector, Validation, Guide. Show live ESP32 -> Bus A -> STM32 -> Bus B -> ECU with Pi side branch and independent safety task. User can run/pause/step/reset, select urban/highway and seed, choose/inject attack, toggle Pi offline, stop attacks, request eligible recovery, inspect filtered frames, run validation, import traces, export JSON/CSV. Labels describe simulation; never present modeled hardware metrics as measurements. Initial no traffic, disconnected server, validation busy/failure/success, analyst unavailable states all explicit. No external assets/fonts/network dependencies. Responsive targets 1440x900 and 390x844, keyboard focus, reduced motion, accessible controls. Frontend uses SSE or polls. Do not render untrusted strings as HTML.

