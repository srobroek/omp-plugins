// @bun
// extensions/detect.ts
import { statSync } from "fs";

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
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
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
  static x(message, ctx, ptr) {
    throw new TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
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
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (;ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0;j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = hex >= 48 && hex <= 57 ? hex - 48 : hex >= 65 && hex <= 70 ? hex - 65 + 10 : hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1;
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "\t";
        else if (c === 110)
          parsed += `
`;
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
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
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;

class TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
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
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
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
    if (this.#offset === "Z" || this.#offset === "z")
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
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || delim && (char === delim || char === 44) || char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {} else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
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
function skipComment(ctx) {
  for (;ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
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
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = Object.create(null);
  let seen = new Set;
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0;i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(ctx, 125);
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(ctx, 93));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
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
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0;i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = Object.create(null);
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
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: Object.create(null)
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
    t[k].push(t = Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1000,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = Object.create(null);
  let meta = Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(ctx, 93);
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(ctx, k, res, meta, isTableArray ? 2 : 1);
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(ctx, k, tbl, m, 0);
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, undefined);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
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
var HAS_WELLFORMED = !!"".isWellFormed;

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

// extensions/detect.ts
var MISSING = "?";
var REQ_SPLIT = /[\[<>=!~;\s]/;
var REQ_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
var GEM = /^\s*gem\s+(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?/;
function canonical(name) {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}
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
function isLocalLockEntry(rec) {
  if (rec.develop === true)
    return true;
  const source = rec.source;
  if (!source || typeof source !== "object" || Array.isArray(source))
    return false;
  const s = source;
  if (s.editable !== undefined || s.virtual !== undefined || s.directory !== undefined || s.path !== undefined)
    return true;
  return s.type === "directory" || s.type === "file";
}
function parseRequirement(raw) {
  const first = raw.split("#", 1)[0];
  if (first === undefined)
    return ["", ""];
  let line = first.trim();
  line = line.replace(/\\+$/, "").trim();
  if (!line || line.startsWith("-") || line.startsWith(".") || line.startsWith("/")) {
    return ["", ""];
  }
  const beforeSemicolon = line.split(";", 1)[0];
  if (beforeSemicolon === undefined)
    return ["", ""];
  line = beforeSemicolon.trim();
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
    for (const [key, versions] of this.map) {
      const tab = key.indexOf("\x00");
      out.push({ ecosystem: key.slice(0, tab), name: key.slice(tab + 1), ...versions });
    }
    return out;
  }
  emit(ecosystem, name, declared, resolved = null, direct = true) {
    if (name)
      this.map.set(`${ecosystem}\x00${name}`, { declared: declared || MISSING, resolved, direct });
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
    const lock = await this.readJson("package-lock.json");
    const locked = new Map;
    const packages = lock?.packages;
    if (packages && typeof packages === "object" && !Array.isArray(packages)) {
      for (const [path, entry] of Object.entries(packages)) {
        if (!path.startsWith("node_modules/") || !entry || typeof entry !== "object")
          continue;
        const version = entry.version;
        if (typeof version === "string")
          locked.set(path.slice("node_modules/".length), version);
      }
    } else if (lock) {
      this.note("detect: package-lock.json has no packages map; declared Node versions remain unresolved");
    }
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const block = data[field];
      if (!block || typeof block !== "object" || Array.isArray(block))
        continue;
      for (const [name, spec] of Object.entries(block)) {
        this.emit("npm", name, scalar(spec), locked.get(name) ?? null);
      }
    }
  }
  async scanPython() {
    const declared = new Map;
    const declare = (name, spec) => {
      if (!name || /^@\s*file:/i.test(spec))
        return;
      const key = canonical(name);
      if (!declared.has(key))
        declared.set(key, [name, spec]);
    };
    const pyproject = await this.readToml("pyproject.toml");
    if (pyproject) {
      this.scanPep621(pyproject.project, declare);
      this.scanDependencyGroups(pyproject["dependency-groups"], declare);
      const tool = pyproject.tool;
      if (tool && typeof tool === "object") {
        this.scanPoetry(tool.poetry, declare);
      }
    }
    if (declared.size === 0) {
      for (const raw of await this.readLines("requirements.txt") ?? []) {
        const [name, version] = parseRequirement(raw);
        declare(name, version);
      }
    }
    const locked = new Map;
    const local = new Set;
    for (const lock of ["uv.lock", "poetry.lock"]) {
      const data = await this.readToml(lock);
      if (!data)
        continue;
      const pkgs = data.package;
      if (!Array.isArray(pkgs)) {
        this.note(`detect: ${lock} has no package array; Python versions remain unresolved`);
        continue;
      }
      for (const entry of pkgs) {
        if (!entry || typeof entry !== "object")
          continue;
        const rec = entry;
        if (typeof rec.name !== "string" || typeof rec.version !== "string")
          continue;
        const key = canonical(rec.name);
        if (isLocalLockEntry(rec))
          local.add(key);
        else if (!locked.has(key))
          locked.set(key, [rec.name, rec.version]);
      }
      break;
    }
    for (const [key, [name, spec]] of declared) {
      if (!local.has(key))
        this.emit("pypi", name, spec, locked.get(key)?.[1] ?? null);
    }
    for (const [key, [name, version]] of locked) {
      if (!declared.has(key))
        this.emit("pypi", name, MISSING, version, false);
    }
  }
  scanPep621(project, declare) {
    if (!project || typeof project !== "object")
      return;
    const p = project;
    for (const req of Array.isArray(p.dependencies) ? p.dependencies : []) {
      if (typeof req === "string")
        declare(...parseRequirement(req));
    }
    const extras = p["optional-dependencies"];
    if (extras && typeof extras === "object") {
      for (const reqs of Object.values(extras)) {
        for (const req of Array.isArray(reqs) ? reqs : []) {
          if (typeof req === "string")
            declare(...parseRequirement(req));
        }
      }
    }
  }
  scanDependencyGroups(groups, declare) {
    if (!groups || typeof groups !== "object")
      return;
    for (const reqs of Object.values(groups)) {
      for (const req of Array.isArray(reqs) ? reqs : []) {
        if (typeof req === "string")
          declare(...parseRequirement(req));
      }
    }
  }
  scanPoetry(poetry, declare) {
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
        if (spec && typeof spec === "object" && !Array.isArray(spec) && "path" in spec)
          continue;
        declare(name, specVersion(spec));
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
      if (match?.[2])
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
  if (!isDir(target))
    return { ok: false, exit: 2, rows: [], stderr: `detect: '${target}' is not a directory`, coverage: { gaps: [] } };
  const detector = new Detector(target);
  await detector.scanAll();
  const gaps = ["Cargo.lock", "go.sum", "Pipfile.lock", "Ruby/PHP lockfiles", "workspace children"];
  const hasPackageLock = isFile(join(target, "package-lock.json"));
  if (!hasPackageLock)
    gaps.unshift("Node lockfiles");
  const notes = [...detector.notes];
  notes.push(`Coverage: root declarations; resolved versions from uv.lock/poetry.lock${hasPackageLock ? " and package-lock.json" : ""}; undeclared Python lock entries listed as transitive (direct=false). Unscanned: ${gaps.join(", ")}.`);
  notes.push("");
  notes.push(`detect: ${detector.rows.length} dependency declaration(s) found in ${target}`);
  if (detector.rows.length === 0) {
    notes.push("No supported manifest found (package.json, uv.lock, poetry.lock,");
    notes.push("requirements.txt, pyproject.toml, Cargo.toml, go.mod, Gemfile,");
    notes.push("composer.json).");
  }
  return { ok: true, exit: 0, rows: detector.rows, stderr: notes.join(`
`), coverage: { gaps } };
}

// extensions/version-gap-tool.ts
function versionGapTool(pi) {
  const z = pi.zod;
  pi.registerTool({
    name: "version_gap_scan",
    label: "Version Gap Scan",
    description: "Enumerate a project's root dependencies, offline and read-only: npm (package.json + package-lock.json), " + "Python (pyproject.toml or requirements.txt + uv.lock/poetry.lock), Cargo.toml, go.mod, Gemfile, composer.json. " + "One tab-separated row per dependency: ecosystem, name, declared spec, resolved lockfile version ('?' when " + "unlocked), direct|transitive. Use resolved as the installed version when present. Input for what's-new research.",
    parameters: z.object({
      path: z.string().optional().describe("Project root to scan; defaults to the session cwd")
    }),
    approval: "read",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dir = params.path ?? ctx.cwd;
      try {
        const { exit, rows, stderr, coverage } = await detectProject(dir);
        if (exit !== 0) {
          return {
            content: [{ type: "text", text: `version_gap_scan failed (exit ${exit}):
${stderr}` }],
            details: { exit, stderr }
          };
        }
        const deps = rows.map(({ ecosystem, name, declared, resolved, direct }) => ({ ecosystem, name, declared, resolved, direct }));
        const stdout = rows.map(({ ecosystem, name, declared, resolved, direct }) => [ecosystem, name, declared, resolved ?? "?", direct ? "direct" : "transitive"].join("\t")).join(`
`);
        const text = [stdout, stderr.trim()].filter(Boolean).join(`
`);
        return {
          content: [{ type: "text", text }],
          details: { deps, coverage, count: deps.length }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `version_gap_scan error: ${message}` }],
          details: { error: message }
        };
      }
    }
  });
}
export {
  versionGapTool as default,
  detectProject,
  parseRequirement
};
