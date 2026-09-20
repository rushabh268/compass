// Read aliases only when the Compass variable is absent. Empty/invalid values
// are intentional inputs and must not resurrect a legacy policy or endpoint.
export function environmentValue(name, environment = process.env) {
  return environment[`COMPASS_${name}`] ?? environment[`AGENT_HARNESS_${name}`];
}
