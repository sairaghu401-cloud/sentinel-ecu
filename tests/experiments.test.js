import test from 'node:test';
import assert from 'node:assert/strict';
import { runValidation, scoreFrames } from '../src/experiments.js';

test('Confusion matrix handles positive/negative predictions and excludes unknown truth', () => {
  const frames = [
    { decision: 'BLOCK', label: 'attack' }, { decision: 'DROP', label: 'attack' },
    { decision: 'FORWARD', label: 'attack' }, { decision: 'BLOCK', label: 'normal' },
    { decision: 'FORWARD', label: 'normal' }, { decision: 'FORWARD', label: 'normal' },
    { decision: 'BLOCK', label: 'unknown' }, { decision: 'DROP' },
  ];
  assert.deepEqual(scoreFrames(frames), { tp: 1, fp: 1, tn: 2, fn: 2, precision: 1 / 2, recall: 1 / 3, falsePositiveRate: 1 / 3, labelledFrames: 6, unlabelled: 2 });
});

test('Queue drops remain availability loss, not successful detection', () => {
  const score = scoreFrames([{ decision: 'DROP', label: 'attack' }, { decision: 'DROP', label: 'normal' }]);
  assert.equal(score.tp, 0);
  assert.equal(score.fp, 0);
  assert.equal(score.fn, 1);
  assert.equal(score.tn, 1);
  assert.equal(score.recall, 0);
});

test('Empty denominators are null, never fabricated perfect detection', () => {
  assert.deepEqual(scoreFrames([]), { tp: 0, fp: 0, tn: 0, fn: 0, precision: null, recall: null, falsePositiveRate: null, labelledFrames: 0, unlabelled: 0 });
  const clean = scoreFrames([{ decision: 'FORWARD', label: 'normal' }]);
  assert.equal(clean.precision, null);
  assert.equal(clean.recall, null);
  assert.equal(clean.falsePositiveRate, 0);
  const attacks = scoreFrames([{ decision: 'BLOCK', label: 'attack' }]);
  assert.equal(attacks.falsePositiveRate, null);
});

test('Baseline predictor receives exactly the same labelled population', () => {
  const frames = [{ id: 0x120, decision: 'BLOCK', label: 'attack' }, { id: 0x777, decision: 'BLOCK', label: 'attack' }, { id: 0x120, decision: 'FORWARD', label: 'normal' }];
  const baseline = scoreFrames(frames, frame => frame.id !== 0x120);
  assert.equal(baseline.tp, 1);
  assert.equal(baseline.fn, 1);
  assert.equal(baseline.tn, 1);
  assert.equal(baseline.labelledFrames, scoreFrames(frames).labelledFrames);
});

test('Validation inputs enforce bounded deterministic workloads', () => {
  for (const seed of [-1, 2 ** 32, NaN, 1.1, '42']) assert.throws(() => runValidation({ seed }), /seed/);
  for (const durationMs of [0, 2999, 15001, Infinity, 6000.1, '6000']) assert.throws(() => runValidation({ durationMs }), /durationMs/);
});

test('Synthetic acceptance suite passes every behavioral check and uses honest metric populations', () => {
  const report = runValidation();
  const failures = report.cases.flatMap(item => item.checks.filter(check => !check.passed).map(check => `${item.name}: ${check.name} (${check.detail})`));
  assert.deepEqual(failures, []);
  assert.equal(report.datasetKind, 'synthetic');
  assert.equal(report.summary.passed, report.summary.total);
  assert.equal(report.summary.total, 12);
  assert.deepEqual([...new Set(report.cases.map(item => item.attack).filter(Boolean))].sort(), ['flooding', 'fuzzing', 'payload', 'replay', 'spoofing', 'stealth']);
  for (const item of report.cases) {
    assert.equal(item.passed, item.checks.every(check => check.passed));
    assert.equal(item.metrics.labelledFrames, item.baseline.labelledFrames);
    assert.equal(item.metrics.tp + item.metrics.fp + item.metrics.tn + item.metrics.fn, item.metrics.labelledFrames);
    assert.equal(item.baseline.tp + item.baseline.fp + item.baseline.tn + item.baseline.fn, item.baseline.labelledFrames);
  }
  const clean = report.cases.filter(item => item.attack === null && item.name.startsWith('Clean'));
  for (const item of clean) {
    assert.equal(item.metrics.recall, null);
    assert.equal(item.metrics.firstAttackAtMs, null);
    assert.equal(item.metrics.firstDetectionLatencyMs, null);
    assert.equal(item.metrics.safetyActivationLatencyMs, null);
  }
  for (const item of report.cases.filter(item => item.attack)) {
    assert.ok(item.metrics.firstAttackAtMs >= 0);
    assert.ok(Number.isFinite(item.metrics.firstDetectionLatencyMs));
    assert.ok(item.metrics.firstDetectionLatencyMs >= 0);
    assert.ok(item.metrics.safetyActivationLatencyMs === null || item.metrics.safetyActivationLatencyMs >= 0);
  }
  const flood = report.cases.find(item => item.attack === 'flooding');
  assert.ok(flood.metrics.attackDropped > 0);
  assert.ok(flood.metrics.recall < flood.metrics.inspectedAttackRecall);
  assert.ok(flood.metrics.fn >= flood.metrics.attackDropped);
  assert.equal(flood.metrics.inspectedAttackFrames, flood.metrics.tp + flood.metrics.fn - flood.metrics.attackDropped);
  assert.equal(flood.metrics.inspectedAttackRecall, flood.metrics.tp / flood.metrics.inspectedAttackFrames);
  const recovery = report.cases.find(item => item.name === 'Safety latch and explicit recovery');
  assert.equal(recovery.metrics.safetyState, 'NORMAL');
  assert.ok(recovery.metrics.safetyActivationLatencyMs > 0, 'Earlier safety activation survives explicit recovery reset.');
  assert.ok(report.limitations.some(note => note.includes('not real cross-dataset')));
  assert.ok(report.cases.some(item => item.name === 'Evaluator label isolation' && item.passed));
});

test('Long flood preserves true onset timing after frame retention overflows', () => {
  const report = runValidation({ seed: 0, durationMs: 15000 });
  const flood = report.cases.find(item => item.attack === 'flooding');
  assert.equal(report.summary.passed, report.summary.total);
  assert.ok(flood.metrics.received > flood.metrics.retainedFrames);
  assert.equal(flood.metrics.firstAttackAtMs, 5000);
  assert.ok(flood.metrics.firstDetectionLatencyMs > 0 && flood.metrics.firstDetectionLatencyMs < 10);
  assert.ok(flood.metrics.safetyActivationLatencyMs > 0 && flood.metrics.safetyActivationLatencyMs < 1000);
});

test('Minimum-duration workload still gives slow attacks a meaningful exposure', () => {
  const report = runValidation({ seed: 0xffffffff, durationMs: 3000 });
  assert.equal(report.summary.passed, report.summary.total);
  const stealth = report.cases.find(item => item.attack === 'stealth');
  assert.ok(stealth.metrics.recall >= 0.8);
  assert.equal(stealth.metrics.firstAttackAtMs, 500);
});
