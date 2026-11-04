#!/usr/bin/env node
/**
 * tests/codec.test.mjs — tests for gorge-codec.js
 *
 * Plain `node:assert/strict` script (no test-runner dependency):
 *     node tests/codec.test.mjs
 *
 * The most important section walks the REAL reference corpus
 * (/Users/daxingyi/Music/DremuTest and /Users/daxingyi/Music/Chart, recursive)
 * and asserts serializeGorgeFile(parseGorgeFile(src)) === src byte for byte.
 * Nothing is skipped: every discovered `.g` file is tested.
 *
 * Exit code 0 = all tests pass, 1 = at least one failure.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GorgeCodecError,
  formatValue,
  parseGorgeFile,
  parseValue,
  serializeGorgeFile,
} from '../gorge-codec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

let checksPassed = 0;
let checksFailed = 0;
const failureDetails = [];

/**
 * Run one named check. Failures are recorded (not thrown) so a full report is printed.
 * @param {string} name
 * @param {() => void} fn
 */
function check(name, fn) {
  try {
    fn();
    checksPassed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    checksFailed += 1;
    failureDetails.push({ name, error });
    console.log(`FAIL  ${name}`);
    console.log(indent(String((error && error.stack) || error)));
  }
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join('\n');
}

/** First byte/character difference between two strings, with line + column info. */
function firstDifference(expected, actual) {
  const max = Math.max(expected.length, actual.length);
  let offset = 0;
  while (offset < max && expected[offset] === actual[offset]) offset += 1;

  const before = expected.slice(0, Math.min(offset, expected.length));
  const line = (before.match(/\n/g) || []).length + 1;
  const lastNewline = before.lastIndexOf('\n');
  const column = offset - lastNewline;

  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  return {
    offset,
    line,
    column,
    expectedLine: line - 1 < expectedLines.length ? expectedLines[line - 1] : '<end of file>',
    actualLine: line - 1 < actualLines.length ? actualLines[line - 1] : '<end of file>',
    expectedLength: expected.length,
    actualLength: actual.length,
  };
}

/* ------------------------------------------------------------------ */
/* corpus discovery                                                    */
/* ------------------------------------------------------------------ */

const CORPUS_ROOTS = [
  '/Users/daxingyi/Music/DremuTest',
  '/Users/daxingyi/Music/Chart',
];

/** Recursively collect every `.g` file below `dir` (deterministic order). */
function walkGorgeFiles(dir) {
  const found = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkGorgeFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.g')) found.push(full);
  }
  return found;
}

function discoverCorpus() {
  const files = [];
  const missingRoots = [];
  for (const root of CORPUS_ROOTS) {
    if (!fs.existsSync(root)) {
      missingRoots.push(root);
      continue;
    }
    files.push(...walkGorgeFiles(root));
  }
  files.sort();
  return { files, missingRoots };
}

function relativeToMusic(file) {
  const music = '/Users/daxingyi/Music';
  return file.startsWith(music + path.sep) ? file.slice(music.length + 1) : file;
}

/* ------------------------------------------------------------------ */
/* section 1: corpus byte-exact round-trip (the hard acceptance)        */
/* ------------------------------------------------------------------ */

const EXPECTED_CORPUS_FILES = 12;
const corpus = discoverCorpus();
let corpusPassed = 0;
let corpusFailed = 0;

if (corpus.missingRoots.length === CORPUS_ROOTS.length) {
  console.log('SKIP  reference corpus not found on this machine:');
  for (const root of corpus.missingRoots) console.log(`      missing ${root}`);
  console.log('      (set up the corpus or run the synthetic tests below)');
} else {
  console.log(`CORPUS  discovered ${corpus.files.length} .g file(s) under:`);
  for (const root of CORPUS_ROOTS) {
    console.log(`        ${root}${corpus.missingRoots.includes(root) ? '  [missing]' : ''}`);
  }
  console.log('');

  if (corpus.files.length < EXPECTED_CORPUS_FILES) {
    checksFailed += 1;
    failureDetails.push({
      name: 'corpus discovery',
      error: new Error(
        `expected at least ${EXPECTED_CORPUS_FILES} .g files, discovered ${corpus.files.length}`,
      ),
    });
    console.log(
      `FAIL  corpus discovery: expected >= ${EXPECTED_CORPUS_FILES} files, found ${corpus.files.length}`,
    );
  } else {
    checksPassed += 1;
    console.log(`PASS  corpus discovery (${corpus.files.length} files)`);
  }

  for (const file of corpus.files) {
    const label = relativeToMusic(file);
    let src;
    let srcBuffer;
    try {
      srcBuffer = fs.readFileSync(file);
      src = srcBuffer.toString('utf8');
    } catch (error) {
      corpusFailed += 1;
      console.log(`FAIL  ${label}`);
      console.log(indent(`could not read file: ${error.message}`));
      failureDetails.push({ name: label, error });
      continue;
    }

    const lineCount = src.split('\n').length - 1;
    const byteCount = srcBuffer.length;

    try {
      const staff = parseGorgeFile(src);
      const out = serializeGorgeFile(staff);
      // Byte-for-byte: compare the UTF-8 encodings, not just the JS strings.
      const outBuffer = Buffer.from(out, 'utf8');
      if (out === src && outBuffer.equals(srcBuffer)) {
        corpusPassed += 1;
        console.log(`PASS  ${label} (${lineCount} lines, ${byteCount} bytes)`);
        // Light structural sanity: the text round-tripped, now check the tree is sane.
        assert.equal(typeof staff.className, 'string');
        assert.ok(staff.className.length > 0);
        assert.ok(src.includes(`class ${staff.className}`));
        assert.ok(Array.isArray(staff.members) && staff.members.length > 0);
        const annotationLines = (src.match(/^ {4}@[A-Za-z][A-Za-z0-9_]*\s*$/gm) || []).length;
        assert.equal(staff.members.length, annotationLines, 'member count');
        for (const member of staff.members) {
          assert.ok(member.chartArray !== null || member.returnValue !== null);
        }
        const usingLines = (src.match(/^using [A-Za-z_][A-Za-z0-9_.]*;\s*$/gm) || []).length;
        assert.equal(staff.usings.length, usingLines, 'using count');
      } else {
        corpusFailed += 1;
        const diff = firstDifference(src, out);
        console.log(`FAIL  ${label}`);
        console.log(
          indent(
            [
              `first difference at line ${diff.line}, column ${diff.column}` +
                ` (char offset ${diff.offset}; expected ${diff.expectedLength} chars, got ${diff.actualLength};` +
                ` expected ${srcBuffer.length} bytes, got ${outBuffer.length} bytes)`,
              `expected line: ${JSON.stringify(diff.expectedLine)}`,
              `actual line  : ${JSON.stringify(diff.actualLine)}`,
            ].join('\n'),
          ),
        );
        failureDetails.push({
          name: label,
          error: new Error(
            `byte mismatch at line ${diff.line}, column ${diff.column}: ` +
              `expected ${JSON.stringify(diff.expectedLine)} got ${JSON.stringify(diff.actualLine)}`,
          ),
        });
      }
    } catch (error) {
      corpusFailed += 1;
      console.log(`FAIL  ${label}`);
      console.log(indent(String((error && error.stack) || error)));
      failureDetails.push({ name: label, error });
    }
  }

  console.log('');
  console.log(
    `CORPUS SUMMARY  ${corpusPassed}/${corpus.files.length} files byte-exact` +
      (corpusFailed > 0 ? `, ${corpusFailed} FAILED` : ''),
  );
  console.log('');
}

if (corpusFailed > 0) checksFailed += corpusFailed;

/* ------------------------------------------------------------------ */
/* helpers for the semantic / mutation tests                           */
/* ------------------------------------------------------------------ */

/** Find a corpus file by relative path, or null when the corpus is absent. */
function corpusFile(...segments) {
  const file = path.join('/Users/daxingyi/Music', ...segments);
  return fs.existsSync(file) ? file : null;
}

const SAMPLE_DREMUTEST = corpusFile('DremuTest', 'DremuStaff.g');
const SAMPLE_CHART2 = corpusFile('Chart', 'Chart 2', 'DremuStaff.g');

/** Synthetic fallback sample (LF) used only when the reference corpus is unavailable. */
const SYNTHETIC_SAMPLE = `[
    string form = "Dremu",
    string displayName = "Synthetic"
]
@ElementStaff
class SyntheticStaff
{
    [
        PeriodConfig^ config = PeriodConfig : {
            timeOffset : 0.0,
        }
    ]
    @Chart
    static Element^[] Period()
    {
        return new Element^[2]{
            DremuTap : {
                laneName : "mainLine01",
                hitTime : 2.842105,
            },
            DremuTap : {
                laneName : "mainLine01",
                hitTime : 7.31579,
            },
        };
    }


}
`;

const SAMPLE_SRC = SAMPLE_CHART2 ? fs.readFileSync(SAMPLE_CHART2, 'utf8') : SYNTHETIC_SAMPLE;
const SAMPLE_TEXT_IS_CRLF = SAMPLE_SRC.includes('\r\n');

function elementItems(staff) {
  const out = [];
  for (const member of staff.members) {
    if (member.chartArray) out.push(...member.chartArray.items);
  }
  return out;
}

/** Depth-first search over a Value tree; returns the first match or null. */
function findValue(value, predicate) {
  if (predicate(value)) return value;
  if (value && typeof value === 'object') {
    if (value.t === 'obj') {
      for (const key of Object.keys(value.fields)) {
        const hit = findValue(value.fields[key], predicate);
        if (hit !== null) return hit;
      }
    } else if (value.t === 'arr') {
      for (const item of value.items) {
        const hit = findValue(item, predicate);
        if (hit !== null) return hit;
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* section 2: type-shape / empty-literal tests                          */
/* ------------------------------------------------------------------ */

check('empty typed object serializes as { : } and round-trips', () => {
  const text = 'GorgeFramework.ConstantFunctionCurve : { : }';
  const value = parseValue(text);
  assert.deepEqual(value, { t: 'obj', type: 'GorgeFramework.ConstantFunctionCurve', fields: {} });
  assert.equal(formatValue(value), text);
});

check('empty typed object as an object field', () => {
  const text = 'distance : GorgeFramework.ConstantFunctionCurve : { : },';
  const value = parseValue('X : {\n    distance : GorgeFramework.ConstantFunctionCurve : { : },\n}');
  assert.deepEqual(value.fields.distance, {
    t: 'obj',
    type: 'GorgeFramework.ConstantFunctionCurve',
    fields: {},
  });
  assert.equal(
    formatValue(value),
    'X : {\n    distance : GorgeFramework.ConstantFunctionCurve : { : },\n}',
  );
  assert.ok(text.length > 0);
});

check('empty typed list serializes as { , } and round-trips', () => {
  const value = { t: 'arr', type: 'FunctionPiece', items: [] };
  assert.equal(formatValue(value), 'FunctionPiece^ : { , }');
  assert.deepEqual(parseValue('FunctionPiece^ : { , }'), value);
});

check('typed list with scalar / null / ref items round-trips', () => {
  const text = [
    'Values^ : {',
    '    1.0,',
    '    2.5,',
    '    "text",',
    '    true,',
    '    null,',
    '    Some.Namespace.EnumValue,',
    '}',
  ].join('\n');
  const value = parseValue(text);
  assert.equal(value.t, 'arr');
  assert.equal(value.type, 'Values');
  assert.deepEqual(value.items, [1, 2.5, 'text', true, null, { t: 'ref', path: 'Some.Namespace.EnumValue' }]);
  assert.equal(formatValue(value), text);
});

check('null item inside a typed list (DremuStaff2.g form)', () => {
  const text = 'laneLines : GorgeFramework.FunctionCurve^ : {';
  assert.ok(text.length > 0);
  const value = parseValue('X : {\n    laneLines : GorgeFramework.FunctionCurve^ : {\n        null,\n    },\n}');
  assert.deepEqual(value.fields.laneLines, {
    t: 'arr',
    type: 'GorgeFramework.FunctionCurve',
    items: [null],
  });
  assert.equal(
    formatValue(value),
    'X : {\n    laneLines : GorgeFramework.FunctionCurve^ : {\n        null,\n    },\n}',
  );
});

check('enum reference value', () => {
  const text = 'DeentyStoryboard.ImagePositionMode.ScreenCover';
  assert.deepEqual(parseValue(text), { t: 'ref', path: text });
  assert.equal(formatValue({ t: 'ref', path: text }), text);
});

/* ------------------------------------------------------------------ */
/* section 3: number formatting / expressions                          */
/* ------------------------------------------------------------------ */

check('canonical number formatting', () => {
  assert.equal(formatValue(10), '10.0');
  assert.equal(formatValue(0), '0.0');
  assert.equal(formatValue(-10), '-10.0');
  assert.equal(formatValue(180), '180.0');
  assert.equal(formatValue(2.842105), '2.842105');
  assert.equal(formatValue(0.0196078), '0.0196078');
  assert.equal(formatValue(-0.5), '-0.5');
  assert.equal(formatValue(-0.0), '-0.0');
  assert.equal(formatValue(0.000001), '0.000001');
  // No exponent notation in canonical output.
  assert.equal(/[eE]/.test(formatValue(1e-7)), false, 'small values expand');
  assert.equal(formatValue(1e-7), '0.0000001');
  assert.equal(/[eE]/.test(formatValue(1e21)), false, 'large integers expand');
});

check('±Infinity / NaN are written as division expressions', () => {
  assert.equal(formatValue(Infinity), '(1.0/0.0)');
  assert.equal(formatValue(-Infinity), '(-1.0/0.0)');
  assert.equal(formatValue(NaN), '(0.0/0.0)');
});

check('expr value keeps src verbatim and derives from special', () => {
  const negInf = parseValue('(-1.0/0.0)');
  assert.deepEqual(negInf, { t: 'expr', src: '(-1.0/0.0)', special: '-Infinity' });
  assert.equal(formatValue(negInf), '(-1.0/0.0)');

  const posInf = parseValue('(1.0/0.0)');
  assert.deepEqual(posInf, { t: 'expr', src: '(1.0/0.0)', special: 'Infinity' });
  assert.equal(formatValue(posInf), '(1.0/0.0)');

  const nan = parseValue('(0.0/0.0)');
  assert.equal(nan.special, 'NaN');
  assert.equal(formatValue(nan), '(0.0/0.0)');

  // Derivable without src (computed values from the editor).
  assert.equal(formatValue({ t: 'expr', special: 'Infinity' }), '(1.0/0.0)');
  assert.equal(formatValue({ t: 'expr', special: '-Infinity' }), '(-1.0/0.0)');
  assert.equal(formatValue({ t: 'expr', special: 'NaN' }), '(0.0/0.0)');
  assert.equal(formatValue({ t: 'expr', src: '(3.0/2.0)', special: 1.5 }), '(3.0/2.0)');
});

check('bare integer value parses to a number', () => {
  assert.equal(parseValue('200'), 200);
  assert.equal(parseValue('-4'), -4);
  assert.equal(parseValue('200.0'), 200);
  assert.equal(formatValue(200), '200.0');
});

/* ------------------------------------------------------------------ */
/* section 4: int-typed fields (pointCount) and unknown int fields      */
/* ------------------------------------------------------------------ */

check('int-typed pointCount field is written bare, not as 200.0', () => {
  const value = { t: 'obj', type: 'Anything', fields: { pointCount: 200 } };
  assert.equal(formatValue(value), 'Anything : {\n    pointCount : 200,\n}');
  const reparsed = parseValue('Anything : {\n    pointCount : 200,\n}');
  assert.equal(reparsed.fields.pointCount, 200);
  assert.equal(formatValue(reparsed), 'Anything : {\n    pointCount : 200,\n}');
});

check('unknown int-typed fields round-trip via intFields metadata', () => {
  const text = 'Weird : {\n    someCount : 7,\n    value : 7.0,\n}';
  const value = parseValue(text);
  assert.equal(value.fields.someCount, 7);
  assert.equal(value.fields.value, 7);
  assert.deepEqual(value.intFields, ['someCount']);
  assert.equal(formatValue(value), text);
});

check('corpus keeps pointCount bare (DremuStaff1.g)', () => {
  const file = corpusFile('DremuTest', 'DremuStaff1.g');
  if (file === null) {
    console.log('      (corpus missing — skipping real-file assertion)');
    return;
  }
  const src = fs.readFileSync(file, 'utf8');
  const staff = parseGorgeFile(src);
  const pointCountValue = findValue({ t: 'arr', type: 'root', items: elementItems(staff) }, (v) => v && v.t === 'obj' && Object.prototype.hasOwnProperty.call(v.fields, 'pointCount'));
  assert.ok(pointCountValue !== null, 'pointCount object found');
  assert.equal(pointCountValue.fields.pointCount, 200);
  assert.equal(typeof pointCountValue.fields.pointCount, 'number');
  assert.ok(src.includes('pointCount : 200,'), 'corpus uses bare integer');
  const out = serializeGorgeFile(staff);
  assert.ok(out.includes('pointCount : 200,'), 'serializer keeps bare integer');
  assert.equal(out.includes('pointCount : 200.0,'), false);
});

/* ------------------------------------------------------------------ */
/* section 5: file-level EOL + layout handling                         */
/* ------------------------------------------------------------------ */

check('CRLF files are detected and preserved', () => {
  const lfText = SYNTHETIC_SAMPLE;
  const crlfText = lfText.replace(/\n/g, '\r\n');
  const staff = parseGorgeFile(crlfText);
  assert.equal(staff.eol, '\r\n');
  assert.equal(serializeGorgeFile(staff), crlfText);
  assert.equal(serializeGorgeFile(parseGorgeFile(lfText)), lfText);
});

check('real corpus EOL styles are preserved', () => {
  const crlfFile = corpusFile('DremuTest', 'DremuStaff.g');
  const lfFile = corpusFile('Chart', 'Chart 2', 'DremuStaff.g');
  if (crlfFile === null || lfFile === null) {
    console.log('      (corpus missing — skipping)');
    return;
  }
  const crlfSrc = fs.readFileSync(crlfFile, 'utf8');
  const lfSrc = fs.readFileSync(lfFile, 'utf8');
  assert.ok(crlfSrc.includes('\r\n'));
  assert.equal(crlfSrc.replace(/\r\n/g, '\n').includes('\r'), false);
  const crlfStaff = parseGorgeFile(crlfSrc);
  assert.equal(crlfStaff.eol, '\r\n');
  const out = serializeGorgeFile(crlfStaff);
  assert.equal(out, crlfSrc);
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false, 'every LF is part of CRLF');

  assert.equal(lfSrc.includes('\r'), false);
  const lfStaff = parseGorgeFile(lfSrc);
  assert.equal(lfStaff.eol, '\n');
  assert.equal(serializeGorgeFile(lfStaff), lfSrc);
});

check('blank lines after using block are preserved (1 vs 2)', () => {
  const oneBlank = corpusFile('Chart', 'Chart 4', 'DeentyStoryboardStaff1.g');
  const twoBlanks = corpusFile('Chart', 'Chart 4', 'AudioStaff.g');
  if (oneBlank === null || twoBlanks === null) {
    console.log('      (corpus missing — skipping)');
    return;
  }
  const oneStaff = parseGorgeFile(fs.readFileSync(oneBlank, 'utf8'));
  const twoStaff = parseGorgeFile(fs.readFileSync(twoBlanks, 'utf8'));
  assert.deepEqual(oneStaff.usings, ['Gorge', 'GorgeFramework', 'Dremu']);
  assert.equal(oneStaff.blankAfterUsings, 1);
  assert.equal(twoStaff.blankAfterUsings, 2);
  assert.match(
    fs.readFileSync(oneBlank, 'utf8'),
    /^using Gorge;\nusing GorgeFramework;\nusing Dremu;\n\n\[/,
  );
  assert.match(
    fs.readFileSync(twoBlanks, 'utf8'),
    /^using Gorge;\nusing GorgeFramework;\nusing Dremu;\n\n\n\[/,
  );
});

check('header block without form field round-trips', () => {
  const text = ['[', '    string displayName = "音频谱表"', ']', '@AudioStaff', 'class A', '{', '}'].join('\n') + '\n';
  const staff = parseGorgeFile(text);
  assert.deepEqual(staff.header, [{ type: 'string', name: 'displayName', value: '音频谱表' }]);
  assert.equal(serializeGorgeFile(staff), text);
});

check('file without header/using block parses and re-serializes', () => {
  const text = ['@ElementStaff', 'class Bare', '{', '}'].join('\n') + '\n';
  const staff = parseGorgeFile(text);
  assert.equal(staff.header, null);
  assert.deepEqual(staff.usings, []);
  assert.deepEqual(staff.members, []);
  assert.equal(serializeGorgeFile(staff), text);
});

check('empty chart array (Chart.g quirk: new Element^[0]{ , };)', () => {
  const file = corpusFile('Chart', 'Chart', 'Chart.g');
  if (file === null) {
    console.log('      (corpus missing — skipping)');
    return;
  }
  const src = fs.readFileSync(file, 'utf8');
  const staff = parseGorgeFile(src);
  assert.equal(staff.className, 'Chart');
  assert.deepEqual(staff.annotations, ['ElementStaff']);
  assert.equal(staff.members.length, 1);
  const member = staff.members[0];
  assert.equal(member.name, 'GetChart');
  assert.deepEqual(member.chartArray, { elemType: 'Element', items: [] });
  assert.ok(src.includes('return new Element^[0]{ , };'));
  assert.equal(serializeGorgeFile(staff), src);
});

check('audio staff return value is a typed object (Song.g form)', () => {
  const file = corpusFile('DremuTest', 'Song.g');
  if (file === null) {
    console.log('      (corpus missing — skipping)');
    return;
  }
  const staff = parseGorgeFile(fs.readFileSync(file, 'utf8'));
  const member = staff.members[0];
  assert.equal(member.annotation, 'Song');
  assert.equal(member.retType, 'GorgeFramework.AudioAsset^');
  assert.equal(member.chartArray, null);
  assert.equal(member.returnValue.t, 'obj');
  assert.equal(member.returnValue.type, 'GorgeFramework.WavAudioAsset');
  assert.equal(member.returnValue.fields.wavFilePath, 'Song.wav');
});

check('header fields and attr block types are preserved verbatim', () => {
  const file = SAMPLE_DREMUTEST;
  if (file === null) {
    console.log('      (corpus missing — skipping)');
    return;
  }
  const staff = parseGorgeFile(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(staff.header, [
    { type: 'string', name: 'form', value: 'Dremu' },
    { type: 'string', name: 'displayName', value: '表演' },
  ]);
  assert.equal(staff.members[0].retType, 'GorgeFramework.Element^[]');
  assert.equal(staff.members[0].attr[0].type, 'GorgeFramework.PeriodConfig^');
  assert.equal(staff.members[0].attr[0].name, 'config');
  assert.equal(staff.members[0].attr[0].value.t, 'obj');
  assert.equal(staff.members[0].attr[0].value.type, 'GorgeFramework.PeriodConfig');
});

/* ------------------------------------------------------------------ */
/* section 6: mutation tests (edit → serialize → re-parse)              */
/* ------------------------------------------------------------------ */

check('mutate element fields survive serialize → re-parse', () => {
  const text = SAMPLE_SRC;
  const staff = parseGorgeFile(text);
  const member = staff.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
  assert.ok(member, 'sample has a chart member');
  const element = member.chartArray.items.find((item) => item && item.t === 'obj');
  assert.ok(element, 'sample has an object element');

  // 1. string field
  element.fields.laneName = 'mutatedLane';
  // 2. number field
  element.fields.hitTime = 3.5;
  // 3. nested typed object field
  element.fields.position = { t: 'obj', type: 'VariableFloat', fields: { baseValue: 1.0 } };
  // 4. removed field
  delete element.fields.leadTime;

  const out = serializeGorgeFile(staff);
  assert.ok(out.includes('laneName : "mutatedLane",'));
  assert.ok(out.includes('hitTime : 3.5,'));
  assert.ok(out.includes('position : VariableFloat : {\n'));
  assert.equal(out.includes('leadTime'), false);
  // EOL style preserved.
  assert.equal(out.includes('\r\n'), SAMPLE_TEXT_IS_CRLF);

  const reparsed = parseGorgeFile(out);
  const member2 = reparsed.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
  const element2 = member2.chartArray.items.find((item) => item && item.t === 'obj');
  assert.equal(element2.fields.laneName, 'mutatedLane');
  assert.equal(element2.fields.hitTime, 3.5);
  assert.deepEqual(element2.fields.position, {
    t: 'obj',
    type: 'VariableFloat',
    fields: { baseValue: 1.0 },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(element2.fields, 'leadTime'), false);
  // Serializer output is now canonical: re-serializing the reparsed file is stable.
  assert.equal(serializeGorgeFile(reparsed), out);
});

check('add an array item (declared size follows the item count)', () => {
  const text = SAMPLE_SRC;
  const staff = parseGorgeFile(text);
  const member = staff.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
  const before = member.chartArray.items.length;

  member.chartArray.items.push({
    t: 'obj',
    type: 'DremuTap',
    fields: { laneName: 'mainLine01', hitTime: 1.25 },
  });
  const out = serializeGorgeFile(staff);
  assert.ok(out.includes(`new ${member.chartArray.elemType}^[${before + 1}]{`));
  assert.ok(
    out.includes(['            DremuTap : {', '                laneName : "mainLine01",', '                hitTime : 1.25,', '            },'].join('\n')),
    'new element block is formatted canonically',
  );

  const reparsed = parseGorgeFile(out);
  const member2 = reparsed.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
  assert.equal(member2.chartArray.items.length, before + 1);
  const last = member2.chartArray.items[member2.chartArray.items.length - 1];
  assert.equal(last.type, 'DremuTap');
  assert.deepEqual(last.fields, { laneName: 'mainLine01', hitTime: 1.25 });
});

check('remove an array item restores the original bytes', () => {
  const text = SAMPLE_SRC;
  const staff = parseGorgeFile(text);
  const member = staff.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
  const original = member.chartArray.items[0];
  const out = serializeGorgeFile(staff);
  assert.ok(out.includes(`^[${member.chartArray.items.length}]{`));

  // Fresh parse, remove the item, and the file should be back to the source text
  // (the corpus source had exactly those items).
  const fresh = parseGorgeFile(text);
  const freshMember = fresh.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
  freshMember.chartArray.items.shift();
  assert.equal(serializeGorgeFile(fresh) === text, false, 'removal changes the text');
  // Put it back → byte-exact again.
  freshMember.chartArray.items.unshift(original);
  assert.equal(serializeGorgeFile(fresh), text);
});

check('format a brand-new element from scratch', () => {
  const freshStaff = parseGorgeFile(SAMPLE_SRC);
  const member = freshStaff.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
 member.chartArray.items.push({
    t: 'obj',
    type: 'Dremu.DremuHold',
    fields: {
      laneName: 'mainLine01',
      hitTime: 4.0,
      holdTime: 2.0,
      innerNotes: {
        t: 'arr',
        type: 'Dremu.DremuHoldInnerNote',
        items: [{ t: 'obj', type: 'Dremu.DremuHoldInnerNote', fields: { hitTime: 0.5 } }],
      },
    },
  });
  const out = serializeGorgeFile(freshStaff);
  const expected = [
    '            Dremu.DremuHold : {',
    '                laneName : "mainLine01",',
    '                hitTime : 4.0,',
    '                holdTime : 2.0,',
    '                innerNotes : Dremu.DremuHoldInnerNote^ : {',
    '                    Dremu.DremuHoldInnerNote : {',
    '                        hitTime : 0.5,',
    '                    },',
    '                },',
    '            },',
  ].join('\n');
  assert.ok(out.includes(expected), `expected block in output:\n${expected}`);

  const reparsed = parseGorgeFile(out);
  const member2 = reparsed.members.find((m) => m.chartArray && m.chartArray.items.length > 0);
  const created = member2.chartArray.items[member2.chartArray.items.length - 1];
  assert.equal(created.type, 'Dremu.DremuHold');
  assert.deepEqual(created.fields, {
    laneName: 'mainLine01',
    hitTime: 4,
    holdTime: 2,
    innerNotes: {
      t: 'arr',
      type: 'Dremu.DremuHoldInnerNote',
      items: [{ t: 'obj', type: 'Dremu.DremuHoldInnerNote', fields: { hitTime: 0.5 } }],
    },
  });
});

check('build a StaffFile from scratch (header + attr + chart member)', () => {
  const staff = {
    usings: ['Gorge', 'GorgeFramework', 'Dremu'],
    blankAfterUsings: 1,
    header: [{ type: 'string', name: 'form', value: 'Dremu' }],
    className: 'NewStaff',
    annotations: ['ElementStaff'],
    members: [],
  };
  const emptyText = serializeGorgeFile(staff);
  assert.equal(
    emptyText,
    [
      'using Gorge;',
      'using GorgeFramework;',
      'using Dremu;',
      '',
      '[',
      '    string form = "Dremu"',
      ']',
      '@ElementStaff',
      'class NewStaff',
      '{',
      '}',
      '',
    ].join('\n'),
  );

  const reparsedEmpty = parseGorgeFile(emptyText);
  assert.deepEqual(reparsedEmpty.usings, staff.usings);
  assert.deepEqual(reparsedEmpty.header, staff.header);
  assert.deepEqual(reparsedEmpty.members, []);
  assert.equal(reparsedEmpty.blankAfterUsings, 1);

  staff.members.push({
    attr: [
      {
        type: 'PeriodConfig^',
        name: 'config',
        value: { t: 'obj', type: 'PeriodConfig', fields: { timeOffset: 0 } },
      },
    ],
    annotation: 'Chart',
    retType: 'Element^[]',
    name: 'Period',
    chartArray: {
      elemType: 'Element',
      items: [{ t: 'obj', type: 'DremuTap', fields: { laneName: 'L', hitTime: 2.5 } }],
    },
    returnValue: null,
  });
  const text = serializeGorgeFile(staff);
  const expected = [
    'using Gorge;',
    'using GorgeFramework;',
    'using Dremu;',
    '',
    '[',
    '    string form = "Dremu"',
    ']',
    '@ElementStaff',
    'class NewStaff',
    '{',
    '    [',
    '        PeriodConfig^ config = PeriodConfig : {',
    '            timeOffset : 0.0,',
    '        }',
    '    ]',
    '    @Chart',
    '    static Element^[] Period()',
    '    {',
    '        return new Element^[1]{',
    '            DremuTap : {',
    '                laneName : "L",',
    '                hitTime : 2.5,',
    '            },',
    '        };',
    '    }',
    '',
    '',
    '}',
    '',
  ].join('\n');
  assert.equal(text, expected);

  const reparsed = parseGorgeFile(text);
  assert.equal(reparsed.members.length, 1);
  const member = reparsed.members[0];
  assert.equal(member.name, 'Period');
  assert.equal(member.retType, 'Element^[]');
  assert.deepEqual(member.attr, staff.members[0].attr);
  assert.deepEqual(member.chartArray.items, staff.members[0].chartArray.items);
});

check('build a Song (audio) staff from scratch', () => {
  const staff = {
    usings: [],
    header: [{ type: 'string', name: 'displayName', value: '音频' }],
    className: 'AudioStaff',
    annotations: ['AudioStaff'],
    members: [
      {
        attr: [
          {
            type: 'PeriodConfig^',
            name: 'config',
            value: { t: 'obj', type: 'PeriodConfig', fields: { timeOffset: 0.373 } },
          },
        ],
        annotation: 'Song',
        retType: 'AudioAsset^',
        name: 'GetSong',
        chartArray: null,
        returnValue: {
          t: 'obj',
          type: 'WavAudioAsset',
          fields: { name: 'Song', wavFilePath: 'Song.wav' },
        },
      },
    ],
  };
  const text = serializeGorgeFile(staff);
  const expected = [
    '[',
    '    string displayName = "音频"',
    ']',
    '@AudioStaff',
    'class AudioStaff',
    '{',
    '    [',
    '        PeriodConfig^ config = PeriodConfig : {',
    '            timeOffset : 0.373,',
    '        }',
    '    ]',
    '    @Song',
    '    static AudioAsset^ GetSong()',
    '    {',
    '        return WavAudioAsset : {',
    '            name : "Song",',
    '            wavFilePath : "Song.wav",',
    '        };',
    '    }',
    '',
    '',
    '}',
    '',
  ].join('\n');
  assert.equal(text, expected);
  const reparsed = parseGorgeFile(text);
  assert.deepEqual(reparsed.members[0].returnValue, staff.members[0].returnValue);
});

/* ------------------------------------------------------------------ */
/* section 7: error handling (fail loudly, never drop text silently)   */
/* ------------------------------------------------------------------ */

function expectThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected function to throw');
}

check('GorgeCodecError is an Error with line/column', () => {
  assert.ok(GorgeCodecError.prototype instanceof Error);
  const error = new GorgeCodecError('boom', 3, 7);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'GorgeCodecError');
  assert.equal(error.line, 3);
  assert.equal(error.column, 7);
  assert.match(error.message, /line 3, column 7/);

  const parsedError = expectThrow(() => parseGorgeFile('class'));
  assert.ok(parsedError instanceof GorgeCodecError);
  assert.ok(Number.isInteger(parsedError.line), 'line is set');
  assert.ok(Number.isInteger(parsedError.column), 'column is set');
});

check('truncated file throws GorgeCodecError, not silent partial output', () => {
  const error = expectThrow(() => parseGorgeFile('[\n    string form = "Dremu",\n'));
  assert.ok(error instanceof GorgeCodecError);
  assert.ok(Number.isInteger(error.line));
});

check('unrecognised construct throws GorgeCodecError', () => {
  const fileText = [
    '@ElementStaff',
    'class Broken',
    '{',
    '    @Chart',
    '    static Element^[] Period()',
    '    {',
    '        return foo + bar;',
    '    }',
    '}',
    '',
  ].join('\n');
  const error = expectThrow(() => parseGorgeFile(fileText));
  assert.ok(error instanceof GorgeCodecError);
  assert.equal(error.line, 7);
});

check('parseValue rejects trailing garbage', () => {
  const error = expectThrow(() => parseValue('foo bar'));
  assert.ok(error instanceof GorgeCodecError);
  assert.ok(Number.isInteger(error.line));
});

check('parseValue rejects unterminated expression', () => {
  const error = expectThrow(() => parseValue('(1.0/0.0'));
  assert.ok(error instanceof GorgeCodecError);
  assert.match(error.message, /unterminated/i);
});

check('parseGorgeFile rejects non-string input', () => {
  const error = expectThrow(() => parseGorgeFile(42));
  assert.ok(error instanceof GorgeCodecError);
});

check('chart array size must match the number of items', () => {
  const fileText = [
    '@ElementStaff',
    'class Bad',
    '{',
    '    @Chart',
    '    static Element^[] Period()',
    '    {',
    '        return new Element^[5]{',
    '            DremuTap : {',
    '                hitTime : 1.0,',
    '            },',
    '        };',
    '    }',
    '}',
    '',
  ].join('\n');
  const error = expectThrow(() => parseGorgeFile(fileText));
  assert.ok(error instanceof GorgeCodecError);
  assert.match(error.message, /declares 5 .* contains 1/);
});

check('serializer rejects malformed values instead of emitting bad text', () => {
  const base = {
    usings: [],
    header: null,
    className: 'X',
    annotations: [],
    members: [],
  };
  const badTag = expectThrow(() =>
    serializeGorgeFile({
      ...base,
      members: [
        {
          attr: null,
          annotation: 'Chart',
          retType: 'Element^[]',
          name: 'P',
          chartArray: { elemType: 'Element', items: [{ t: 'bogus' }] },
          returnValue: null,
        },
      ],
    }),
  );
  assert.ok(badTag instanceof GorgeCodecError);
  assert.match(badTag.message, /unknown value tag/);

  const badObj = expectThrow(() => formatValue({ t: 'obj', type: 'X' }));
  assert.ok(badObj instanceof GorgeCodecError);

  const badArr = expectThrow(() => formatValue({ t: 'arr', type: 'X', items: 'nope' }));
  assert.ok(badArr instanceof GorgeCodecError);

  const badNumber = expectThrow(() => formatValue(undefined));
  assert.ok(badNumber instanceof GorgeCodecError);
});

/* ------------------------------------------------------------------ */
/* section 8: round-trip of every corpus file's extracted values       */
/* ------------------------------------------------------------------ */

check('every corpus value survives formatValue(parseValue(formatValue(v)))', () => {
  let tested = 0;
  for (const file of corpus.files) {
    const staff = parseGorgeFile(fs.readFileSync(file, 'utf8'));
    const values = [];
    for (const member of staff.members) {
      if (member.chartArray) values.push(...member.chartArray.items);
      else values.push(member.returnValue);
    }
    for (const value of values) {
      const once = formatValue(value);
      const twice = formatValue(parseValue(once));
      assert.equal(twice, once, `value in ${relativeToMusic(file)} is not formatValue-stable`);
      tested += 1;
    }
  }
  assert.ok(tested > 0);
  console.log(`      (checked ${tested} top-level corpus chart element values)`);
});

/* ------------------------------------------------------------------ */
/* summary                                                             */
/* ------------------------------------------------------------------ */

const totalChecks = checksPassed + checksFailed;
console.log('');
console.log('SUMMARY');
if (corpus.files.length > 0) {
  console.log(
    `  corpus files      : ${corpusPassed}/${corpus.files.length} byte-exact ` +
      (corpusFailed > 0 ? `(${corpusFailed} FAILED)` : ''),
  );
}
console.log(`  codec checks      : ${checksPassed}/${totalChecks} passed`);
if (failureDetails.length > 0) {
  console.log(`  failures          : ${failureDetails.length}`);
  for (const failure of failureDetails) {
    console.log(`    - ${failure.name}: ${String((failure.error && failure.error.message) || failure.error)}`);
  }
}
const success = checksFailed === 0 && corpusFailed === 0 && corpus.missingRoots.length === 0;
console.log(`RESULT: ${success ? 'PASS' : 'FAIL'}`);
process.exit(success ? 0 : 1);
