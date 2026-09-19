// @bun
// extensions/shell-tokenizer.ts
var SEPARATORS = new Set([";", "&", "|", "(", ")", `
`]);
function token(value, startsQuoted = false, sawQuote = false) {
  return { value, startsQuoted, sawQuote };
}
function tokenizeShell(command, options = {}) {
  const out = [];
  let current = "";
  let started = false;
  let startsQuoted = false;
  let sawQuote = false;
  let quote = null;
  const pending = [];
  const flush = () => {
    if (!started)
      return;
    out.push(token(current, startsQuoted, sawQuote));
    current = "";
    started = false;
    startsQuoted = false;
    sawQuote = false;
  };
  for (let i = 0;i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (!started)
        startsQuoted = true;
      started = true;
      sawQuote = true;
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (options.preserveBackslashes)
        current += ch;
      current += command[++i];
      started = true;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      flush();
      out.push(token("$("));
      i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<" && command[i + 2] === "<") {
      flush();
      out.push(token("<<<"));
      i += 2;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      const operator = hereDocumentOperator(command, i);
      if (operator !== null) {
        flush();
        pending.push(operator);
        i = operator.end - 1;
        continue;
      }
    }
    if (ch === `
`) {
      flush();
      out.push(token(ch));
      let bodyStart = i + 1;
      while (pending.length > 0) {
        const document = pending.shift();
        if (document === undefined)
          break;
        const body = hereDocumentBody(command, bodyStart, document);
        if (!document.quoted) {
          out.push(...tokenizeShell(command.slice(bodyStart, body.bodyEnd), options));
        }
        i = body.terminatorEnd;
        bodyStart = i + 1;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (SEPARATORS.has(ch)) {
      flush();
      out.push(token(ch));
      continue;
    }
    current += ch;
    started = true;
  }
  flush();
  return out;
}
function hereDocumentOperator(command, start) {
  let i = start + 2;
  const stripTabs = command[i] === "-";
  if (stripTabs)
    i++;
  while (command[i] === " " || command[i] === "\t")
    i++;
  let delimiter = "";
  let quoted = false;
  let quote = null;
  while (i < command.length) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        i++;
        continue;
      }
      delimiter += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoted = true;
      quote = ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      quoted = true;
      delimiter += command[i + 1];
      i += 2;
      continue;
    }
    if (/\s|[;&|<>()]/.test(ch))
      break;
    delimiter += ch;
    i++;
  }
  if (quote !== null || delimiter.length === 0)
    return null;
  return { delimiter, stripTabs, quoted, end: i };
}
function hereDocumentBody(command, from, document) {
  let cursor = from;
  while (cursor < command.length) {
    let next = command.indexOf(`
`, cursor);
    if (next === -1)
      next = command.length;
    let line = command.slice(cursor, next);
    if (document.stripTabs)
      line = line.replace(/^\t+/, "");
    if (line === document.delimiter)
      return { bodyEnd: cursor, terminatorEnd: next };
    if (next === command.length)
      break;
    cursor = next + 1;
  }
  return { bodyEnd: command.length, terminatorEnd: command.length };
}

// extensions/shell-command.ts
function commandFromInput(input) {
  if (!input || typeof input !== "object")
    return "";
  const value = input;
  if (typeof value.command === "string")
    return value.command;
  if (typeof value.cmd === "string")
    return value.cmd;
  return "";
}
var settingsCache = new Map;
// extensions/bd-close-gate.ts
function tokenize(command) {
  return tokenizeShell(command).map(({ value }) => value);
}

// extensions/claim-before-branch.ts
var SEPARATORS2 = new Set([";", "&", "|", "(", ")", "$(", `
`]);
var ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
var HELP_OR_VERSION = new Set(["--help", "-h", "--version", "-V"]);
function hasUnclaimedBranchCreation(command) {
  const tokens = tokenize(command);
  let i = 0;
  while (i < tokens.length) {
    while (i < tokens.length && SEPARATORS2.has(tokens[i]))
      i++;
    if (i >= tokens.length)
      break;
    const end = (() => {
      let j = i;
      while (j < tokens.length && !SEPARATORS2.has(tokens[j]))
        j++;
      return j;
    })();
    const segment = tokens.slice(i, end);
    i = end;
    let k = 0;
    while (k < segment.length && ENV_ASSIGNMENT.test(segment[k]))
      k++;
    const commandName = segment[k]?.split("/").pop();
    if (commandName !== "wt" && commandName !== "git")
      continue;
    const args = segment.slice(k + 1);
    if (args.some((token) => HELP_OR_VERSION.has(token)))
      continue;
    if (commandName === "wt") {
      if (args[0] === "switch" && args.includes("--create"))
        return true;
      continue;
    }
    let arg = 0;
    if (args[arg] === "-C")
      arg += 2;
    if (args[arg] === "checkout" && args[arg + 1] === "-b")
      return true;
    if (args[arg] === "switch" && args[arg + 1] === "-c")
      return true;
    if (args[arg] === "worktree" && args[arg + 1] === "add")
      return true;
  }
  return false;
}
var ADVISORY = "MUST claim the bead before creating a branch or worktree: `bd update <id> --claim` is atomic and first-wins. " + "On refusal, treat the bead as taken; do not release another actor's claim to proceed.";
function claimBeforeBranch(pi) {
  pi.on("tool_call", (event) => {
    try {
      if (event.toolName !== "bash")
        return;
      const command = commandFromInput(event.input);
      if (!command || !hasUnclaimedBranchCreation(command))
        return;
      pi.sendMessage({ customType: "beads-claim-before-branch", content: ADVISORY, display: true, attribution: "user" }, { triggerTurn: false });
    } catch {}
  });
}
export {
  claimBeforeBranch as default,
  hasUnclaimedBranchCreation
};
