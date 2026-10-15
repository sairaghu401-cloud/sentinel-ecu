/** Trace interchange for classical, standard (11-bit) CAN frames only. */
export const TRACE_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxRows: 20_000 });

const DECIMAL = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function fail(line, message) {
  throw new Error(`Line ${line}: ${message}`);
}

function validateText(text) {
  if (typeof text !== 'string') throw new TypeError('Trace must be text.');
  if (new TextEncoder().encode(text).byteLength > TRACE_LIMITS.maxBytes) {
    throw new Error(`Trace exceeds the ${TRACE_LIMITS.maxBytes} byte (2 MiB) limit.`);
  }
  if (text.includes('\0')) throw new Error('Trace contains a NUL character.');
  return text.replace(/^\uFEFF/, '');
}

// RFC-style CSV state machine. Quoted cells may contain escaped quotes/newlines;
// bare quotes, stray suffixes and unterminated quotes reject the complete input.
function csvRecords(text) {
  const records = [];
  let cells = [], cell = '', state = 'start', line = 1, recordLine = 1;
  let touched = false;
  function endCell() { cells.push(cell); cell = ''; state = 'start'; }
  function endRecord() {
    endCell();
    if (touched || cells.some(value => value.trim())) records.push({ cells, line: recordLine });
    cells = []; touched = false;
    if (records.length > TRACE_LIMITS.maxRows + 1) fail(recordLine, `Trace exceeds ${TRACE_LIMITS.maxRows} data rows.`);
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    // Comments are whole lines only and are recognized outside CSV cells.
    if (!touched && cells.length === 0 && state === 'start' && cell.trim() === '') {
      let j = i;
      while (text[j] === ' ' || text[j] === '\t') j++;
      if (text[j] === '#') {
        while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
        if (text[i] === '\r' && text[i + 1] === '\n') i++;
        cell = ''; line++; recordLine = line;
        continue;
      }
    }
    const newline = ch === '\r' || ch === '\n';
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else state = 'closed';
      } else if (newline) {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        cell += '\n'; line++;
      } else cell += ch;
      continue;
    }
    if (newline) {
      endRecord();
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++; recordLine = line;
    } else if (ch === ',') {
      touched = true; endCell();
    } else if (state === 'closed') {
      fail(line, 'Unexpected character after a closing CSV quote.');
    } else if (ch === '"') {
      if (state !== 'start' || cell.length) fail(line, 'Quote inside an unquoted CSV cell.');
      touched = true; state = 'quoted';
    } else {
      cell += ch;
      if (ch !== ' ' && ch !== '\t') touched = true;
      state = 'plain';
    }
  }
  if (state === 'quoted') fail(recordLine, 'Unterminated quoted CSV cell.');
  if (touched || cells.length || cell.length) endRecord();
  return records;
}

function timestamp(value, line, multiplier = 1) {
  if (!DECIMAL.test(value)) fail(line, 'Timestamp must be a finite, nonnegative number.');
  const result = Number(value) * multiplier;
  if (!Number.isFinite(result) || result < 0) fail(line, 'Timestamp must be a finite, nonnegative number.');
  return result;
}

function identifier(value, line, hexOnly = false) {
  const valid = hexOnly ? /^[\da-f]+$/i.test(value) : /^(?:0x[\da-f]+|\d+)$/i.test(value);
  if (!valid) fail(line, 'ID must be decimal or explicit hexadecimal (for example 0x120).');
  const id = hexOnly ? Number.parseInt(value, 16) : Number(value);
  if (!Number.isInteger(id) || id < 0 || id > 0x7ff) fail(line, 'Only standard 11-bit CAN IDs (0x000–0x7FF) are supported.');
  return id;
}

function csvData(value, line) {
  if (!value) return [];
  const bytes = value.split(/\s+/);
  if (bytes.length > 8) fail(line, 'Classical CAN supports at most 8 data bytes.');
  if (bytes.some(byte => !/^[\da-f]{2}$/i.test(byte))) fail(line, 'Data must contain space-separated two-digit hexadecimal bytes.');
  return bytes.map(byte => Number.parseInt(byte, 16));
}

function finish(rows, format) {
  if (rows.length === 0) throw new Error('Trace contains no data frames.');
  let previous = -Infinity;
  const origin = rows[0].frame.timestampMs;
  const frames = rows.map(({ frame, line }) => {
    if (frame.timestampMs < previous) fail(line, 'Timestamps must be monotonic (nondecreasing).');
    previous = frame.timestampMs;
    return { ...frame, timestampMs: frame.timestampMs - origin };
  });
  const warnings = [];
  if (frames.some(frame => frame.label === undefined)) warnings.push('Unlabelled frames are excluded from classification metrics.');
  warnings.push('Trace replay uses the simulator signal schema and synthetic training; it is not real-vehicle validation.');
  return { frames, warnings, format };
}

function parseCsv(text) {
  const records = csvRecords(text);
  if (!records.length) throw new Error('Trace contains no CSV header or data frames.');
  const header = records.shift();
  const names = header.cells.map(cell => cell.trim());
  if (![3, 4].includes(names.length) || names.slice(0, 3).join(',') !== 'timestamp_ms,id,data' || (names.length === 4 && names[3] !== 'label')) {
    fail(header.line, 'Expected CSV header timestamp_ms,id,data,label (label column may be omitted).');
  }
  return finish(records.map(({ cells, line }) => {
    if (cells.length !== names.length) fail(line, `Expected ${names.length} CSV columns; found ${cells.length}.`);
    const [timeText, idText, dataText, labelText = ''] = cells.map(cell => cell.trim());
    if (labelText && !['normal', 'attack'].includes(labelText)) fail(line, 'Label must be normal, attack, or empty.');
    const data = csvData(dataText, line);
    const frame = { timestampMs: timestamp(timeText, line), id: identifier(idText, line), data, dlc: data.length };
    if (labelText) frame.label = labelText;
    return { frame, line };
  }), 'csv');
}

function parseCandump(text) {
  const rows = [];
  for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
    const value = raw.trim(), line = index + 1;
    if (!value || value.startsWith('#')) continue;
    const match = /^\(([^)]+)\)\s+[\w:.-]+\s+([\da-f]+)#([\da-f]*)$/i.exec(value);
    if (!match) fail(line, 'Expected classical candump: (seconds) can0 120#000102. CAN-FD and remote frames are unsupported.');
    const [, seconds, idText, payload] = match;
    if (idText.length > 3) fail(line, 'Extended-width candump IDs are unsupported; use standard 11-bit CAN frames.');
    if (payload.length % 2) fail(line, 'Candump payload must contain complete hexadecimal byte pairs.');
    if (payload.length > 16) fail(line, 'Classical CAN supports at most 8 data bytes.');
    const data = (payload.match(/../g) || []).map(byte => Number.parseInt(byte, 16));
    rows.push({ line, frame: { timestampMs: timestamp(seconds.trim(), line, 1000), id: identifier(idText, line, true), data, dlc: data.length } });
    if (rows.length > TRACE_LIMITS.maxRows) fail(line, `Trace exceeds ${TRACE_LIMITS.maxRows} data rows.`);
  }
  return finish(rows, 'candump');
}

export function parseTrace(text, format = 'csv') {
  if (!['csv', 'candump'].includes(format)) throw new Error('Trace format must be csv or candump.');
  const input = validateText(text);
  return format === 'csv' ? parseCsv(input) : parseCandump(input);
}

function csvCell(value) {
  const text = String(value);
  // Formula-sensitive values are escaped even if a future column is free text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Export only validated, canonical data; arbitrary strings cannot become formulas. */
export function framesToCsv(frames) {
  if (!Array.isArray(frames)) throw new TypeError('Frames must be an array.');
  const rows = ['timestamp_ms,id,data,label'];
  for (const [index, frame] of frames.entries()) {
    if (!frame || !Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) throw new Error(`Frame ${index + 1}: invalid timestamp.`);
    if (!Number.isInteger(frame.id) || frame.id < 0 || frame.id > 0x7ff) throw new Error(`Frame ${index + 1}: invalid standard CAN ID.`);
    if (!Array.isArray(frame.data) || frame.data.length > 8 || frame.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error(`Frame ${index + 1}: invalid CAN payload.`);
    if (frame.label != null && !['normal', 'attack', 'unknown'].includes(frame.label)) throw new Error(`Frame ${index + 1}: invalid label.`);
    const values = [frame.timestampMs, `0x${frame.id.toString(16).toUpperCase().padStart(3, '0')}`, frame.data.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '), frame.label === 'unknown' ? '' : (frame.label || '')];
    rows.push(values.map(csvCell).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
}
