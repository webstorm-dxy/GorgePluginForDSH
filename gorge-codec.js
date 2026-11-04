/**
 * gorge-codec.js — `.g` (Gorge framework declarative chart format) text ⇄ typed value tree.
 *
 * Pure ESM, no dependencies, no I/O. This module is the single source of truth for the
 * on-disk syntax of Dremu/Gorge staff files used by the Dremu chart editor plugin.
 *
 * HARD GUARANTEE: for every `.g` file in /Users/daxingyi/Music/DremuTest/ and
 * /Users/daxingyi/Music/Chart/**, serializeGorgeFile(parseGorgeFile(src)) === src
 * byte for byte. tests/codec.test.mjs verifies this against the real corpus.
 *
 * Public API (see docs/CONTRACTS.md §1):
 *   parseGorgeFile(text)  -> StaffFile
 *   serializeGorgeFile(sf) -> string (canonical text)
 *   parseValue(text)      -> Value
 *   formatValue(value)    -> string (canonical text for one value)
 *   class GorgeCodecError extends Error   (with .line / .column when known)
 *
 * ---------------------------------------------------------------------------------
 * Format facts established from the real corpus (12 files, ~23k lines) — keep in sync:
 *
 *  - Line endings DIFFER per project: /Users/daxingyi/Music/DremuTest/*.g are CRLF,
 *    /Users/daxingyi/Music/Chart/**\/*.g are LF. No BOM. File ends with `}` + EOL.
 *    The parser detects the EOL style and stores it on the StaffFile as `eol`
 *    ('\r\n' | '\n'); the serializer uses `sf.eol ?? '\n'`.
 *  - 4 spaces per indent level; no tabs; no trailing whitespace.
 *  - `key : value,` — one space before and after the colon, trailing comma on every
 *    object field / list item. Typed object / typed list literals:
 *        key : Type : { ... },            (object)
 *        key : Type^ : { item, ... },     (list; `^` marks the list)
 *    Empty typed object is written inline as `Type : { : }` (a bare colon inside).
 *    Empty typed list / empty chart array use `{ , }`.
 *  - Chart method body: `return new Type^[N]{ ... };` with items at indent 12 and
 *    closing `        };`. N always equals items.length. `new Type^[0]{ , };` when empty.
 *  - Header block `[ string form = "Dremu", ... ]`, attr block `[ Type^ config = ... ]`
 *    are comma-SEPARATED (no trailing comma); the last field line has no comma.
 *  - Two blank lines after every member body `}` (before the next member or the class
 *    closing `}`). Optionally blank line(s) after a `using` block — 1 or 2 depending on
 *    the file, preserved via `sf.blankAfterUsings`.
 *  - Numbers: integers always written with `.0` (`10.0`), other floats are the shortest
 *    round-trip decimal (`0.0196078`); no exponent form in the corpus.
 *    EXCEPTION: the int-typed field `pointCount` is written as a bare integer (`200`).
 *    That is handled by INT_FIELDS below (see notes there).
 *  - ±Infinity appear only as `(-1.0/0.0)` / `(1.0/0.0)` and are kept verbatim via
 *    the `expr` value's `src` field.
 *  - Strings are double-quoted UTF-8, no escapes in the corpus.
 *  - Enum/reference values are dotted names (`ImagePositionMode.ScreenCover`).
 * ---------------------------------------------------------------------------------
 */

/** Error thrown for any unparseable / unformattable `.g` content. */
export class GorgeCodecError extends Error {
  /**
   * @param {string} message
   * @param {number|null} [line] 1-based line, when known
   * @param {number|null} [column] 1-based column, when known
   */
  constructor(message, line = null, column = null) {
    super(line != null ? `${message} (line ${line}, column ${column})` : message);
    this.name = 'GorgeCodecError';
    this.line = line;
    this.column = column;
  }
}

/* ------------------------------------------------------------------ */
/* Lexer                                                               */
/* ------------------------------------------------------------------ */

// Arithmetic operator characters only ever occur inside parenthesised expressions,
// whose source is captured verbatim by the parser; the lexer just needs to accept them.
const PUNCT = new Set(['[', ']', '{', '}', '(', ')', ';', ',', ':', '=', '^', '@', '/', '*', '+', '-', '%']);

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}
function isIdentStart(ch) {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}
function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch) || ch === '.';
}

/**
 * Tokenize `.g` source. Whitespace (including CRLF) is skipped; every token carries
 * 1-based line/column plus absolute start/end offsets (used to slice verbatim source,
 * e.g. arithmetic expressions).
 *
 * @param {string} text
 * @returns {Array<{type:string,value:any,raw:string,line:number,column:number,start:number,end:number}>}
 */
function lex(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const n = text.length;

  const push = (type, value, raw, startLine, startColumn, start, end) => {
    tokens.push({ type, value, raw, line: startLine, column: startColumn, start, end });
  };

  while (i < n) {
    const ch = text[i];

    // whitespace / newlines
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      column += 1;
      continue;
    }
    if (ch === '\n') {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }

    const startLine = line;
    const startColumn = column;
    const start = i;

    // string literal
    if (ch === '"') {
      i += 1;
      column += 1;
      let value = '';
      let closed = false;
      while (i < n) {
        const c = text[i];
        if (c === '"') {
          i += 1;
          column += 1;
          closed = true;
          break;
        }
        if (c === '\n' || c === '\r') {
          throw new GorgeCodecError('newline inside string literal', startLine, startColumn);
        }
        if (c === '\\') {
          const e = text[i + 1];
          if (e === '"') {
            value += '"';
            i += 2;
            column += 2;
            continue;
          }
          if (e === '\\') {
            value += '\\';
            i += 2;
            column += 2;
            continue;
          }
          if (e === 'n') {
            value += '\n';
            i += 2;
            column += 2;
            continue;
          }
          if (e === 'r') {
            value += '\r';
            i += 2;
            column += 2;
            continue;
          }
          if (e === 't') {
            value += '\t';
            i += 2;
            column += 2;
            continue;
          }
          if (e === 'u') {
            const hex = text.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new GorgeCodecError('invalid \\u escape in string literal', line, column);
            }
            value += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            column += 6;
            continue;
          }
          // Unknown escape: keep the escaped character verbatim.
          value += e ?? '';
          i += 2;
          column += 2;
          continue;
        }
        value += c;
        i += 1;
        column += 1;
      }
      if (!closed) throw new GorgeCodecError('unterminated string literal', startLine, startColumn);
      push('string', value, text.slice(start, i), startLine, startColumn, start, i);
      continue;
    }

    // number literal (a leading '-' belongs to the number; there is no binary minus
    // in the grammar outside of parenthesised expressions)
    if (isDigit(ch) || (ch === '-' && (isDigit(text[i + 1] ?? '') || text[i + 1] === '.'))) {
      if (ch === '-') {
        i += 1;
        column += 1;
      }
      while (i < n && isDigit(text[i])) {
        i += 1;
        column += 1;
      }
      if (text[i] === '.') {
        i += 1;
        column += 1;
        while (i < n && isDigit(text[i])) {
          i += 1;
          column += 1;
        }
      }
      if (text[i] === 'e' || text[i] === 'E') {
        const save = i;
        let j = i + 1;
        if (text[j] === '+' || text[j] === '-') j += 1;
        if (isDigit(text[j] ?? '')) {
          i = j;
          while (i < n && isDigit(text[i])) i += 1;
          column += i - save;
        }
      }
      const raw = text.slice(start, i);
      const value = Number(raw);
      if (Number.isNaN(value)) throw new GorgeCodecError(`invalid number literal '${raw}'`, startLine, startColumn);
      push('number', value, raw, startLine, startColumn, start, i);
      continue;
    }

    // dotted identifier (GorgeFramework.VariableFloat, ImagePositionMode.ScreenCover, …)
    if (isIdentStart(ch)) {
      i += 1;
      column += 1;
      while (i < n && isIdentPart(text[i])) {
        i += 1;
        column += 1;
      }
      // A trailing '.' is not a valid identifier suffix (e.g. "Foo." would be a bug).
      const raw = text.slice(start, i);
      if (raw.endsWith('.') || raw.includes('..')) {
        throw new GorgeCodecError(`invalid identifier '${raw}'`, startLine, startColumn);
      }
      push('ident', raw, raw, startLine, startColumn, start, i);
      continue;
    }

    if (PUNCT.has(ch)) {
      i += 1;
      column += 1;
      push('punct', ch, ch, startLine, startColumn, start, i);
      continue;
    }

    throw new GorgeCodecError(`unexpected character ${JSON.stringify(ch)}`, line, column);
  }

  tokens.push({ type: 'eof', value: null, raw: '', line, column, start: n, end: n });
  return tokens;
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

class Parser {
  /**
   * @param {string} text
   */
  constructor(text) {
    this.text = text;
    this.tokens = lex(text);
    this.pos = 0;
  }

  peek(offset = 0) {
    const index = this.pos + offset;
    if (index >= this.tokens.length) return this.tokens[this.tokens.length - 1];
    return this.tokens[index];
  }

  next() {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  error(message, token = this.peek()) {
    return new GorgeCodecError(message, token.line, token.column);
  }

  checkPunct(ch) {
    const t = this.peek();
    return t.type === 'punct' && t.value === ch;
  }

  checkIdent(name) {
    const t = this.peek();
    return t.type === 'ident' && t.value === name;
  }

  expectPunct(ch) {
    const t = this.peek();
    if (t.type !== 'punct' || t.value !== ch) {
      throw this.error(`expected '${ch}' but found ${describeToken(t)}`, t);
    }
    return this.next();
  }

  expectIdent() {
    const t = this.peek();
    if (t.type !== 'ident') throw this.error(`expected an identifier but found ${describeToken(t)}`, t);
    return this.next();
  }

  expectIdentName(name) {
    const t = this.peek();
    if (t.type !== 'ident' || t.value !== name) {
      throw this.error(`expected '${name}' but found ${describeToken(t)}`, t);
    }
    return this.next();
  }

  expectEof() {
    const t = this.peek();
    if (t.type !== 'eof') throw this.error(`unexpected ${describeToken(t)} after end of file`, t);
  }

  expectNumber() {
    const t = this.peek();
    if (t.type !== 'number') throw this.error(`expected a number but found ${describeToken(t)}`, t);
    return this.next();
  }

  /**
   * Parse a type reference as raw text: `DottedName`, `DottedName^`, or `DottedName^[]`.
   * Stored verbatim so qualified and unqualified corpora both round-trip.
   */
  parseTypeRaw() {
    let type = this.expectIdent().value;
    if (this.checkPunct('^')) {
      this.next();
      type += '^';
      if (this.checkPunct('[')) {
        this.next();
        this.expectPunct(']');
        type += '[]';
      }
    }
    return type;
  }

  /* -- file ---------------------------------------------------------- */

  parseFile() {
    const usings = [];
    let lastUsingEnd = -1;
    while (this.checkIdent('using')) {
      this.next();
      usings.push(this.expectIdent().value);
      lastUsingEnd = this.expectPunct(';').end;
    }

    let blankAfterUsings = 0;
    if (usings.length > 0) {
      const gap = this.text.slice(lastUsingEnd, this.peek().start);
      const newlines = (gap.match(/\n/g) || []).length;
      blankAfterUsings = Math.max(0, newlines - 1);
    }

    let header = null;
    if (this.checkPunct('[')) header = this.parseHeaderBlock();

    const annotations = [];
    while (this.checkPunct('@')) {
      this.next();
      annotations.push(this.expectIdent().value);
    }

    this.expectIdentName('class');
    const className = this.expectIdent().value;
    this.expectPunct('{');

    const members = [];
    while (!this.checkPunct('}')) {
      if (this.peek().type === 'eof') throw this.error('unexpected end of file inside class body');
      members.push(this.parseMember());
    }
    this.expectPunct('}');
    this.expectEof();

    return { usings, header, className, annotations, members, blankAfterUsings };
  }

  /** `[ Type name = value, ... ]` header block. */
  parseHeaderBlock() {
    this.expectPunct('[');
    const fields = [];
    while (!this.checkPunct(']')) {
      const type = this.parseTypeRaw();
      const name = this.expectIdent().value;
      this.expectPunct('=');
      const value = this.parseValue();
      fields.push({ type, name, value });
      if (this.checkPunct(',')) {
        this.next();
        continue;
      }
      break;
    }
    this.expectPunct(']');
    return fields;
  }

  /** `[ Type^ name = value, ... ]` attr block before a member. */
  parseAttrBlock() {
    this.expectPunct('[');
    const fields = [];
    while (!this.checkPunct(']')) {
      const type = this.parseTypeRaw();
      const name = this.expectIdent().value;
      this.expectPunct('=');
      const value = this.parseValue();
      fields.push({ type, name, value });
      if (this.checkPunct(',')) {
        this.next();
        continue;
      }
      break;
    }
    this.expectPunct(']');
    return fields;
  }

  parseMember() {
    let attr = null;
    if (this.checkPunct('[')) attr = this.parseAttrBlock();

    this.expectPunct('@');
    const annotation = this.expectIdent().value;
    this.expectIdentName('static');
    const retType = this.parseTypeRaw();
    const name = this.expectIdent().value;
    this.expectPunct('(');
    this.expectPunct(')');
    this.expectPunct('{');
    this.expectIdentName('return');

    let chartArray = null;
    let returnValue = null;
    if (this.checkIdent('new')) chartArray = this.parseChartArray();
    else returnValue = this.parseValue();

    this.expectPunct(';');
    this.expectPunct('}');

    return { attr, annotation, retType, name, chartArray, returnValue };
  }

  /** `new Type^[N]{ item, ... }` chart array initializer. */
  parseChartArray() {
    this.expectIdentName('new');
    const elemType = this.expectIdent().value;
    this.expectPunct('^');
    this.expectPunct('[');
    const sizeToken = this.expectNumber();
    const declaredSize = sizeToken.value;
    if (!Number.isInteger(declaredSize) || declaredSize < 0 || sizeToken.raw.includes('.')) {
      throw this.error(`array size must be a non-negative integer, found '${sizeToken.raw}'`, sizeToken);
    }
    this.expectPunct(']');
    this.expectPunct('{');

    const items = [];
    if (this.checkPunct(',') || this.checkPunct(':')) {
      this.next();
      this.expectPunct('}');
    } else if (this.checkPunct('}')) {
      this.next();
    } else {
      while (true) {
        items.push(this.parseValue());
        if (this.checkPunct(',')) {
          this.next();
          if (this.checkPunct('}')) {
            this.next();
            break;
          }
          continue;
        }
        if (this.checkPunct('}')) {
          this.next();
          break;
        }
        throw this.error(`expected ',' or '}' in array initializer but found ${describeToken(this.peek())}`);
      }
    }

    if (declaredSize !== items.length) {
      throw this.error(
        `array initializer declares ${declaredSize} item(s) but contains ${items.length}`,
        sizeToken,
      );
    }
    return { elemType, items };
  }

  /* -- values -------------------------------------------------------- */

  parseValue() {
    const t = this.peek();
    if (t.type === 'number') {
      this.next();
      return t.value;
    }
    if (t.type === 'string') {
      this.next();
      return t.value;
    }
    if (t.type === 'punct' && t.value === '(') return this.parseExpr();
    if (t.type === 'ident') return this.parseNamedValue();
    if (t.type === 'eof') throw this.error('unexpected end of file where a value was expected');
    throw this.error(`unexpected ${describeToken(t)} where a value was expected`);
  }

  /** A value that starts with a dotted name: true/false/null, ref, typed obj, typed list. */
  parseNamedValue() {
    const token = this.expectIdent();
    const name = token.value;
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;

    if (this.checkPunct('^')) {
      this.next();
      this.expectPunct(':');
      this.expectPunct('{');
      return { t: 'arr', type: name, items: this.parseListItems() };
    }
    if (this.checkPunct(':')) {
      this.next();
      this.expectPunct('{');
      return this.parseObjectBody(name);
    }
    return { t: 'ref', path: name };
  }

  /** Body of `Type : { ... }` — either `{ : }` (empty) or fields; the `{` is consumed. */
  parseObjectBody(type) {
    if (this.checkPunct(':') || this.checkPunct(',')) {
      this.next();
      this.expectPunct('}');
      return { t: 'obj', type, fields: {} };
    }
    if (this.checkPunct('}')) {
      this.next();
      return { t: 'obj', type, fields: {} };
    }

    const fields = {};
    const intFields = [];
    for (;;) {
      const nameToken = this.expectIdent();
      const name = nameToken.value;
      this.expectPunct(':');
      const valueToken = this.peek();
      const value = this.parseValue();
      // A bare integer literal (no '.') is how the Gorge writer emits int-typed
      // fields (only `pointCount` in the corpus). Remember such names so unknown
      // int fields also round-trip instead of being rewritten as `N.0`.
      if (
        valueToken.type === 'number' &&
        !valueToken.raw.includes('.') &&
        typeof value === 'number' &&
        Number.isInteger(value)
      ) {
        intFields.push(name);
      }
      fields[name] = value;

      if (this.checkPunct(',')) {
        this.next();
        if (this.checkPunct('}')) {
          this.next();
          break;
        }
        continue;
      }
      if (this.checkPunct('}')) {
        this.next();
        break;
      }
      throw this.error(`expected ',' or '}' in object literal but found ${describeToken(this.peek())}`);
    }

    const obj = { t: 'obj', type, fields };
    if (intFields.length > 0) obj.intFields = intFields;
    return obj;
  }

  /** Items of `Type^ : { ... }` — the `{` has been consumed. */
  parseListItems() {
    const items = [];
    if (this.checkPunct(',') || this.checkPunct(':') || this.checkPunct('}')) {
      this.next();
      this.expectPunct('}');
      return items;
    }
    for (;;) {
      items.push(this.parseValue());
      if (this.checkPunct(',')) {
        this.next();
        if (this.checkPunct('}')) {
          this.next();
          break;
        }
        continue;
      }
      if (this.checkPunct('}')) {
        this.next();
        break;
      }
      throw this.error(`expected ',' or '}' in list literal but found ${describeToken(this.peek())}`);
    }
    return items;
  }

  /**
   * Parenthesised arithmetic expression, e.g. `(-1.0/0.0)`, `(1.0/0.0)`.
   * The verbatim source slice (including the parentheses) is preserved in `src` so
   * that serialization is byte-exact; `special` is a best-effort evaluation.
   */
  parseExpr() {
    const openToken = this.expectPunct('(');
    const start = openToken.start;
    let i = start;
    let depth = 0;
    let inString = false;
    while (i < this.text.length) {
      const ch = this.text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inString = true;
        i += 1;
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      i += 1;
    }
    if (depth !== 0) throw this.error('unterminated parenthesised expression', openToken);

    const src = this.text.slice(start, i);
    const inner = this.text.slice(start + 1, i - 1);
    // Consume all tokens that belong to the expression.
    while (this.peek().type !== 'eof' && this.peek().end <= i) this.next();

    return { t: 'expr', src, special: evaluateExprSpecial(inner) };
  }
}

function describeToken(token) {
  if (!token || token.type === 'eof') return 'end of file';
  if (token.type === 'string') return `string ${JSON.stringify(token.value)}`;
  return `'${token.raw}'`;
}

/* ------------------------------------------------------------------ */
/* Expression helpers                                                  */
/* ------------------------------------------------------------------ */

const EXPR_NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const EXPR_BINARY = new RegExp(
  `^\\s*(${EXPR_NUMBER})\\s*([+\\-*/%])\\s*(${EXPR_NUMBER})\\s*$`,
);
const EXPR_SINGLE = new RegExp(`^\\s*(${EXPR_NUMBER})\\s*$`);

/** Evaluate a simple numeric expression to a `special` marker (see CONTRACTS §1.2). */
function evaluateExprSpecial(inner) {
  const binary = EXPR_BINARY.exec(inner);
  if (binary) {
    const a = Number(binary[1]);
    const b = Number(binary[3]);
    let value;
    switch (binary[2]) {
      case '+':
        value = a + b;
        break;
      case '-':
        value = a - b;
        break;
      case '*':
        value = a * b;
        break;
      case '/':
        value = a / b;
        break;
      case '%':
        value = a % b;
        break;
      default:
        value = NaN;
    }
    return classifySpecial(value);
  }
  const single = EXPR_SINGLE.exec(inner);
  if (single) return classifySpecial(Number(single[1]));
  // Unknown expression body: keep `src` for byte-exact writing, use the JSON-safe
  // 'NaN' marker (a raw NaN would serialize as null over the wire).
  return 'NaN';
}

function classifySpecial(value) {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return value;
}

/* ------------------------------------------------------------------ */
/* Writer                                                              */
/* ------------------------------------------------------------------ */

/**
 * Field names whose values are int-typed in the Gorge schema and are therefore written
 * as bare integers (`pointCount : 200`) instead of the canonical float form (`200.0`).
 * Established from the corpus (5 occurrences in DremuTest/DremuStaff1.g). The value
 * tree stays contract-compliant (`Value = number`); only the writer knows the type.
 * Unknown int-typed fields found while parsing are remembered on the object node as
 * `intFields` and also written bare, so foreign staff files still round-trip.
 */
const INT_FIELDS = new Set(['pointCount']);

function pad(indent) {
  return ' '.repeat(indent);
}

/** Expand a JS number string that uses exponent notation into plain decimal text. */
function expandExponent(text) {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const sign = match[1];
  const intPart = match[2];
  const fracPart = match[3] ?? '';
  const exponent = parseInt(match[4], 10);
  const digits = intPart + fracPart;
  const point = intPart.length + exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Canonical number text: integers get `.0` (`10.0`), other floats are shortest
 * round-trip decimal, never exponent notation. ±Infinity/NaN become the parenthesised
 * division expressions used by the corpus.
 *
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (value === Infinity) return '(1.0/0.0)';
    if (value === -Infinity) return '(-1.0/0.0)';
    if (typeof value === 'number' && Number.isNaN(value)) return '(0.0/0.0)';
    throw new GorgeCodecError(`cannot format non-number value ${String(value)}`);
  }
  if (Object.is(value, -0)) return '-0.0';
  if (Number.isInteger(value)) {
    return `${expandExponent(String(value))}.0`;
  }
  return expandExponent(String(value));
}

/** Bare integer text for int-typed fields (`200`). */
function formatIntLiteral(value) {
  return expandExponent(String(value));
}

function quoteString(value) {
  let out = '"';
  for (const ch of value) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return `${out}"`;
}

/** Canonical text of an `expr` value. `src` is preserved verbatim for round-trips. */
function exprText(value) {
  if (typeof value.src === 'string' && value.src.trim() !== '') {
    const src = value.src.trim();
    return src.startsWith('(') && src.endsWith(')') ? src : `(${src})`;
  }
  const special = value.special;
  if (special === 'Infinity') return '(1.0/0.0)';
  if (special === '-Infinity') return '(-1.0/0.0)';
  if (special === 'NaN') return '(0.0/0.0)';
  if (typeof special === 'number') return `(${formatNumber(special)})`;
  throw new GorgeCodecError('expr value needs either .src or .special');
}

/**
 * Append the canonical line(s) for `value` to `lines`.
 *
 * Layout contract: the first emitted line starts at `indent` spaces, followed by
 * `prefix`, then the value text, then `suffix`. Continuation lines are already fully
 * indented (the value's closing brace sits at `indent`).
 *
 * @param {string[]} lines
 * @param {any} value
 * @param {number} indent
 * @param {string} prefix
 * @param {string} suffix
 */
function pushValue(lines, value, indent, prefix, suffix) {
  const lead = pad(indent);
  if (value === null) {
    lines.push(`${lead}${prefix}null${suffix}`);
    return;
  }
  switch (typeof value) {
    case 'number':
      lines.push(`${lead}${prefix}${formatNumber(value)}${suffix}`);
      return;
    case 'string':
      lines.push(`${lead}${prefix}${quoteString(value)}${suffix}`);
      return;
    case 'boolean':
      lines.push(`${lead}${prefix}${value ? 'true' : 'false'}${suffix}`);
      return;
    case 'object':
      break;
    default:
      throw new GorgeCodecError(`cannot format value of type ${typeof value}`);
  }

  const tag = value.t;
  if (tag === 'ref') {
    if (typeof value.path !== 'string' || value.path === '') {
      throw new GorgeCodecError("ref value needs a non-empty 'path' string");
    }
    lines.push(`${lead}${prefix}${value.path}${suffix}`);
    return;
  }
  if (tag === 'expr') {
    lines.push(`${lead}${prefix}${exprText(value)}${suffix}`);
    return;
  }
  if (tag === 'obj') {
    pushObject(lines, value, indent, prefix, suffix);
    return;
  }
  if (tag === 'arr') {
    pushList(lines, value, indent, prefix, suffix);
    return;
  }
  throw new GorgeCodecError(`unknown value tag ${JSON.stringify(tag)}; expected ref/expr/obj/arr`);
}

function pushObject(lines, value, indent, prefix, suffix) {
  if (typeof value.type !== 'string' || value.type === '') {
    throw new GorgeCodecError("obj value needs a non-empty 'type' string");
  }
  const fields = value.fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new GorgeCodecError("obj value needs a 'fields' object");
  }
  const names = Object.keys(fields);
  const lead = pad(indent);
  if (names.length === 0) {
    lines.push(`${lead}${prefix}${value.type} : { : }${suffix}`);
    return;
  }
  lines.push(`${lead}${prefix}${value.type} : {`);
  const fieldIndent = pad(indent + 4);
  const intFields = Array.isArray(value.intFields) ? value.intFields : null;
  for (const name of names) {
    const fieldValue = fields[name];
    const isIntField =
      typeof fieldValue === 'number' &&
      Number.isInteger(fieldValue) &&
      (INT_FIELDS.has(name) || (intFields !== null && intFields.includes(name)));
    if (isIntField) {
      lines.push(`${fieldIndent}${name} : ${formatIntLiteral(fieldValue)},`);
    } else {
      pushValue(lines, fieldValue, indent + 4, `${name} : `, ',');
    }
  }
  lines.push(`${lead}}${suffix}`);
}

function pushList(lines, value, indent, prefix, suffix) {
  if (typeof value.type !== 'string' || value.type === '') {
    throw new GorgeCodecError("arr value needs a non-empty 'type' string (the element type)");
  }
  if (!Array.isArray(value.items)) throw new GorgeCodecError("arr value needs an 'items' array");
  const lead = pad(indent);
  if (value.items.length === 0) {
    lines.push(`${lead}${prefix}${value.type}^ : { , }${suffix}`);
    return;
  }
  lines.push(`${lead}${prefix}${value.type}^ : {`);
  for (const item of value.items) pushValue(lines, item, indent + 4, '', ',');
  lines.push(`${lead}}${suffix}`);
}

function requireNonEmptyString(value, what) {
  if (typeof value !== 'string' || value === '') {
    throw new GorgeCodecError(`${what} must be a non-empty string`);
  }
  return value;
}

/** Header / attr block fields: comma-separated, no trailing comma on the last field. */
function pushBlockFields(lines, fields, indent) {
  if (!Array.isArray(fields)) throw new GorgeCodecError('expected a field array');
  fields.forEach((field, index) => {
    if (!field || typeof field !== 'object') throw new GorgeCodecError('invalid block field');
    const type = requireNonEmptyString(field.type, 'block field type');
    const name = requireNonEmptyString(field.name, 'block field name');
    const suffix = index < fields.length - 1 ? ',' : '';
    pushValue(lines, field.value, indent, `${type} ${name} = `, suffix);
  });
}

/**
 * Build the canonical output as an array of lines (EOL-agnostic).
 * @param {object} staffFile
 * @returns {string[]}
 */
function buildLines(staffFile) {
  if (staffFile === null || typeof staffFile !== 'object') {
    throw new GorgeCodecError('serializeGorgeFile expects a StaffFile object');
  }
  const lines = [];

  const usings = staffFile.usings ?? [];
  if (!Array.isArray(usings)) throw new GorgeCodecError('StaffFile.usings must be an array');
  for (const using of usings) {
    lines.push(`using ${requireNonEmptyString(using, 'StaffFile.usings entry')};`);
  }
  if (usings.length > 0) {
    const blankLines = Number.isInteger(staffFile.blankAfterUsings)
      ? Math.max(0, staffFile.blankAfterUsings)
      : 1;
    for (let i = 0; i < blankLines; i += 1) lines.push('');
  }

  if (staffFile.header !== null && staffFile.header !== undefined) {
    lines.push('[');
    pushBlockFields(lines, staffFile.header, 4);
    lines.push(']');
  }

  const annotations = staffFile.annotations ?? [];
  if (!Array.isArray(annotations)) throw new GorgeCodecError('StaffFile.annotations must be an array');
  for (const annotation of annotations) {
    lines.push(`@${requireNonEmptyString(annotation, 'StaffFile.annotations entry')}`);
  }

  if (typeof staffFile.className !== 'string' || staffFile.className === '') {
    throw new GorgeCodecError('StaffFile.className must be a non-empty string');
  }
  lines.push(`class ${staffFile.className}`);
  lines.push('{');

  const members = staffFile.members ?? [];
  if (!Array.isArray(members)) throw new GorgeCodecError('StaffFile.members must be an array');
  for (const member of members) {
    if (member === null || typeof member !== 'object') throw new GorgeCodecError('invalid member');
    const annotation = requireNonEmptyString(member.annotation, 'member.annotation');
    const retType = requireNonEmptyString(member.retType, 'member.retType');
    const memberName = requireNonEmptyString(member.name, 'member.name');
    if (member.attr !== null && member.attr !== undefined) {
      lines.push('    [');
      pushBlockFields(lines, member.attr, 8);
      lines.push('    ]');
    }
    lines.push(`    @${annotation}`);
    lines.push(`    static ${retType} ${memberName}()`);
    lines.push('    {');

    if (member.chartArray !== null && member.chartArray !== undefined) {
      const chartArray = member.chartArray;
      if (typeof chartArray.elemType !== 'string' || chartArray.elemType === '') {
        throw new GorgeCodecError('chartArray.elemType must be a non-empty string');
      }
      if (!Array.isArray(chartArray.items)) throw new GorgeCodecError('chartArray.items must be an array');
      if (chartArray.items.length === 0) {
        lines.push(`        return new ${chartArray.elemType}^[0]{ , };`);
      } else {
        lines.push(`        return new ${chartArray.elemType}^[${chartArray.items.length}]{`);
        for (const item of chartArray.items) pushValue(lines, item, 12, '', ',');
        lines.push('        };');
      }
    } else {
      pushValue(lines, member.returnValue, 8, 'return ', ';');
    }

    lines.push('    }');
    // Two blank lines after every member body (before the next member or class close).
    lines.push('');
    lines.push('');
  }

  lines.push('}');
  return lines;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Detect the file's line-ending style. The corpus is consistent within each project
 * (DremuTest = CRLF, Chart = LF); mixed endings cannot round-trip byte-exactly and
 * fall back to LF.
 *
 * @param {string} text
 * @returns {'\r\n'|'\n'}
 */
function detectEol(text) {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      if (i > 0 && text[i - 1] === '\r') crlf += 1;
      else lf += 1;
    }
  }
  if (crlf > 0 && lf === 0) return '\r\n';
  if (lf > 0 && crlf === 0) return '\n';
  return '\n';
}

/**
 * Parse a complete `.g` staff file.
 *
 * @param {string} text file content exactly as read from disk (EOL style preserved)
 * @returns {{
 *   usings: string[],
 *   header: Array<{type:string,name:string,value:any}>|null,
 *   className: string,
 *   annotations: string[],
 *   members: Array<{attr: Array<{type:string,name:string,value:any}>|null, annotation:string, retType:string, name:string, chartArray:{elemType:string,items:any[]}|null, returnValue:any}>,
 *   blankAfterUsings: number,
 *   eol: '\r\n'|'\n',
 * }}
 */
export function parseGorgeFile(text) {
  if (typeof text !== 'string') {
    throw new GorgeCodecError('parseGorgeFile expects a string');
  }
  const parser = new Parser(text);
  const staffFile = parser.parseFile();
  staffFile.eol = detectEol(text);
  return staffFile;
}

/**
 * Serialize a StaffFile back to canonical `.g` text.
 * Byte-identical to the source for every file in the reference corpus.
 *
 * @param {object} staffFile
 * @returns {string}
 */
export function serializeGorgeFile(staffFile) {
  const eol = staffFile && staffFile.eol === '\r\n' ? '\r\n' : '\n';
  return buildLines(staffFile).join(eol) + eol;
}

/**
 * Parse a single standalone value (for tests and tooling).
 *
 * @param {string} text e.g. 'GorgeFramework.VariableFloat : { baseValue : 0.0, }'
 * @returns {any}
 */
export function parseValue(text) {
  if (typeof text !== 'string') throw new GorgeCodecError('parseValue expects a string');
  const parser = new Parser(text);
  const value = parser.parseValue();
  parser.expectEof();
  return value;
}

/**
 * Canonical text for a single value, indented from column 0, joined with `\n`.
 *
 * @param {any} value
 * @returns {string}
 */
export function formatValue(value) {
  const lines = [];
  pushValue(lines, value, 0, '', '');
  return lines.join('\n');
}
