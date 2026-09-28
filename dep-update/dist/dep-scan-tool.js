// @bun
// extensions/lib.ts
import { spawn } from "child_process";
import { statSync as statSync2 } from "fs";
import { join as join2 } from "path";

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
import { statSync } from "fs";
var MISSING = "?";
var REQ_SPLIT = /[\[<>=!~;\s]/;
var REQ_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
var GEM = /^\s*gem\s+(['"])([^'"]+)\1(?:\s*,\s*(['"])([^'"]*)\3)?/;
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
  emit(ecosystem, name, declared, resolved = null) {
    if (name)
      this.map.set(`${ecosystem}\x00${name}`, { declared: declared || MISSING, resolved });
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
    for (const lock of ["uv.lock", "poetry.lock"]) {
      const data = await this.readToml(lock);
      if (!data)
        continue;
      const pkgs = data.package;
      if (!Array.isArray(pkgs)) {
        this.note(`detect: ${lock} has no package array; trying declarations`);
        continue;
      }
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
    for (const req of Array.isArray(p.dependencies) ? p.dependencies : []) {
      if (typeof req === "string") {
        const [name, version] = parseRequirement(req);
        this.emit("pypi", name, version);
      }
    }
    const extras = p["optional-dependencies"];
    if (extras && typeof extras === "object") {
      for (const reqs of Object.values(extras)) {
        for (const req of Array.isArray(reqs) ? reqs : []) {
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
      for (const req of Array.isArray(reqs) ? reqs : []) {
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
  notes.push(`Coverage: root declarations only, except uv.lock/poetry.lock${hasPackageLock ? " and package-lock.json" : ""}. Unscanned: ${gaps.join(", ")}.`);
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
// extensions/lib.ts
var USER_AGENT = "dep-update-skill (+https://github.com/srobroek/agentic-packages)";
var FETCH_TIMEOUT_MS = 1e4;
var SCAN_TIMEOUT_MS = 25000;

class ScanDeadlineError extends Error {
  constructor() {
    super("dependency scan aggregate deadline exceeded");
  }
}

class RegistryError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
function ensureDeadline(deadline) {
  if (deadline !== undefined && Date.now() >= deadline)
    throw new ScanDeadlineError;
}
var NODE_VERSION = /^=?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
var PYTHON_VERSION = /^(?:={1,2})?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-_.]?(a|b|rc|alpha|beta|pre|preview)[-_.]?\d*)?(?:[-_.]?post[-_.]?\d*)?(?:[-_.]?(dev)[-_.]?\d*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;
function normalizeVersion(raw, ecosystem = "npm") {
  if (typeof raw !== "string")
    return null;
  const match = (ecosystem === "pypi" ? PYTHON_VERSION : NODE_VERSION).exec(raw);
  if (!match || match[0] !== raw)
    return null;
  const version = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
  return version.every(Number.isSafeInteger) ? version : null;
}
function isPrerelease(raw, ecosystem = "npm") {
  if (typeof raw !== "string" || !normalizeVersion(raw, ecosystem))
    return false;
  const match = (ecosystem === "pypi" ? PYTHON_VERSION : NODE_VERSION).exec(raw);
  return Boolean(match[4] || ecosystem === "pypi" && match[5]);
}
function classify(installed, latest, ecosystem = "npm") {
  const cur = normalizeVersion(installed, ecosystem);
  const lat = normalizeVersion(latest, ecosystem);
  if (cur === null || lat === null)
    return "UNRESOLVABLE";
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
function pickStable(latest, installed, versions, ecosystem = "npm") {
  if (!isPrerelease(latest, ecosystem) || isPrerelease(installed, ecosystem))
    return latest;
  const stable = versions.filter((v) => !isPrerelease(v, ecosystem) && normalizeVersion(v, ecosystem));
  if (!stable.length)
    return latest;
  stable.sort((a, b) => {
    const na = normalizeVersion(a, ecosystem);
    const nb = normalizeVersion(b, ecosystem);
    return nb[0] - na[0] || nb[1] - na[1] || nb[2] - na[2];
  });
  return stable[0] ?? latest;
}
async function fetchJson(ecosystem, name, url, fixtureDir, signal, deadline) {
  signal?.throwIfAborted();
  ensureDeadline(deadline);
  const dir = fixtureDir ?? process.env.DEP_UPDATE_FIXTURE_DIR ?? "";
  if (dir) {
    const safe = name.replaceAll("/", "__").replaceAll("@", "__at__");
    const fixture = join2(dir, `${ecosystem}_${safe}.json`);
    if (isFile(fixture)) {
      const data = JSON.parse(await Bun.file(fixture).text());
      signal?.throwIfAborted();
      ensureDeadline(deadline);
      return data;
    }
    throw new RegistryError("fixture not found (offline simulation)");
  }
  const remaining = deadline === undefined ? FETCH_TIMEOUT_MS : deadline - Date.now();
  if (remaining <= 0)
    throw new ScanDeadlineError;
  const requestDeadline = AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, remaining));
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: signal ? AbortSignal.any([signal, requestDeadline]) : requestDeadline });
  ensureDeadline(deadline);
  if (!res.ok)
    throw new RegistryError(`HTTP ${res.status}`, res.status);
  const data = await res.json();
  signal?.throwIfAborted();
  ensureDeadline(deadline);
  return data;
}
async function queryRegistry(ecosystem, name, installed, fixtureDir, signal, deadline) {
  signal?.throwIfAborted();
  ensureDeadline(deadline);
  const result = { ecosystem, name, installed, status: "UNRESOLVABLE" };
  try {
    let latest = "";
    let candidates = [];
    if (ecosystem === "pypi") {
      const data = await fetchJson(ecosystem, name, `https://pypi.org/pypi/${name}/json`, fixtureDir, signal, deadline);
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
      const data = await fetchJson(ecosystem, name, `https://registry.npmjs.org/${name}`, fixtureDir, signal, deadline);
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
    ensureDeadline(deadline);
    latest = pickStable(latest, installed, candidates, ecosystem);
    const verdict = classify(installed, latest, ecosystem);
    result.latest = latest;
    result.status = verdict === "CURRENT" || verdict === "UNRESOLVABLE" ? verdict : "OK";
    if (verdict === "UNRESOLVABLE")
      result.reason = "Exact versions are required to classify an upgrade; resolve the declaration before applying.";
    result.class = verdict;
    return result;
  } catch (exc) {
    if (exc instanceof ScanDeadlineError)
      throw exc;
    signal?.throwIfAborted();
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
async function researchProject(target, fixtureDir, signal, timeoutMs = SCAN_TIMEOUT_MS) {
  signal?.throwIfAborted();
  const deadline = Date.now() + Math.min(timeoutMs, SCAN_TIMEOUT_MS);
  if (!isDir(target))
    return { exit: 2, records: [], stderr: `research: '${target}' is not a directory`, complete: true };
  const notes = ["dep-update/research: querying registries...", ""];
  const detected = await detectProject(target);
  ensureDeadline(deadline);
  signal?.throwIfAborted();
  notes.push(detected.stderr);
  const tallies = { OK: 0, CURRENT: 0, UNRESOLVABLE: 0, DISCONFIRMED: 0 };
  const records = [];
  let complete = true;
  for (const { ecosystem, name, declared, resolved } of detected.rows) {
    try {
      signal?.throwIfAborted();
      ensureDeadline(deadline);
      if (!ecosystem || !name)
        continue;
      const record = await queryRegistry(ecosystem, name, resolved ?? declared, fixtureDir, signal, deadline);
      records.push(record);
      const status = record.status;
      if (status in tallies)
        tallies[status] += 1;
    } catch (exc) {
      if (exc instanceof ScanDeadlineError) {
        complete = false;
        break;
      }
      throw exc;
    }
  }
  notes.push("");
  notes.push(`dep-update/research: ${records.length} dep(s) queried${complete ? "" : " before aggregate deadline"}`);
  notes.push(`  classified:    ${tallies.OK}`);
  notes.push(`  already-current: ${tallies.CURRENT}`);
  notes.push(`  unresolvable:  ${tallies.UNRESOLVABLE + tallies.DISCONFIRMED}`);
  if (!complete)
    notes.push("PARTIAL: aggregate scan deadline reached; remaining dependencies were not queried.");
  if (records.length > 0 && tallies.OK === 0 && tallies.CURRENT === 0 && tallies.UNRESOLVABLE + tallies.DISCONFIRMED === records.length) {
    notes.push("");
    notes.push("WARNING: no dependency versions could be classified.");
    notes.push("Resolve declared ranges and inspect each record's reason before planning upgrades.");
  }
  return { exit: 0, records, stderr: notes.join(`
`), complete };
}
function canonical(name) {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}
function which(bin) {
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    const cand = `${dir}/${bin}`;
    try {
      if (statSync2(cand).isFile())
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
function detectNodePm(root) {
  const override = process.env.DEP_UPDATE_PKG_MANAGER ?? "";
  if (override)
    return override;
  if (isFile(join2(root, "pnpm-lock.yaml")))
    return "pnpm";
  if (isFile(join2(root, "bun.lock")) || isFile(join2(root, "bun.lockb")))
    return "bun";
  if (isFile(join2(root, "yarn.lock")))
    return "yarn";
  return "npm";
}
function splitPin(requirement) {
  const body = (requirement.split(";", 1)[0] ?? "").trim();
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
    for (const r of Array.isArray(p.dependencies) ? p.dependencies : [])
      if (typeof r === "string")
        out.push(r);
    const extras = p["optional-dependencies"];
    if (extras && typeof extras === "object") {
      for (const reqs of Object.values(extras)) {
        for (const r of Array.isArray(reqs) ? reqs : [])
          if (typeof r === "string")
            out.push(r);
      }
    }
  }
  const groups = data["dependency-groups"];
  if (groups && typeof groups === "object") {
    for (const reqs of Object.values(groups)) {
      for (const r of Array.isArray(reqs) ? reqs : [])
        if (typeof r === "string")
          out.push(r);
    }
  }
  return out;
}
async function checkPythonVersion(root, name, version) {
  const wanted = canonical(name);
  const pyproject = join2(root, "pyproject.toml");
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
  const requirements = join2(root, "requirements.txt");
  if (isFile(requirements)) {
    const text = await readText(requirements) ?? "";
    for (const raw of text.split(/\r?\n/)) {
      const [reqName, reqVersion] = splitPin((raw.split("#", 1)[0] ?? "").trim());
      if (reqName && canonical(reqName) === wanted && reqVersion === version)
        return true;
    }
  }
  const lock = join2(root, "uv.lock");
  if (isFile(lock)) {
    const data = await readTomlFile(lock);
    if (!data)
      return false;
    for (const entry of Array.isArray(data.package) ? data.package : []) {
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
  const manifest = join2(root, "package.json");
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
      if (!block || typeof block !== "object" || Array.isArray(block) || !Object.hasOwn(block, name))
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
async function runPm(command, root, options) {
  if (options.signal?.aborted)
    return { code: 1, log: "Cancelled before spawn; no changes made." };
  const schedule = options.setTimeout ?? setTimeout;
  const clear = options.clearTimer ?? clearTimeout;
  return new Promise((resolve) => {
    const executable = command[0];
    if (!executable) {
      resolve({ code: 1, log: "No package manager command provided" });
      return;
    }
    const proc = spawn(executable, command.slice(1), {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const chunks = [];
    const limit = Math.max(1, Math.min(options.maxOutputBytes ?? 65536, 65536));
    let bytes = 0;
    let stopped = "";
    let settled = false;
    let cleanup;
    const kill = () => {
      try {
        if (process.platform !== "win32" && proc.pid)
          process.kill(-proc.pid, "SIGKILL");
        else
          proc.kill("SIGKILL");
      } catch {}
    };
    const finish = (code) => {
      if (settled)
        return;
      settled = true;
      clear(deadline);
      if (cleanup)
        clear(cleanup);
      options.signal?.removeEventListener("abort", abort);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      resolve({
        code,
        log: [
          `==> ${command.join(" ")}`,
          Buffer.concat(chunks).toString("utf8"),
          stopped && `${stopped}; partial dependency changes may remain. Inspect manifests and lockfiles before retrying.`
        ].filter(Boolean).join(`
`)
      });
    };
    const stop = (reason) => {
      if (stopped || settled)
        return;
      stopped = reason;
      kill();
      cleanup = schedule(() => finish(1), 1000);
    };
    const abort = () => stop("Cancelled");
    const deadline = schedule(() => stop("Package manager deadline exceeded; partial dependency changes may remain and were reported"), Math.max(1, Math.min(options.timeoutMs ?? 25000, 25000)));
    const collect = (chunk) => {
      const remaining = limit - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(Buffer.from(kept));
        bytes += kept.length;
      }
      if (chunk.length > remaining)
        stop("Package manager output limit exceeded");
    };
    proc.stdout.on("data", collect);
    proc.stderr.on("data", collect);
    proc.on("error", () => {
      stopped = "Package manager failed to start";
      finish(1);
    });
    proc.on("close", (code) => finish(stopped ? 1 : code ?? 1));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted)
      abort();
  });
}
function validOperands(ecosystem, name, version) {
  const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (["npm", "node", "pnpm", "yarn", "bun"].includes(ecosystem)) {
    return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214 && semver.test(version);
  }
  if (ecosystem === "pypi" || ecosystem === "python") {
    return REQ_NAME.test(name) && /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i.test(version);
  }
  if (ecosystem === "cargo" || ecosystem === "rust")
    return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) && semver.test(version);
  if (ecosystem === "go")
    return /^[A-Za-z0-9][A-Za-z0-9._~/-]*$/.test(name) && semver.test(version.replace(/^v/, ""));
  return false;
}
async function applyBump(ecosystem, name, version, root, options = {}) {
  if (!validOperands(ecosystem, name, version))
    return { exit: 2, text: "ERROR: unsupported ecosystem, package name, or exact version; no process started" };
  if (options.signal?.aborted)
    return { exit: 1, text: "Cancelled before spawn; no changes made." };
  if (!isDir(root)) {
    return { exit: 2, text: `ERROR: '${root}' is not a directory` };
  }
  const lines = [`dep-update/apply: ${ecosystem} ${name} -> ${version}`];
  if (ecosystem === "pypi" || ecosystem === "python") {
    if (!which("uv")) {
      lines.push("ERROR: uv not found; cannot apply dependency bump");
      lines.push(`  uv add "${name}==${version}"`);
      lines.push(`  (or: pip install "${name}==${version}" and update your requirements file)`);
      return { exit: 1, text: lines.join(`
`) };
    }
    const ran = await runPm(["uv", "add", `${name}==${version}`], root, options);
    lines.push(ran.log);
    if (ran.code !== 0) {
      lines.push(`WARN: uv exited with status ${ran.code}; partial changes may remain; bump was not confirmed`);
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
    let pm = detectNodePm(root);
    const cmds = {
      pnpm: ["pnpm", "update", `${name}@${version}`],
      bun: ["bun", "add", `${name}@${version}`],
      yarn: ["yarn", "add", `${name}@${version}`],
      npm: ["npm", "install", `${name}@${version}`]
    };
    if (!Object.hasOwn(cmds, pm))
      pm = "npm";
    const command = cmds[pm];
    if (!command)
      return { exit: 1, text: lines.join(`
`) };
    if (!which(pm)) {
      lines.push(`ERROR: ${pm} not found; cannot apply dependency bump`);
      lines.push(`  ${command.join(" ")}`);
      return { exit: 1, text: lines.join(`
`) };
    }
    const ran = await runPm(command, root, options);
    lines.push(ran.log);
    if (ran.code !== 0) {
      lines.push(`WARN: ${pm} exited with status ${ran.code}; partial changes may remain; bump was not confirmed`);
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
    description: "Enumerate a project's declared dependencies, query PyPI/npm for the latest versions, and " + "classify exact-version bumps as PATCH-SAFE, MINOR-CHECK, or MAJOR-ADVISORY. " + "Read-only; each scan has a 25 s aggregate deadline inside the 30 s tool_call budget and " + "returns a partial report when a large manifest exceeds it. Rust and go deps are advisory-only.",
    parameters: z.object({
      path: z.string().optional().describe("Project root to scan; defaults to the session cwd"),
      offline_fixture_dir: z.string().optional().describe("DEP_UPDATE_FIXTURE_DIR: read registry responses from fixture files instead of the network")
    }),
    approval: "read",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const dir = params.path ?? ctx.cwd;
      try {
        const { exit, records, stderr, complete } = await researchProject(dir, params.offline_fixture_dir, signal);
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
        for (const record of records) {
          if (record.status === "UNRESOLVABLE" || record.status === "DISCONFIRMED") {
            lines.push(`${record.status.padEnd(15)} ${record.name}  ${record.installed} -> ${record.latest ?? "unknown"}  (${record.ecosystem}): ${record.reason ?? "not classified"}`);
          }
        }
        const skipped = records.length - upgradable.length;
        lines.push(`-- ${upgradable.length} upgradable, ${skipped} current/unresolvable --`);
        if (stderr.trim())
          lines.push(stderr.trim());
        return {
          content: [{ type: "text", text: lines.join(`
`) }],
          details: { records, complete, summary: { upgradable: upgradable.length, skipped } }
        };
      } catch (error) {
        signal?.throwIfAborted();
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
    description: "Apply one confirmed dependency bump via the ecosystem package manager. " + "The mutation is bounded to 25 s inside the 30 s tool_call budget; if interrupted, " + "the result reports that partial changes may remain so the caller can inspect manifests and lockfiles.",
    parameters: z.object({
      ecosystem: z.string().describe("pypi, npm, cargo, or go"),
      name: z.string().describe("Package name"),
      version: z.string().describe("Target version to pin"),
      path: z.string().optional().describe("Project root; defaults to session cwd")
    }),
    approval: { tier: "exec", policy: "prompt" },
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        if (signal?.aborted)
          throw new Error("Cancelled before approval; no process started");
        if (!ctx.hasUI)
          throw new Error("Interactive approval is required; no process started");
        const approved = await ctx.ui.confirm("Apply dependency bump", `${params.ecosystem}: ${params.name} -> ${params.version}
Project: ${params.path ?? ctx.cwd}
Package-manager failure or cancellation can leave partial changes.`, { signal, timeout: 20000 });
        if (!approved)
          throw new Error("Dependency bump denied; no process started");
        const result = await applyBump(params.ecosystem, params.name, params.version, params.path ?? ctx.cwd, {
          signal,
          setTimeout: ctx.setTimeout.bind(ctx),
          clearTimer: ctx.clearTimer.bind(ctx)
        });
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
