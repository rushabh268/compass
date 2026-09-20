import { assertAbsolutePath, validateAdapters } from "./plan.mjs";

const MAX_CODEX_REGISTRATIONS = 16;

export function parseManifest(text) {
  if (text === null) return { schemaVersion: 1, adapters: [], codex: [] };
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== "adapters,codex,schemaVersion" || value.schemaVersion !== 1 ||
        !Array.isArray(value.adapters) || value.adapters.length > 3 ||
        !Array.isArray(value.codex) || value.codex.length > MAX_CODEX_REGISTRATIONS) throw new Error("invalid fields");
    if (value.adapters.length > 0) validateAdapters(value.adapters);
    if (value.adapters.includes("codex") !== (value.codex.length > 0)) throw new Error("inconsistent Codex registrations");
    for (const entry of value.codex) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "command,path" ||
          typeof entry.command !== "string" || entry.command.length === 0 || entry.command.length > 32768 || entry.command.includes("\0")) throw new Error("invalid registration");
      assertAbsolutePath(entry.path);
    }
    return value;
  } catch {
    throw new Error("invalid installation manifest");
  }
}

export function addCodexRegistration(manifest, path, command) {
  if (manifest.codex.some((entry) => entry.path === path && entry.command === command)) return manifest;
  const updated = { ...manifest, codex: [...manifest.codex, { path, command }] };
  return parseManifest(JSON.stringify(updated));
}
