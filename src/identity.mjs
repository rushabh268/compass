import { createHmac } from "node:crypto";
export function identityHMAC(key, domain, value) {
  const mac = createHmac("sha256", key);
  for (const part of [domain, value]) {
    const bytes = Buffer.from(part, "utf8"),
      length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    mac.update(length).update(bytes);
  }
  return mac.digest("hex");
}
export function validNativeID(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= 1024
  );
}
export function validateSubject(platform, subject) {
  if (
    !["claude", "codex", "opencode"].includes(platform) ||
    !subject ||
    Object.keys(subject).some((k) => !["kind", "nativeID"].includes(k)) ||
    !validNativeID(subject.nativeID) ||
    !(
      platform === "opencode" ? ["root", "session"] : ["root", "agent"]
    ).includes(subject.kind)
  )
    throw new TypeError("invalid subject");
  return subject;
}
// Native callbacks supply identity; never infer relationships from names or time.
export function hookSubject(platform, payload) {
  if (["SubagentStart", "SubagentStop"].includes(payload.hook_event_name) && !validNativeID(payload.agent_id)) return undefined;
  const agent =
    platform === "claude"
      ? payload.agent_id
      : ["SubagentStart", "SubagentStop"].includes(payload.hook_event_name)
        ? payload.agent_id
        : undefined;
  const nativeID = agent ?? payload.session_id;
  return validNativeID(nativeID)
    ? { kind: agent ? "agent" : "root", nativeID }
    : undefined;
}
export function evidenceIdentity(params, key) {
  if (
    params.version !== 1 ||
    !validNativeID(params.rootSessionID) ||
    Object.keys(params).some(
      (k) => !["version", "platform", "rootSessionID", "subject"].includes(k),
    )
  )
    throw new TypeError("invalid evidence selector");
  const subject = validateSubject(
    params.platform,
    params.subject ?? { kind: "root", nativeID: params.rootSessionID },
  );
  if (subject.kind === "root" && subject.nativeID !== params.rootSessionID)
    throw new TypeError("invalid evidence selector");
  return {
    platform: params.platform,
    kind: subject.kind,
    runID: identityHMAC(
      key,
      `${params.platform}.run`,
      params.platform === "opencode" ? subject.nativeID : params.rootSessionID,
    ),
    subjectHMAC: identityHMAC(
      key,
      `${params.platform}.session`,
      subject.nativeID,
    ),
    rootHMAC: identityHMAC(
      key,
      `${params.platform}.session`,
      params.rootSessionID,
    ),
  };
}
