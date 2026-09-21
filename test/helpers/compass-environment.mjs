// Tests must never inherit either production environment alias family.
export function cleanCompassEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !name.startsWith("COMPASS_") && !name.startsWith("AGENT_HARNESS_")));
}

export function isolateCompassEnvironment() {
  const saved = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    name.startsWith("COMPASS_") || name.startsWith("AGENT_HARNESS_")));
  for (const name of Object.keys(saved)) delete process.env[name];
  return () => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("COMPASS_") || name.startsWith("AGENT_HARNESS_")) delete process.env[name];
    }
    Object.assign(process.env, saved);
  };
}
