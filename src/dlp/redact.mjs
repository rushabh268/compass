import { _scanText } from "./classify.mjs";

export function redactText(text, options) {
  const { ranges, findings } = _scanText(text, options);
  const output = [];
  let cursor = 0;

  for (const { ruleID, start, end } of ranges) {
    output.push(text.slice(cursor, start), `[REDACTED:${ruleID}]`);
    cursor = end;
  }
  output.push(text.slice(cursor));

  return { text: output.join(""), findings };
}
