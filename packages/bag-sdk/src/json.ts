// -----------------------------------------------------------------------------
// JSON in and out, for a hashed artifact.
//
// In: `parseJsonStrict` is an RFC 8259 parser that, unlike JSON.parse, refuses
// duplicate object keys (JSON.parse silently keeps the last one, so two
// readers of the same bytes could see different definitions) and remembers
// which numbers were written in non-integer form (`1.0`, `1e0`), so integer
// fields can reject them even though they parse to the same value.
//
// Out: `canonicalJson` is RFC 8785 (JCS) for the values bag.json uses.
// -----------------------------------------------------------------------------

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number
  ) {
    super(`${message} at offset ${offset}`);
  }
}

export interface StrictJson {
  value: unknown;
  /** Paths (same format as `BagIssue.path`) of numbers written with a fraction or an exponent. */
  nonIntegerNumbers: Set<string>;
}

const childPath = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

export function parseJsonStrict(text: string): StrictJson {
  const nonIntegerNumbers = new Set<string>();
  let i = 0;

  const fail = (message: string): never => {
    throw new JsonSyntaxError(message, i);
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const expect = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail(`expected ${word}`);
  };

  const parseString = (): string => {
    if (text[i] !== '"') fail('expected a string');
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === '\\') {
        const e = text[i + 1];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e !== undefined && e in simple) {
          out += simple[e];
          i += 2;
        } else if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          fail('bad escape');
        }
      } else {
        if (c.charCodeAt(0) < 0x20) fail('control character in string');
        out += c;
        i++;
      }
    }
  };

  const parseNumber = (path: string): number => {
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail('bad number');
    i += m![0].length;
    if (m![1] !== undefined || m![2] !== undefined) nonIntegerNumbers.add(path);
    const n = Number(m![0]);
    if (!Number.isFinite(n)) fail('number out of range');
    return n;
  };

  const parseValue = (path: string): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const key = parseString();
        if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`duplicate key "${key}"`);
        ws();
        expect(':');
        Object.defineProperty(obj, key, { value: parseValue(childPath(path, key)), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        expect('}');
        return obj;
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(childPath(path, arr.length)));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        expect(']');
        return arr;
      }
    }
    if (c === '"') return parseString();
    if (c === 't') return expect('true'), true;
    if (c === 'f') return expect('false'), false;
    if (c === 'n') return expect('null'), null;
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return parseNumber(path);
    return fail('unexpected character');
  };

  if (text.charCodeAt(0) === 0xfeff) i = 1; // tolerate a UTF-8 BOM
  const value = parseValue('');
  ws();
  if (i !== text.length) fail('trailing characters');
  return { value, nonIntegerNumbers };
}

/**
 * RFC 8785 (JSON Canonicalization Scheme) for the JSON values bag.json uses: object keys sorted by UTF-16
 * code units, no whitespace, strings and numbers serialized as ECMAScript JSON.stringify does. Refuses
 * values JSON cannot represent instead of dropping them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number.');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      return `{${keys
        .map((k) => {
          if (obj[k] === undefined) throw new Error(`canonicalJson: "${k}" is undefined.`);
          return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
        })
        .join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value}.`);
  }
}
