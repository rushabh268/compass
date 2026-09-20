import { createHash } from "node:crypto";

const rules = [
  {
    ruleID: "url-userinfo",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/([^\\/\s?#]+)@([^\\/@\s?#]+)/gdi,
    groups: [1],
    accepts: acceptsURLUserinfo,
  },
  {
    ruleID: "grafana-token",
    pattern: /\b(glsa_[A-Za-z0-9_-]{20,})\b/gd,
    groups: [1],
  },
  {
    ruleID: "jwt",
    pattern:
      /(?<![A-Za-z0-9_-])(eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*))(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/gd,
    groups: [1],
  },
  {
    ruleID: "bearer-token",
    pattern: /\bBearer[ \t]+(\S+)/gdi,
    groups: [1],
    accepts: (value) => !isExcluded(value) && !/^(?:undefined|null)$/i.test(value),
  },
  {
    ruleID: "basic-auth",
    pattern: /\bBasic[ \t]+(\S+)/gdi,
    groups: [1],
    accepts: (value) => !isExcluded(value),
  },
  {
    ruleID: "aws-access-key-id",
    pattern: /(?<![A-Z0-9])((?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Z0-9])/gd,
    groups: [1],
  },
  {
    ruleID: "github-token",
    pattern: /(?<![A-Za-z0-9_])((?:gh[opusr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255}))(?![A-Za-z0-9_])/gd,
    groups: [1],
  },
  {
    ruleID: "slack-token",
    pattern: /(?<![A-Za-z0-9-])(xox[baprs]-[A-Za-z0-9-]{20,200})(?![A-Za-z0-9-])/gd,
    groups: [1],
  },
];

const pemPrivateKeyBegin = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[ \t]*(\r?\n|(?:\\r)?\\n)/gd;
const pemBoundary = /^[ \t]*-----(?:BEGIN|END) [A-Z0-9 ]+-----/gdm;
const escapedPEMBoundary = /[ \t]*-----(?:BEGIN|END) [A-Z0-9 ]+-----/gd;
const pemHeader = /[ \t]*[A-Za-z0-9-]+:[^\r\n]*\r?\n/dy;
const escapedPEMHeader = /[ \t]*[A-Za-z0-9-]+:[^\\\r\n]*(?:\\r)?\\n/dy;
const pemBlank = /[ \t]*\r?\n/dy;
const escapedPEMBlank = /[ \t]*(?:\\r)?\\n/dy;

function collectPEMPrivateKeys(text) {
  const ranges = [];

  for (const match of text.matchAll(pemPrivateKeyBegin)) {
    const escapedNewline = match[1].endsWith("\\n");
    const header = escapedNewline ? escapedPEMHeader : pemHeader;
    const blank = escapedNewline ? escapedPEMBlank : pemBlank;
    let start = match.indices[0][1];

    header.lastIndex = start;
    let headerMatch;
    while ((headerMatch = header.exec(text))) {
      start = headerMatch.indices[0][1];
      header.lastIndex = start;
    }
    blank.lastIndex = start;
    const blankMatch = blank.exec(text);
    if (blankMatch) start = blankMatch.indices[0][1];
    while (text[start] === " " || text[start] === "\t") start += 1;

    const boundaryPattern = escapedNewline ? escapedPEMBoundary : pemBoundary;
    boundaryPattern.lastIndex = start;
    const boundary = boundaryPattern.exec(text);
    let end = boundary?.index ?? text.length;
    if (boundary) {
      if (escapedNewline) {
        while (end > start && (text[end - 1] === " " || text[end - 1] === "\t")) end -= 1;
        if (text.slice(end - 4, end) === "\\r\\n") end -= 4;
        else if (text.slice(end - 2, end) === "\\n") end -= 2;
      } else {
        while (end > start && /[ \t\r\n]/.test(text[end - 1])) end -= 1;
      }
    }
    if (end > start) ranges.push({ ruleID: "pem-private-key", start, end });
  }
  return ranges;
}

const placeholderPatterns = [
  /^\$\{[^}]+\}$/,
  /^\{env:[^}]+\}$/i,
  /^<redacted>$/i,
  /^\[REDACTED:[^\]]+\]$/i,
];

function isExcluded(value) {
  const normalized = value.trim();
  return placeholderPatterns.some((pattern) => pattern.test(normalized));
}

function isCredentialKey(key) {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  if (
    normalized === "clientpasswordhash" ||
    normalized === "tokentype" ||
    normalized === "maxtoken" ||
    normalized === "cancellationtoken"
  ) return false;
  return [
    "password", "passwd", "pwd", "token", "secret", "apikey", "accesskey",
    "accountkey", "secretkey", "privatekey", "signingkey", "encryptionkey", "sessionkey",
  ].some(
    (suffix) => normalized.endsWith(suffix),
  );
}

function isCookieCredentialKey(key) {
  const normalized = key.replace(/[_-]/g, "").toLowerCase();
  return isCredentialKey(key) || ["session", "sessionid", "sessiontoken", "sid"].includes(normalized);
}

function isCredentialValue(value) {
  const normalized = value.trim();
  return !isExcluded(normalized) &&
    !/^process\.env(?:\.|\[)/.test(normalized) &&
    !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\(/.test(normalized);
}

function skipWhitespace(text, index) {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    index += 1;
  }
  return index;
}

function quotedEnd(text, start, quote) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\n" || text[index] === "\r") return [index, false];
    if (quote === '"' && text[index] === "\\") index += 1;
    else if (text[index] === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 1;
        continue;
      }
      return [index, true];
    }
  }
  return [text.length, false];
}

function blockScalarRange(text, marker, keyStart) {
  let lineEnd = text.indexOf("\n", marker);
  if (lineEnd === -1) return undefined;
  const keyLineStart = Math.max(text.lastIndexOf("\n", keyStart - 1) + 1, 0);
  const keyIndent = keyStart - keyLineStart;
  let start;
  let end;

  while (lineEnd < text.length) {
    const lineStart = lineEnd + 1;
    lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    let contentStart = lineStart;
    while (text[contentStart] === " " || text[contentStart] === "\t") contentStart += 1;
    if (contentStart === lineEnd || text[contentStart] === "\r") continue;
    if (contentStart - lineStart <= keyIndent) break;
    start ??= contentStart;
    end = lineEnd;
  }
  if (end !== undefined && text[end - 1] === "\r") end -= 1;
  return start === undefined ? undefined : [start, end];
}

function collectAssignments(text) {
  const ranges = [];
  let cursor = 0;

  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
      cursor += 1;
      continue;
    }

    const keyStart = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const next = text.charCodeAt(cursor);
      if (!(
        (next >= 65 && next <= 90) ||
        (next >= 97 && next <= 122) ||
        (next >= 48 && next <= 57) ||
        next === 45 ||
        next === 95
      )) break;
      cursor += 1;
    }
    const key = text.slice(keyStart, cursor);
    if (!isCredentialKey(key)) continue;

    let index = cursor;
    if (text[index] === '"' || text[index] === "'") index += 1;
    index = skipWhitespace(text, index);
    if (text[index] !== ":" && text[index] !== "=") {
      cursor = index;
      continue;
    }
    const separator = text[index];
    if (separator === "=" && (text[index + 1] === "=" || text[index + 1] === ">")) {
      cursor = index + 1;
      continue;
    }
    index = skipWhitespace(text, index + 1);

    if (separator === ":" && (text[index] === "|" || text[index] === ">")) {
      const range = blockScalarRange(text, index, keyStart);
      if (range) ranges.push({ ruleID: "credential-assignment", start: range[0], end: range[1] });
      cursor = range?.[1] ?? index + 1;
      continue;
    }

    let start = index;
    let end;
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      start += 1;
      [end] = quotedEnd(text, start, quote);
    } else {
      const newline = text.indexOf("\n", start);
      end = newline === -1 ? text.length : newline;
      const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
      if (normalizedKey === "accountkey") {
        const delimiter = text.indexOf(";", start);
        if (delimiter !== -1 && delimiter < end) end = delimiter;
      } else if (key.toUpperCase() === "PGPASSWORD") {
        const delimiter = text.slice(start, end).search(/[ \t]/);
        if (delimiter !== -1) end = start + delimiter;
      }
      if (separator === ":") {
        const comment = text.indexOf(" #", start);
        if (comment !== -1 && comment < end) end = comment;
      }
      while (end > start && /[ \t\r]/.test(text[end - 1])) end -= 1;
    }
    if (end > start && isCredentialValue(text.slice(start, end))) {
      ranges.push({ ruleID: "credential-assignment", start, end });
    }
    cursor = Math.max(cursor, end);
  }
  return ranges;
}

const cookieCredentialPattern = /\b(?:set-)?cookie[ \t]*:[ \t]*([A-Za-z][A-Za-z0-9_-]*)=([^;\s\r\n]+)/gdi;
const apiKeyAuthorizationPattern = /\bauthorization[ \t]*:[ \t]*apikey[ \t]+(\S+)/gdi;
const cliCredentialPattern = /--(?:password|token|account-key)(?:=|[ \t]+)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s-]\S*))/gdi;

function matchingContextRange(match, groups) {
  for (const group of groups) {
    if (match.indices[group]) return match.indices[group];
  }
  return undefined;
}

function collectCurlUserinfo(text) {
  const ranges = [];
  let lineStart = 0;

  while (lineStart < text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    let cursor = lineStart;

    while (cursor < lineEnd) {
      const curl = text.indexOf("curl", cursor);
      if (curl === -1 || curl >= lineEnd) break;
      cursor = curl + 4;
      if (
        (curl > lineStart && /[A-Za-z0-9_]/.test(text[curl - 1])) ||
        (cursor < lineEnd && /[A-Za-z0-9_]/.test(text[cursor]))
      ) continue;

      let index = cursor;
      while (index < lineEnd) {
        while (text[index] === " " || text[index] === "\t") index += 1;
        const tokenStart = index;
        while (index < lineEnd && text[index] !== " " && text[index] !== "\t") index += 1;
        if (text.slice(tokenStart, index) !== "-u") continue;
        while (text[index] === " " || text[index] === "\t") index += 1;
        const start = index;
        while (index < lineEnd && text[index] !== " " && text[index] !== "\t") index += 1;
        const value = text.slice(start, index);
        if (start < index && acceptsURLUserinfo(value)) {
          ranges.push({ ruleID: "url-userinfo", start, end: index });
        }
        break;
      }
      cursor = lineEnd;
    }

    lineStart = lineEnd + 1;
  }
  return ranges;
}

function collectContextualCredentials(text) {
  const ranges = [];
  for (const match of text.matchAll(cookieCredentialPattern)) {
    const range = matchingContextRange(match, [2]);
    const value = text.slice(range[0], range[1]);
    if (isCookieCredentialKey(match[1]) && isCredentialValue(value)) {
      ranges.push({ ruleID: "credential-assignment", start: range[0], end: range[1] });
    }
  }
  for (const match of text.matchAll(apiKeyAuthorizationPattern)) {
    const range = matchingContextRange(match, [1]);
    const value = text.slice(range[0], range[1]);
    if (isCredentialValue(value)) {
      ranges.push({ ruleID: "credential-assignment", start: range[0], end: range[1] });
    }
  }
  for (const match of text.matchAll(cliCredentialPattern)) {
    const range = matchingContextRange(match, [1, 2, 3]);
    const value = text.slice(range[0], range[1]);
    if (isCredentialValue(value)) {
      ranges.push({ ruleID: "credential-assignment", start: range[0], end: range[1] });
    }
  }
  ranges.push(...collectCurlUserinfo(text));
  return ranges;
}

function acceptsURLUserinfo(value) {
  if (isExcluded(value)) return false;

  const separator = value.indexOf(":");
  const credential = separator === -1 ? value : value.slice(separator + 1);
  return !isExcluded(credential);
}

function lineStartsFor(text) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") index += 1;
      lineStarts.push(index + 1);
    } else if (text[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  return lineStarts;
}

function addLocations(ranges, text) {
  const lineStarts = lineStartsFor(text);
  let lineIndex = 0;
  let lineStart = 0;
  let columnIndex = 0;
  let column = 1;

  return ranges.map((range) => {
    while (
      lineIndex + 1 < lineStarts.length &&
      lineStarts[lineIndex + 1] <= range.start
    ) {
      lineIndex += 1;
    }
    if (lineStart !== lineStarts[lineIndex]) {
      lineStart = lineStarts[lineIndex];
      columnIndex = lineStart;
      column = 1;
    }
    while (columnIndex < range.start) {
      columnIndex += text.codePointAt(columnIndex) > 0xffff ? 2 : 1;
      column += 1;
    }
    return {
      ...range,
      line: lineIndex + 1,
      column,
    };
  });
}

function matchingRange(match, groups) {
  for (const group of groups) {
    if (match.indices[group]) return match.indices[group];
  }
  return undefined;
}

function isCLIFlagValue(text, start) {
  return /--(?:password|token|account-key)(?:=|[ \t]+)$/i.test(
    text.slice(Math.max(0, start - 32), start),
  );
}

function collectRanges(text) {
  const ranges = [
    ...collectAssignments(text),
    ...collectContextualCredentials(text),
    ...collectPEMPrivateKeys(text),
  ];
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      const [start, end] = matchingRange(match, rule.groups);
      const value = text.slice(start, end);
      if (
        !isCLIFlagValue(text, start) &&
        (rule.accepts?.(value, match) ?? !isExcluded(value))
      ) {
        ranges.push({ ruleID: rule.ruleID, start, end });
      }
    }
  }
  return ranges;
}

function mergeRanges(ranges) {
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];

  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function safeSource(source) {
  return `sha256:${createHash("sha256").update(String(source)).digest("hex").slice(0, 16)}`;
}

export function _scanText(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("text must be a string");

  const detectedRanges = collectRanges(text).sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const ranges = mergeRanges(detectedRanges);

  const source =
    options?.source === undefined ? undefined : safeSource(options.source);
  const findingRanges = detectedRanges.filter((range, index, all) => {
    const previous = all[index - 1];
    return !previous || range.start >= previous.end ||
      (range.start === previous.start && range.end === previous.end);
  });
  const findings = addLocations(findingRanges, text).map(({ ruleID, line, column }) => {
    const finding = { ruleID };
    if (source !== undefined) finding.source = source;
    finding.line = line;
    finding.column = column;
    return finding;
  });

  return { ranges, findings };
}

export function scanText(text, options) {
  return _scanText(text, options).findings;
}
