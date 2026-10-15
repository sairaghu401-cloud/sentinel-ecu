import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTrace, framesToCsv, TRACE_LIMITS } from '../src/datasets.js';
import { Simulation } from '../src/simulation.js';

test('CSV accepts explicit hexadecimal/decimal IDs, quoted cells, comments, BOM, zero length data and normalizes timestamps', () => {
  const input = '\uFEFF# fixture\r\n\r\ntimestamp_ms,id,data,label\r\n"4200.5","0x120","00 FF 10","normal"\r\n   # comment\r\n4200.5,288,,\r\n4201,0x7FF,01,attack\r\n';
  const result = parseTrace(input, 'csv');
  assert.equal(result.format, 'csv');
  assert.deepEqual(result.frames, [
    { timestampMs: 0, id: 288, data: [0, 255, 16], dlc: 3, label: 'normal' },
    { timestampMs: 0, id: 288, data: [], dlc: 0 },
    { timestampMs: 0.5, id: 2047, data: [1], dlc: 1, label: 'attack' },
  ]);
  assert.ok(result.warnings.some(warning => warning.includes('Unlabelled')));
});

test('CSV label column is optional and empty labels remain unavailable to metrics', () => {
  const result = parseTrace('timestamp_ms,id,data\n0,0x120,01 02\n10,288,03 04');
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[0].label, undefined);
});

test('CSV export round trips canonical frames with unknown labels', () => {
  const original = [{ timestampMs: 0, id: 0x120, data: [0, 254], label: 'normal' }, { timestampMs: 15.5, id: 0x7ff, data: [], label: 'unknown' }];
  const csv = framesToCsv(original);
  assert.equal(csv, 'timestamp_ms,id,data,label\r\n0,0x120,00 FE,normal\r\n15.5,0x7FF,,\r\n');
  const parsed = parseTrace(csv);
  assert.equal(parsed.frames[1].timestampMs, 15.5);
  assert.equal(parsed.frames[1].label, undefined);
});

test('CSV malformed syntax rejects the whole trace with source line', () => {
  for (const [row, message] of [
    ['0,0x120,"00,normal', /Line 2: Unterminated/],
    ['0,0x120,0"0,normal', /Line 2: Quote inside/],
    ['0,0x120,"00"junk,normal', /Line 2: Unexpected/],
    ['0,0x120,00,normal,extra', /Line 2: Expected 4/],
    ['0,0x120,00', /Line 2: Expected 4/],
    ['0,0x120,"00""11",normal', /Line 2: Data must/],
  ]) assert.throws(() => parseTrace(`timestamp_ms,id,data,label\n${row}`), message);
});

test('CSV validates timestamps, CAN fields and labels and forbids spreadsheet formulas', () => {
  for (const row of [
    'NaN,0x120,00,normal', 'Infinity,0x120,00,normal', '-1,0x120,00,normal', '1e309,0x120,00,normal',
    '0,120abc,00,normal', '0,0x800,00,normal', '0,1.5,00,normal', '0,0x1FFFFFFF,00,normal',
    '0,0x120,00 01 02 03 04 05 06 07 08,normal', '0,0x120,0G,normal', '0,0x120,0x12,normal',
    '0,0x120,00,unknown', '=1+1,0x120,00,normal', '0,=1+1,00,normal', '0,0x120,00,=HYPERLINK(1)',
  ]) assert.throws(() => parseTrace(`timestamp_ms,id,data,label\n${row}`), /Line 2:/, row);
  assert.throws(() => parseTrace('timestamp_ms,id,data,label\n10,0x120,00,normal\n9,0x120,00,attack'), /Line 3: Timestamps/);
});

test('CSV tracks physical line numbers across comments, blank lines, and multiline quotes', () => {
  assert.throws(() => parseTrace('# note\n\ntimestamp_ms,id,data,label\n0,0x120,"00\n01",normal\n5,0x800,00,attack'), /Line 6: Only standard/);
});

test('Candump accepts classical data frames and normalizes seconds to milliseconds', () => {
  const result = parseTrace('# capture\n(1000.125) can0 120#0001AB\n(1000.250) vcan0 7FF#\n', 'candump');
  assert.deepEqual(result.frames, [
    { timestampMs: 0, id: 0x120, data: [0, 1, 171], dlc: 3 },
    { timestampMs: 125, id: 0x7ff, data: [], dlc: 0 },
  ]);
});

test('Candump rejects FD, extended IDs, remote, malformed payloads and time regressions', () => {
  for (const row of ['(1) can0 120##100', '(1) can0 120#R', '(1) can0 800#00', '(1) can0 00000120#00', '(1) can0 120#0', '(1) can0 120#000102030405060708', '(NaN) can0 120#00', 'can0 120 [1] 00']) {
    assert.throws(() => parseTrace(row, 'candump'), /Line 1:/, row);
  }
  assert.throws(() => parseTrace('(2) can0 120#00\n(1) can0 120#00', 'candump'), /Line 2: Timestamps/);
});

test('Import bounds reject oversized bytes/rows and invalid or empty input', () => {
  assert.throws(() => parseTrace(' '.repeat(TRACE_LIMITS.maxBytes + 1)), /2 MiB/);
  assert.throws(() => parseTrace('timestamp_ms,id,data\n' + '0,0x120,00\n'.repeat(TRACE_LIMITS.maxRows + 1)), /20000 data rows/);
  assert.throws(() => parseTrace('(1) can0 120#00\n'.repeat(TRACE_LIMITS.maxRows + 1), 'candump'), /20000 data rows/);
  for (const input of ['', '# comment', 'timestamp_ms,id,data,label\n']) assert.throws(() => parseTrace(input), /no .*frames|no CSV header/);
  assert.throws(() => parseTrace(null), /must be text/);
  assert.throws(() => parseTrace('a\0b'), /NUL/);
  assert.throws(() => parseTrace('', 'xml'), /csv or candump/);
});

test('Exports reject untrusted values instead of emitting formulas', () => {
  for (const patch of [{ timestampMs: '=1+1' }, { id: '=1+1' }, { data: ['=1+1'] }, { label: '=1+1' }, { data: [256] }, { id: 0x800 }]) {
    assert.throws(() => framesToCsv([{ timestampMs: 0, id: 0x120, data: [0], label: 'normal', ...patch }]), /Frame 1:/);
  }
});

test('Bundled trace examples match the documented simulator schema', async () => {
  for (const name of ['normal.csv', 'attack.csv']) {
    const input = await readFile(new URL(`../examples/${name}`, import.meta.url), 'utf8');
    const { frames } = parseTrace(input);
    const sim = new Simulation({ seed: 42, profile: 'urban' });
    for (const frame of frames) sim.ingest(frame);
    sim.advance(500);
    const state = sim.snapshot();
    assert.equal(state.metrics.received, frames.length);
    assert.equal(state.metrics.fp, 0, `${name} normal fixture frames must be valid.`);
    if (name === 'normal.csv') assert.equal(state.metrics.forwarded, frames.length);
    else assert.equal(state.metrics.tp, 3);
  }
});
