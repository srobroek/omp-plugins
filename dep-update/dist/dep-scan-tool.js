// @bun
// node_modules/smol-toml/dist/error.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1;i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += `
`;
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += `^
`;
    }
  }
  return codeblock;
}

class TomlError extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
}

// node_modules/smol-toml/dist/util.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function isEscaped(str, ptr) {
  let i = 0;
  while (str[ptr - ++i] === "\\")
    ;
  return --i && i % 2;
}
function indexOfNewline(str, start = 0, end = str.length) {
  let idx = str.indexOf(`
`, start);
  if (str[idx - 1] === "\r")
    idx--;
  return idx <= end ? idx : -1;
}
function skipComment(str, ptr) {
  for (let i = ptr;i < str.length; i++) {
    let c = str[i];
    if (c === `
`)
      return i;
    if (c === "\r" && str[i + 1] === `
`)
      return i + 1;
    if (c < " " && c !== "\t" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in comments", {
        toml: str,
        ptr
      });
    }
  }
  return str.length;
}
function skipVoid(str, ptr, banNewLines, banComments) {
  let c;
  while (true) {
    while ((c = str[ptr]) === " " || c === "\t" || !banNewLines && (c === `
` || c === "\r" && str[ptr + 1] === `
`))
      ptr++;
    if (banComments || c !== "#")
      break;
    ptr = skipComment(str, ptr);
  }
  return ptr;
}
function skipUntil(str, ptr, sep, end, banNewLines = false) {
  if (!end) {
    ptr = indexOfNewline(str, ptr);
    return ptr < 0 ? str.length : ptr;
  }
  for (let i = ptr;i < str.length; i++) {
    let c = str[i];
    if (c === "#") {
      i = indexOfNewline(str, i);
    } else if (c === sep) {
      return i + 1;
    } else if (c === end || banNewLines && (c === `
` || c === "\r" && str[i + 1] === `
`)) {
      return i;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: str,
    ptr
  });
}
function getStringEnd(str, seek) {
  let first = str[seek];
  let target = first === str[seek + 1] && str[seek + 1] === str[seek + 2] ? str.slice(seek, seek + 3) : first;
  seek += target.length - 1;
  do
    seek = str.indexOf(target, ++seek);
  while (seek > -1 && first !== "'" && isEscaped(str, seek));
  if (seek > -1) {
    seek += target.length;
    if (target.length > 1) {
      if (str[seek] === first)
        seek++;
      if (str[seek] === first)
        seek++;
    }
  }
  return seek;
}

// node_modules/smol-toml/dist/date.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;

class TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 60000);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
}

// node_modules/smol-toml/dist/primitive.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
var ESCAPE_REGEX = /^[0-9a-f]{2,8}$/i;
var ESC_MAP = {
  b: "\b",
  t: "\t",
  n: `
`,
  f: "\f",
  r: "\r",
  e: "\x1B",
  '"': '"',
  "\\": "\\"
};
function parseString(str, ptr = 0, endPtr = str.length) {
  let isLiteral = str[ptr] === "'";
  let isMultiline = str[ptr++] === str[ptr] && str[ptr] === str[ptr + 1];
  if (isMultiline) {
    endPtr -= 2;
    if (str[ptr += 2] === "\r")
      ptr++;
    if (str[ptr] === `
`)
      ptr++;
  }
  let tmp = 0;
  let isEscape;
  let parsed = "";
  let sliceStart = ptr;
  while (ptr < endPtr - 1) {
    let c = str[ptr++];
    if (c === `
` || c === "\r" && str[ptr] === `
`) {
      if (!isMultiline) {
        throw new TomlError("newlines are not allowed in strings", {
          toml: str,
          ptr: ptr - 1
        });
      }
    } else if (c < " " && c !== "\t" || c === "\x7F") {
      throw new TomlError("control characters are not allowed in strings", {
        toml: str,
        ptr: ptr - 1
      });
    }
    if (isEscape) {
      isEscape = false;
      if (c === "x" || c === "u" || c === "U") {
        let code = str.slice(ptr, ptr += c === "x" ? 2 : c === "u" ? 4 : 8);
        if (!ESCAPE_REGEX.test(code)) {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
        try {
          parsed += String.fromCodePoint(parseInt(code, 16));
        } catch {
          throw new TomlError("invalid unicode escape", {
            toml: str,
            ptr: tmp
          });
        }
      } else if (isMultiline && (c === `
` || c === " " || c === "\t" || c === "\r")) {
        ptr = skipVoid(str, ptr - 1, true);
        if (str[ptr] !== `
` && str[ptr] !== "\r") {
          throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
            toml: str,
            ptr: tmp
          });
        }
        ptr = skipVoid(str, ptr);
      } else if (c in ESC_MAP) {
        parsed += ESC_MAP[c];
      } else {
        throw new TomlError("unrecognized escape sequence", {
          toml: str,
          ptr: tmp
        });
      }
      sliceStart = ptr;
    } else if (!isLiteral && c === "\\") {
      tmp = ptr - 1;
      isEscape = true;
      parsed += str.slice(sliceStart, tmp);
    }
  }
  return parsed + str.slice(sliceStart, endPtr - 1);
}
function parseValue(value, toml, ptr, integersAsBigInt) {
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", {
        toml,
        ptr
      });
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", {
        toml,
        ptr
      });
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", {
          toml,
          ptr
        });
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid()) {
    throw new TomlError("invalid value", {
      toml,
      ptr
    });
  }
  return date;
}

// node_modules/smol-toml/dist/extract.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function sliceAndTrimEndOf(str, startPtr, endPtr) {
  let value = str.slice(startPtr, endPtr);
  let commentIdx = value.indexOf("#");
  if (commentIdx > -1) {
    skipComment(str, commentIdx);
    value = value.slice(0, commentIdx);
  }
  return [value.trimEnd(), commentIdx];
}
function extractValue(str, ptr, end, depth, integersAsBigInt) {
  if (depth === 0) {
    throw new TomlError("document contains excessively nested structures. aborting.", {
      toml: str,
      ptr
    });
  }
  let c = str[ptr];
  if (c === "[" || c === "{") {
    let [value, endPtr2] = c === "[" ? parseArray(str, ptr, depth, integersAsBigInt) : parseInlineTable(str, ptr, depth, integersAsBigInt);
    if (end) {
      endPtr2 = skipVoid(str, endPtr2);
      if (str[endPtr2] === ",")
        endPtr2++;
      else if (str[endPtr2] !== end) {
        throw new TomlError("expected comma or end of structure", {
          toml: str,
          ptr: endPtr2
        });
      }
    }
    return [value, endPtr2];
  }
  let endPtr;
  if (c === '"' || c === "'") {
    endPtr = getStringEnd(str, ptr);
    let parsed = parseString(str, ptr, endPtr);
    if (end) {
      endPtr = skipVoid(str, endPtr);
      if (str[endPtr] && str[endPtr] !== "," && str[endPtr] !== end && str[endPtr] !== `
` && str[endPtr] !== "\r") {
        throw new TomlError("unexpected character encountered", {
          toml: str,
          ptr: endPtr
        });
      }
      endPtr += +(str[endPtr] === ",");
    }
    return [parsed, endPtr];
  }
  endPtr = skipUntil(str, ptr, ",", end);
  let slice = sliceAndTrimEndOf(str, ptr, endPtr - +(str[endPtr - 1] === ","));
  if (!slice[0]) {
    throw new TomlError("incomplete key-value declaration: no value specified", {
      toml: str,
      ptr
    });
  }
  if (end && slice[1] > -1) {
    endPtr = skipVoid(str, ptr + slice[1]);
    endPtr += +(str[endPtr] === ",");
  }
  return [
    parseValue(slice[0], str, ptr, integersAsBigInt),
    endPtr
  ];
}

// node_modules/smol-toml/dist/struct.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(str, ptr, end = "=") {
  let dot = ptr - 1;
  let parsed = [];
  let endPtr = str.indexOf(end, ptr);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: str,
      ptr
    });
  }
  do {
    let c = str[ptr = ++dot];
    if (c !== " " && c !== "\t") {
      if (c === '"' || c === "'") {
        if (c === str[ptr + 1] && c === str[ptr + 2]) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: str,
            ptr
          });
        }
        let eos = getStringEnd(str, ptr);
        if (eos < 0) {
          throw new TomlError("unfinished string encountered", {
            toml: str,
            ptr
          });
        }
        dot = str.indexOf(".", eos);
        let strEnd = str.slice(eos, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: str,
            ptr: ptr + dot + newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: str,
            ptr: eos
          });
        }
        if (endPtr < eos) {
          endPtr = str.indexOf(end, eos);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: str,
              ptr
            });
          }
        }
        parsed.push(parseString(str, ptr, eos));
      } else {
        dot = str.indexOf(".", ptr);
        let part = str.slice(ptr, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: str,
            ptr
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  return [parsed, skipVoid(str, endPtr + 1, true, true)];
}
function parseInlineTable(str, ptr, depth, integersAsBigInt) {
  let res = {};
  let seen = new Set;
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "}" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "\t" && c !== `
` && c !== "\r") {
      let k;
      let t = res;
      let hasOwn = false;
      let [key, keyEndPtr] = parseKey(str, ptr - 1);
      for (let i = 0;i < key.length; i++) {
        if (i)
          t = hasOwn ? t[k] : t[k] = {};
        k = key[i];
        if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
          throw new TomlError("trying to redefine an already defined value", {
            toml: str,
            ptr
          });
        }
        if (!hasOwn && k === "__proto__") {
          Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        }
      }
      if (hasOwn) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: str,
          ptr
        });
      }
      let [value, valueEndPtr] = extractValue(str, keyEndPtr, "}", depth - 1, integersAsBigInt);
      seen.add(value);
      t[k] = value;
      ptr = valueEndPtr;
    }
  }
  if (!c) {
    throw new TomlError("unfinished table encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}
function parseArray(str, ptr, depth, integersAsBigInt) {
  let res = [];
  let c;
  ptr++;
  while ((c = str[ptr++]) !== "]" && c) {
    if (c === ",") {
      throw new TomlError("expected value, found comma", {
        toml: str,
        ptr: ptr - 1
      });
    } else if (c === "#")
      ptr = skipComment(str, ptr);
    else if (c !== " " && c !== "\t" && c !== `
` && c !== "\r") {
      let e = extractValue(str, ptr - 1, "]", depth - 1, integersAsBigInt);
      res.push(e[0]);
      ptr = e[1];
    }
  }
  if (!c) {
    throw new TomlError("unfinished array encountered", {
      toml: str,
      ptr
    });
  }
  return [res, ptr];
}

// node_modules/smol-toml/dist/parse.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0;i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse(toml, { maxDepth = 1000, integersAsBigInt } = {}) {
  let res = {};
  let meta = {};
  let tbl = res;
  let m = meta;
  for (let ptr = skipVoid(toml, 0);ptr < toml.length; ) {
    if (toml[ptr] === "[") {
      let isTableArray = toml[++ptr] === "[";
      let k = parseKey(toml, ptr += +isTableArray, "]");
      if (isTableArray) {
        if (toml[k[1] - 1] !== "]") {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: k[1] - 1
          });
        }
        k[1]++;
      }
      let p = peekTable(k[0], res, meta, isTableArray ? 2 : 1);
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      m = p[2];
      tbl = p[1];
      ptr = k[1];
    } else {
      let k = parseKey(toml, ptr);
      let p = peekTable(k[0], tbl, m, 0);
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr
        });
      }
      let v = extractValue(toml, k[1], undefined, maxDepth, integersAsBigInt);
      p[1][p[0]] = v[0];
      ptr = v[1];
    }
    ptr = skipVoid(toml, ptr, true);
    if (toml[ptr] && toml[ptr] !== `
` && toml[ptr] !== "\r") {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr
      });
    }
    ptr = skipVoid(toml, ptr);
  }
  return res;
}

// node_modules/smol-toml/dist/stringify.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// node_modules/smol-toml/dist/index.js
/*!
 * Copyright (c) Squirrel Chat et al., All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

// extensions/lib.ts
import { statSync } from "fs";
var MISSING = "?";
var USER_AGENT = "dep-update-skill (+https://github.com/srobroek/agentic-packages)";
var FETCH_TIMEOUT_MS = 1e4;
var REQ_SPLIT = /[\[<>=!~;\s]/;
var REQ_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
var GEM = /^\s*gem\s+(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?/;
var VERSION_HEAD = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/;
var PRERELEASE = /(a|b|rc|alpha|beta|dev|post)[\d.]/i;
var PROTECTED_NAME = /^\.project-setup|answers\.toml|sources\.toml/;
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function join(root, name) {
  return root.endsWith("/") ? root + name : `${root}/${name}`;
}
async function readText(path) {
  try {
    if (!isFile(path))
      return null;
    const buf = await Bun.file(path).arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.charCodeAt(0) === 65279)
      text = text.slice(1);
    return text;
  } catch {
    return null;
  }
}
function scalar(value) {
  if (value === null || value === undefined || typeof value === "object")
    return MISSING;
  return String(value);
}
function specVersion(spec) {
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    return scalar(spec.version);
  }
  if (Array.isArray(spec)) {
    for (const item of spec) {
      if (item && typeof item === "object" && item.version != null) {
        return scalar(item.version);
      }
    }
    return MISSING;
  }
  return scalar(spec);
}
function parseRequirement(raw) {
  let line = raw.split("#", 1)[0].trim();
  line = line.replace(/\\+$/, "").trim();
  if (!line || line.startsWith("-") || line.startsWith(".") || line.startsWith("/")) {
    return ["", ""];
  }
  line = line.split(";", 1)[0].trim();
  const match = REQ_SPLIT.exec(line);
  if (!match) {
    return REQ_NAME.test(line) ? [line, MISSING] : ["", ""];
  }
  const name = line.slice(0, match.index).trim();
  if (!REQ_NAME.test(name))
    return ["", ""];
  const rest = line.slice(match.index);
  const version = rest.replace(/\[[^\]]*\]/g, "").trim();
  return [name, version || MISSING];
}

class Detector {
  root;
  map = new Map;
  notes = [];
  constructor(root) {
    this.root = root;
  }
  get rows() {
    const out = [];
    for (const [key, ver] of this.map) {
      const tab = key.indexOf("\x00");
      out.push([key.slice(0, tab), key.slice(tab + 1), ver]);
    }
    return out;
  }
  emit(ecosystem, name, version) {
    if (name)
      this.map.set(`${ecosystem}\x00${name}`, version || MISSING);
  }
  note(msg) {
    this.notes.push(msg);
  }
  async readToml(name) {
    const body = await readText(join(this.root, name));
    if (body === null)
      return null;
    try {
      const data = parse(body);
      return data && typeof data === "object" ? data : null;
    } catch (exc) {
      this.note(`detect: ${name} is unreadable (${exc}); skipping`);
      return null;
    }
  }
  async readJson(name) {
    const body = await readText(join(this.root, name));
    if (body === null)
      return null;
    try {
      const data = JSON.parse(body);
      return data && typeof data === "object" && !Array.isArray(data) ? data : null;
    } catch (exc) {
      this.note(`detect: ${name} is unreadable (${exc}); skipping`);
      return null;
    }
  }
  async readLines(name) {
    const body = await readText(join(this.root, name));
    if (body === null)
      return null;
    return body.split(/\r?\n/);
  }
  async scanNode() {
    const data = await this.readJson("package.json");
    if (!data)
      return;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const block = data[field];
      if (!block || typeof block !== "object" || Array.isArray(block))
        continue;
      for (const [name, spec] of Object.entries(block)) {
        this.emit("npm", name, scalar(spec));
      }
    }
  }
  async scanPython() {
    for (const lock of ["uv.lock", "poetry.lock"]) {
      const data2 = await this.readToml(lock);
      if (!data2)
        continue;
      const pkgs = data2.package;
      if (Array.isArray(pkgs)) {
        for (const entry of pkgs) {
          if (!entry || typeof entry !== "object")
            continue;
          const rec = entry;
          if (typeof rec.name === "string" && typeof rec.version === "string") {
            this.emit("pypi", rec.name, rec.version);
          }
        }
      }
      return;
    }
    const lines = await this.readLines("requirements.txt");
    if (lines) {
      for (const raw of lines) {
        const [name, version] = parseRequirement(raw);
        this.emit("pypi", name, version);
      }
      return;
    }
    const data = await this.readToml("pyproject.toml");
    if (!data)
      return;
    this.scanPep621(data.project);
    this.scanDependencyGroups(data["dependency-groups"]);
    const tool = data.tool;
    if (tool && typeof tool === "object") {
      this.scanPoetry(tool.poetry);
    }
  }
  scanPep621(project) {
    if (!project || typeof project !== "object")
      return;
    const p = project;
    for (const req of p.dependencies || []) {
      if (typeof req === "string") {
        const [name, version] = parseRequirement(req);
        this.emit("pypi", name, version);
      }
    }
    const extras = p["optional-dependencies"];
    if (extras && typeof extras === "object") {
      for (const reqs of Object.values(extras)) {
        for (const req of reqs || []) {
          if (typeof req === "string") {
            const [name, version] = parseRequirement(req);
            this.emit("pypi", name, version);
          }
        }
      }
    }
  }
  scanDependencyGroups(groups) {
    if (!groups || typeof groups !== "object")
      return;
    for (const reqs of Object.values(groups)) {
      for (const req of reqs || []) {
        if (typeof req === "string") {
          const [name, version] = parseRequirement(req);
          this.emit("pypi", name, version);
        }
      }
    }
  }
  scanPoetry(poetry) {
    if (!poetry || typeof poetry !== "object")
      return;
    const p = poetry;
    const blocks = [p.dependencies, p["dev-dependencies"]];
    const groups = p.group;
    if (groups && typeof groups === "object") {
      for (const group of Object.values(groups)) {
        if (group && typeof group === "object") {
          blocks.push(group.dependencies);
        }
      }
    }
    for (const block of blocks) {
      if (!block || typeof block !== "object" || Array.isArray(block))
        continue;
      for (const [name, spec] of Object.entries(block)) {
        if (name === "python")
          continue;
        this.emit("pypi", name, specVersion(spec));
      }
    }
  }
  async scanRust() {
    const data = await this.readToml("Cargo.toml");
    if (!data)
      return;
    for (const field of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      const block = data[field];
      if (!block || typeof block !== "object" || Array.isArray(block))
        continue;
      for (const [name, spec] of Object.entries(block)) {
        this.emit("cargo", name, specVersion(spec));
      }
    }
  }
  async scanGo() {
    const lines = await this.readLines("go.mod");
    if (!lines)
      return;
    let inBlock = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (line.startsWith("require (") || line === "require(") {
        inBlock = true;
        continue;
      }
      if (line.startsWith(")")) {
        inBlock = false;
        continue;
      }
      if (line.startsWith("require ")) {
        const fields = line.split(/\s+/);
        this.emit("go", fields[1] ?? "", fields[2] ?? MISSING);
        continue;
      }
      if (inBlock) {
        if (!line || line.startsWith("//"))
          continue;
        const fields = line.split(/\s+/);
        this.emit("go", fields[0] ?? "", fields[1] ?? MISSING);
      }
    }
  }
  async scanRuby() {
    const lines = await this.readLines("Gemfile");
    if (!lines)
      return;
    for (const raw of lines) {
      const match = GEM.exec(raw);
      if (match)
        this.emit("rubygems", match[2], match[4] || MISSING);
    }
  }
  async scanPhp() {
    const data = await this.readJson("composer.json");
    if (!data)
      return;
    for (const field of ["require", "require-dev"]) {
      const block = data[field];
      if (!block || typeof block !== "object" || Array.isArray(block))
        continue;
      for (const [rawName, spec] of Object.entries(block)) {
        const name = String(rawName);
        if (name === "php" || name.startsWith("ext-") || name.startsWith("lib-") || name.includes(" ")) {
          continue;
        }
        this.emit("packagist", name, scalar(spec));
      }
    }
  }
  async scanAll() {
    await this.scanNode();
    await this.scanPython();
    await this.scanRust();
    await this.scanGo();
    await this.scanRuby();
    await this.scanPhp();
  }
}
async function detectProject(target) {
  if (!isDir(target)) {
    return { ok: false, exit: 2, rows: [], stderr: `detect: '${target}' is not a directory` };
  }
  const detector = new Detector(target);
  await detector.scanAll();
  const notes = [...detector.notes];
  notes.push("");
  notes.push(`detect: ${detector.rows.length} dependency declaration(s) found in ${target}`);
  if (detector.rows.length === 0) {
    notes.push("No supported manifest found (package.json, uv.lock, poetry.lock,");
    notes.push("requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile,");
    notes.push("composer.json).");
  }
  return { ok: true, exit: 0, rows: detector.rows, stderr: notes.join(`
`) };
}
function normalizeVersion(raw) {
  if (typeof raw !== "string")
    return null;
  const match = VERSION_HEAD.exec(raw.replace(/^v/, ""));
  if (!match)
    return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}
function isPrerelease(raw) {
  return typeof raw === "string" && PRERELEASE.test(raw);
}
function classify(installed, latest) {
  const cur = normalizeVersion(installed);
  const lat = normalizeVersion(latest);
  if (cur === null || lat === null)
    return "MINOR-CHECK";
  if (cur[0] === lat[0] && cur[1] === lat[1] && cur[2] === lat[2])
    return "CURRENT";
  if (lat[0] > cur[0])
    return "MAJOR-ADVISORY";
  if (lat[0] === cur[0] && lat[1] > cur[1])
    return "MINOR-CHECK";
  if (lat[0] === cur[0] && lat[1] === cur[1] && lat[2] > cur[2])
    return "PATCH-SAFE";
  return "CURRENT";
}
function pickStable(latest, installed, versions) {
  if (!isPrerelease(latest) || isPrerelease(installed))
    return latest;
  const stable = versions.filter((v) => typeof v === "string" && !isPrerelease(v) && normalizeVersion(v));
  if (!stable.length)
    return latest;
  stable.sort((a, b) => {
    const na = normalizeVersion(a);
    const nb = normalizeVersion(b);
    return nb[0] - na[0] || nb[1] - na[1] || nb[2] - na[2];
  });
  return stable[0];
}

class RegistryError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
async function fetchJson(ecosystem, name, url, fixtureDir) {
  const dir = fixtureDir ?? process.env.DEP_UPDATE_FIXTURE_DIR ?? "";
  if (dir) {
    const safe = name.replaceAll("/", "__").replaceAll("@", "__at__");
    const fixture = join(dir, `${ecosystem}_${safe}.json`);
    if (isFile(fixture)) {
      return JSON.parse(await Bun.file(fixture).text());
    }
    throw new RegistryError("fixture not found (offline simulation)");
  }
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok)
    throw new RegistryError(`HTTP ${res.status}`, res.status);
  return await res.json();
}
async function queryRegistry(ecosystem, name, installed, fixtureDir) {
  const result = { ecosystem, name, installed, status: "UNRESOLVABLE" };
  try {
    let latest = "";
    let candidates = [];
    if (ecosystem === "pypi") {
      const data = await fetchJson(ecosystem, name, `https://pypi.org/pypi/${name}/json`, fixtureDir);
      const info = data.info;
      const ver = info?.version;
      if (typeof ver !== "string" || !ver) {
        result.reason = "no info.version";
        return result;
      }
      latest = ver;
      const releases = data.releases ?? {};
      const files = releases[latest] || [];
      if (files.length && files.every((f) => f.yanked)) {
        result.status = "DISCONFIRMED";
        result.latest = latest;
        result.reason = "all files for latest are yanked on PyPI";
        result.class = "DISCONFIRMED";
        return result;
      }
      candidates = Object.keys(releases);
    } else if (ecosystem === "npm" || ecosystem === "node") {
      const data = await fetchJson(ecosystem, name, `https://registry.npmjs.org/${name}`, fixtureDir);
      const tags = data["dist-tags"] ?? {};
      const ver = tags.latest;
      if (typeof ver !== "string" || !ver) {
        result.reason = "no dist-tags.latest";
        return result;
      }
      latest = ver;
      candidates = Object.keys(data.versions ?? {});
    } else {
      result.reason = `registry fetch not implemented for ${ecosystem} (advisory-only)`;
      return result;
    }
    latest = pickStable(latest, installed, candidates);
    const verdict = classify(installed, latest);
    result.latest = latest;
    result.status = verdict === "CURRENT" ? "CURRENT" : "OK";
    result.class = verdict;
    return result;
  } catch (exc) {
    if (exc instanceof RegistryError && exc.code !== undefined) {
      result.reason = exc.code === 401 || exc.code === 403 ? "auth-required" : `HTTP ${exc.code}`;
      return result;
    }
    if (exc instanceof RegistryError) {
      result.reason = `network error: ${exc.message}`;
      return result;
    }
    result.reason = exc instanceof Error ? exc.message : String(exc);
    return result;
  }
}
async function researchProject(target, fixtureDir) {
  if (!isDir(target)) {
    return { exit: 2, records: [], stderr: `research: '${target}' is not a directory` };
  }
  const notes = ["dep-update/research: querying registries...", ""];
  const detected = await detectProject(target);
  const tallies = { OK: 0, CURRENT: 0, UNRESOLVABLE: 0, DISCONFIRMED: 0 };
  const records = [];
  for (const [ecosystem, name, installed] of detected.rows) {
    if (!ecosystem || !name)
      continue;
    const record = await queryRegistry(ecosystem, name, installed, fixtureDir);
    records.push(record);
    const status = record.status;
    if (status in tallies)
      tallies[status] += 1;
  }
  const unresolvable = tallies.UNRESOLVABLE + tallies.DISCONFIRMED;
  notes.push("");
  notes.push(`dep-update/research: ${records.length} dep(s) queried`);
  notes.push(`  classified:    ${tallies.OK}`);
  notes.push(`  already-current: ${tallies.CURRENT}`);
  notes.push(`  unresolvable:  ${unresolvable}`);
  if (records.length > 0 && tallies.OK === 0 && tallies.CURRENT === 0 && unresolvable === records.length) {
    notes.push("");
    notes.push("WARNING: all registry queries failed - no registry access or all deps are private.");
    notes.push("No upgrade plan can be produced. Check your network connection and retry.");
  }
  return { exit: 0, records, stderr: notes.join(`
`) };
}
function canonical(name) {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}
function which(bin) {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const cand = `${dir}/${bin}`;
    try {
      if (statSync(cand).isFile())
        return cand;
    } catch {}
  }
  return null;
}
async function readTomlFile(path) {
  const body = await readText(path);
  if (body === null)
    return null;
  try {
    return parse(body);
  } catch {
    return null;
  }
}
async function detectNodePm(root) {
  const override = process.env.DEP_UPDATE_PKG_MANAGER ?? "";
  if (override)
    return override;
  const answers = join(root, ".project-setup/answers.toml");
  if (isFile(answers)) {
    try {
      const data = await readTomlFile(answers);
      const module = data?.module ?? {};
      const langTs = module["lang-ts"] ?? {};
      const pinned = langTs.package_manager || langTs.package_manager_pin || "";
      if (pinned)
        return String(pinned).split("@")[0].trim();
    } catch {}
  }
  if (isFile(join(root, "pnpm-lock.yaml")))
    return "pnpm";
  if (isFile(join(root, "bun.lock")) || isFile(join(root, "bun.lockb")))
    return "bun";
  if (isFile(join(root, "yarn.lock")))
    return "yarn";
  return "npm";
}
function splitPin(requirement) {
  const body = requirement.split(";", 1)[0].trim();
  if (!body.includes("=="))
    return ["", ""];
  const idx = body.indexOf("==");
  const name = body.slice(0, idx).replace(/\[[^\]]*\]/g, "").trim();
  return [name, body.slice(idx + 2).trim()];
}
function pyprojectRequirements(data) {
  const out = [];
  const project = data.project;
  if (project && typeof project === "object") {
    const p = project;
    for (const r of p.dependencies || [])
      if (typeof r === "string")
        out.push(r);
    const extras = p["optional-dependencies"];
    if (extras && typeof extras === "object") {
      for (const reqs of Object.values(extras)) {
        for (const r of reqs || [])
          if (typeof r === "string")
            out.push(r);
      }
    }
  }
  const groups = data["dependency-groups"];
  if (groups && typeof groups === "object") {
    for (const reqs of Object.values(groups)) {
      for (const r of reqs || [])
        if (typeof r === "string")
          out.push(r);
    }
  }
  return out;
}
async function checkPythonVersion(root, name, version) {
  const wanted = canonical(name);
  const pyproject = join(root, "pyproject.toml");
  if (isFile(pyproject)) {
    const data = await readTomlFile(pyproject);
    if (data) {
      for (const requirement of pyprojectRequirements(data)) {
        const [reqName, reqVersion] = splitPin(requirement);
        if (reqName && canonical(reqName) === wanted && reqVersion === version)
          return true;
      }
    }
  }
  const requirements = join(root, "requirements.txt");
  if (isFile(requirements)) {
    const text = await readText(requirements) ?? "";
    for (const raw of text.split(/\r?\n/)) {
      const [reqName, reqVersion] = splitPin(raw.split("#", 1)[0].trim());
      if (reqName && canonical(reqName) === wanted && reqVersion === version)
        return true;
    }
  }
  const lock = join(root, "uv.lock");
  if (isFile(lock)) {
    const data = await readTomlFile(lock);
    if (!data)
      return false;
    for (const entry of data.package || []) {
      if (!entry || typeof entry !== "object")
        continue;
      const rec = entry;
      if (canonical(String(rec.name ?? "")) === wanted)
        return rec.version === version;
    }
    return false;
  }
  return false;
}
async function checkNodeVersion(root, name, version) {
  const manifest = join(root, "package.json");
  if (!isFile(manifest))
    return false;
  try {
    const data = JSON.parse(await readText(manifest) ?? "");
    if (!data || typeof data !== "object")
      return false;
    const rec = data;
    const accepted = new Set([version, `^${version}`, `~${version}`, `=${version}`]);
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const block = rec[section];
      if (!block || typeof block !== "object")
        continue;
      const declared = block[name];
      if (typeof declared === "string" && accepted.has(declared))
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
async function runPm(command, root) {
  const log = `==> ${command.join(" ")}`;
  const proc = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, log: [log, stdout, stderr].filter(Boolean).join(`
`) };
}
async function applyBump(ecosystem, name, version, root) {
  if (!isDir(root)) {
    return { exit: 2, text: `ERROR: '${root}' is not a directory` };
  }
  if (PROTECTED_NAME.test(name)) {
    return { exit: 2, text: "ERROR: refusing to touch project-setup files" };
  }
  const lines = [`dep-update/apply: ${ecosystem} ${name} -> ${version}`];
  if (ecosystem === "pypi" || ecosystem === "python") {
    if (!which("uv")) {
      lines.push("SKIP: uv not found. To apply manually:");
      lines.push(`  uv add "${name}==${version}"`);
      lines.push(`  (or: pip install "${name}==${version}" and update your requirements file)`);
      return { exit: 0, text: lines.join(`
`) };
    }
    const ran = await runPm(["uv", "add", `${name}==${version}`], root);
    lines.push(ran.log);
    if (ran.code !== 0) {
      lines.push(`WARN: uv exited with status ${ran.code}; bump was not confirmed`);
      return { exit: 1, text: lines.join(`
`) };
    }
    const landed = await checkPythonVersion(root, name, version);
    if (landed) {
      lines.push(`OK: ${name} confirmed at ${version}`);
      return { exit: 0, text: lines.join(`
`) };
    }
    lines.push(`WARN: ${name}: post-apply manifest check failed - version may not have landed`);
    return { exit: 1, text: lines.join(`
`) };
  }
  if (["npm", "node", "pnpm", "yarn", "bun"].includes(ecosystem)) {
    let pm = await detectNodePm(root);
    const cmds = {
      pnpm: ["pnpm", "update", name, "--version", version],
      bun: ["bun", "add", `${name}@${version}`],
      yarn: ["yarn", "add", `${name}@${version}`],
      npm: ["npm", "install", `${name}@${version}`]
    };
    if (!(pm in cmds))
      pm = "npm";
    const command = cmds[pm];
    if (!which(pm)) {
      lines.push(`SKIP: ${pm} not found. To apply manually:`);
      lines.push(`  ${command.join(" ")}`);
      return { exit: 0, text: lines.join(`
`) };
    }
    const ran = await runPm(command, root);
    lines.push(ran.log);
    if (ran.code !== 0) {
      lines.push(`WARN: ${pm} exited with status ${ran.code}; bump was not confirmed`);
      return { exit: 1, text: lines.join(`
`) };
    }
    const landed = await checkNodeVersion(root, name, version);
    if (landed) {
      lines.push(`OK: ${name} confirmed at ${version}`);
      return { exit: 0, text: lines.join(`
`) };
    }
    lines.push(`WARN: ${name}: post-apply manifest check failed - version may not have landed`);
    return { exit: 1, text: lines.join(`
`) };
  }
  if (ecosystem === "cargo" || ecosystem === "rust") {
    lines.push("ADVISORY-ONLY: Rust deps are advisory-only in this version.");
    lines.push(`To update manually: cargo update -p ${name} --precise ${version}`);
    return { exit: 0, text: lines.join(`
`) };
  }
  if (ecosystem === "go") {
    lines.push("ADVISORY-ONLY: Go deps are advisory-only in this version.");
    lines.push(`To update manually: go get ${name}@${version} && go mod tidy`);
    return { exit: 0, text: lines.join(`
`) };
  }
  lines.push(`WARN: unknown ecosystem '${ecosystem}'`);
  lines.push(`Cannot apply automatically. Check the registry for ${name}@${version}.`);
  return { exit: 0, text: lines.join(`
`) };
}

// extensions/dep-scan-tool.ts
function depScanTool(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: "dep_scan",
    label: "Dependency Scan",
    description: "Enumerate a project's declared dependencies, query PyPI/npm for the latest versions, and " + "classify every bump as PATCH-SAFE, MINOR-CHECK, or MAJOR-ADVISORY. Read-only: applies " + "nothing. Rust and go deps are enumerated but not classified (advisory-only by policy).",
    parameters: z.object({
      path: z.string().optional().describe("Project root to scan; defaults to the session cwd"),
      offline_fixture_dir: z.string().optional().describe("DEP_UPDATE_FIXTURE_DIR: read registry responses from fixture files instead of the network")
    }),
    approval: "read",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dir = params.path ?? ctx.cwd;
      try {
        const { exit, records, stderr } = await researchProject(dir, params.offline_fixture_dir);
        if (exit !== 0) {
          return {
            content: [{ type: "text", text: `dep_scan failed (exit ${exit}):
${stderr}` }],
            details: { exit, stderr }
          };
        }
        const upgradable = records.filter((r) => r.status === "OK");
        const byClass = new Map;
        for (const r of upgradable) {
          const bucket = byClass.get(r.class ?? "") ?? [];
          bucket.push(r);
          byClass.set(r.class ?? "", bucket);
        }
        const order = ["PATCH-SAFE", "MINOR-CHECK", "MAJOR-ADVISORY"];
        const lines = [];
        for (const cls of order) {
          for (const r of (byClass.get(cls) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
            lines.push(`${cls.padEnd(15)} ${r.name}  ${r.installed} -> ${r.latest}  (${r.ecosystem})`);
          }
        }
        const skipped = records.length - upgradable.length;
        lines.push(`-- ${upgradable.length} upgradable, ${skipped} current/unresolvable --`);
        if (stderr.trim())
          lines.push(stderr.trim());
        return {
          content: [{ type: "text", text: lines.join(`
`) }],
          details: { records, summary: { upgradable: upgradable.length, skipped } }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `dep_scan error: ${message}` }],
          details: { error: message }
        };
      }
    }
  });
  pi.registerTool({
    name: "dep_apply",
    label: "Apply Dependency Bump",
    description: "Apply one confirmed dependency bump via the ecosystem package manager (uv/pnpm/npm/yarn/bun). " + "Cargo and go print an advisory command only. One bump per call.",
    parameters: z.object({
      ecosystem: z.string().describe("pypi, npm, cargo, or go"),
      name: z.string().describe("Package name"),
      version: z.string().describe("Target version to pin"),
      path: z.string().optional().describe("Project root; defaults to session cwd")
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const result = await applyBump(params.ecosystem, params.name, params.version, params.path ?? ctx.cwd);
        return {
          content: [{ type: "text", text: result.text }],
          details: { exit: result.exit }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `dep_apply error: ${message}` }],
          details: { error: message }
        };
      }
    }
  });
}
export {
  classify,
  depScanTool as default,
  detectProject,
  normalizeVersion,
  parseRequirement,
  queryRegistry
};
