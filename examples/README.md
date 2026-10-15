# Trace fixtures

These small files demonstrate the interchange format, not a real vehicle dataset.
The simulator's own signal payload schema and timing rules apply during replay.
`normal.csv` supplies valid brake frames at 20 ms intervals with increasing
sequence counters. `attack.csv` includes unknown-ID attacks.
`capture.log` uses classical candump and has no evaluator labels.

## CSV schema

```csv
timestamp_ms,id,data,label
0,0x120,00 00 D8 0E 00 00 00 00,normal
100,0x777,FF FF FF FF FF FF FF FF,attack
```

* `timestamp_ms`: finite nonnegative time in milliseconds. Times must be
  nondecreasing; the first time is normalized to zero during import.
* `id`: explicit hexadecimal (`0x120`) or decimal (`288`), from 0 through 2047.
* `data`: zero to eight two-digit hexadecimal bytes separated by spaces.
* `label`: `normal`, `attack`, or empty. Labels are exclusively evaluator ground
  truth and cannot influence detection. The complete label column may be omitted.

The CSV parser supports quoted cells and escaped quotes. Fields still must meet
their schema. Blank lines and whole lines starting with `#` are ignored. Imports
are limited to 2 MiB and 20,000 frames and fail entirely on a malformed row.
Standard 11-bit classical CAN is supported; CAN-FD, extended IDs and remote
request frames are rejected. Spreadsheet formulas are never executed or exported.

Candump syntax is `(seconds) can0 120#000102`. A candump file supplies no labels,
so classification precision/recall are unavailable for unlabelled frames.
