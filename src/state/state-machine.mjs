const transitions = new Map([
  ["CREATED", new Set(["ADMITTED"])],
  ["ADMITTED", new Set(["ACTIVE"])],
  ["ACTIVE", new Set(["SNAPSHOTTED"])],
  ["SNAPSHOTTED", new Set(["REVIEWING"])],
  ["REVIEWING", new Set(["VALIDATING", "REWORKING"])],
  ["VALIDATING", new Set(["VERIFIED_TREE", "REWORKING"])],
  ["VERIFIED_TREE", new Set(["REWORKING"])],
  ["REWORKING", new Set(["SNAPSHOTTED"])],
  ["FAILED", new Set()],
  ["CANCELLED", new Set()],
]);

for (const state of transitions.keys()) {
  if (state !== "FAILED" && state !== "CANCELLED") {
    transitions.get(state).add("FAILED").add("CANCELLED");
  }
}

export function assertTransition(currentState, nextState) {
  if (!transitions.get(currentState)?.has(nextState)) {
    throw new Error(`illegal run transition: ${currentState} -> ${nextState}`);
  }
}
