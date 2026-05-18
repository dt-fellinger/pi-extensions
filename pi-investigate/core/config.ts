/**
 * Configuration loader for pi-investigate.
 *
 * Reads ~/.pi/config/pi-investigate.json and merges with defaults.
 * Missing or malformed files are handled gracefully — defaults are used.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type InvestigateConfig } from "./types.js";

const CONFIG_PATH = join(homedir(), ".pi", "config", "pi-investigate.json");

export function loadConfig(): InvestigateConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<InvestigateConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    // File missing or unreadable — silently use defaults.
    return { ...DEFAULT_CONFIG };
  }
}

function mergeConfig(
  defaults: InvestigateConfig,
  overrides: Partial<InvestigateConfig>,
): InvestigateConfig {
  return {
    ...defaults,
    ...overrides,
    modules: {
      ...defaults.modules,
      ...(overrides.modules ?? {}),
      "query-tree": {
        ...defaults.modules["query-tree"],
        ...(overrides.modules?.["query-tree"] ?? {}),
      },
      "case-mgmt": {
        ...defaults.modules["case-mgmt"],
        ...(overrides.modules?.["case-mgmt"] ?? {}),
      },
    },
  };
}

/** Resolve the cache directory, supporting custom overrides. */
export function resolveCacheDir(config: InvestigateConfig): string {
  return config.cacheDir ?? join(homedir(), ".pi", "agent", "investigate-cache");
}
