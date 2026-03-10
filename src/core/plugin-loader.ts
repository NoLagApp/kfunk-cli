import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { stat } from "node:fs/promises";
import type {
  KfunkConfig,
  AnyPlugin,
  EventPlugin,
  InfraPlugin,
  EventPluginConfig,
  PluginFactory,
} from "./plugin-types.js";

// ---- Plugin Registry ----

export class PluginRegistry {
  private eventPlugins: EventPlugin[] = [];
  private infraPlugins: Map<string, InfraPlugin> = new Map();
  /** Track event plugin configs for serialization to workers */
  private eventConfigs: EventPluginConfig[] = [];

  addEvent(plugin: EventPlugin, config: Record<string, unknown> = {}): void {
    this.eventPlugins.push(plugin);
    this.eventConfigs.push({ name: plugin.name, config });
  }

  addInfra(plugin: InfraPlugin): void {
    this.infraPlugins.set(plugin.name, plugin);
  }

  getEventPlugins(): EventPlugin[] {
    return this.eventPlugins;
  }

  getInfraPlugin(name?: string): InfraPlugin | null {
    if (name) return this.infraPlugins.get(name) ?? null;
    // Return first infra plugin if no name specified
    const first = this.infraPlugins.values().next();
    return first.done ? null : first.value;
  }

  /** Get serializable event plugin configs to send to workers */
  getEventPluginConfigs(): EventPluginConfig[] {
    return this.eventConfigs;
  }

  async destroyAll(): Promise<void> {
    const all: AnyPlugin[] = [...this.eventPlugins, ...this.infraPlugins.values()];
    await Promise.allSettled(all.map((p) => p.destroy?.()));
  }
}

// ---- Config loading ----

const CONFIG_FILENAMES = ["kfunk.config.js", "kfunk.config.mjs"];

export async function loadConfig(searchDir?: string, configPath?: string): Promise<KfunkConfig | null> {
  if (configPath) {
    const abs = resolve(configPath);
    const url = pathToFileURL(abs).href;
    const mod = await import(url);
    return (mod.default ?? mod) as KfunkConfig;
  }

  const dir = searchDir ?? process.cwd();
  for (const filename of CONFIG_FILENAMES) {
    const filepath = join(dir, filename);
    try {
      await stat(filepath);
      const url = pathToFileURL(filepath).href;
      const mod = await import(url);
      return (mod.default ?? mod) as KfunkConfig;
    } catch {
      // File not found, try next
    }
  }

  return null;
}

// ---- Plugin loading ----

async function loadPluginModule(packageName: string): Promise<PluginFactory> {
  const mod = await import(packageName);
  const factory = mod.default ?? mod;
  if (typeof factory !== "function") {
    throw new Error(`Plugin "${packageName}" must export a factory function as default export`);
  }
  return factory as PluginFactory;
}

export async function loadPlugins(config: KfunkConfig): Promise<PluginRegistry> {
  const registry = new PluginRegistry();

  if (!config.plugins || config.plugins.length === 0) {
    return registry;
  }

  for (const entry of config.plugins) {
    const packageName = typeof entry === "string" ? entry : entry.name;
    const inlineConfig = typeof entry === "object" ? (entry.config ?? {}) : {};
    // Merge inline config with top-level per-plugin config
    const pluginConfig = {
      ...(config[packageName] as Record<string, unknown> ?? {}),
      ...inlineConfig,
    };

    const factory = await loadPluginModule(packageName);
    const plugin = await factory(pluginConfig);

    if (plugin.type === "event") {
      registry.addEvent(plugin as EventPlugin, pluginConfig);
    } else if (plugin.type === "infra") {
      registry.addInfra(plugin as InfraPlugin);
    } else {
      throw new Error(`Plugin "${packageName}" has unknown type: ${(plugin as AnyPlugin).type}`);
    }
  }

  return registry;
}

// ---- Worker-side event plugin loading ----

/**
 * Load event plugins from serialized configs (used by workers).
 * Workers don't have kfunk.config.js — they receive plugin names + configs from the CLI.
 */
export async function loadEventPluginsFromConfigs(configs: EventPluginConfig[]): Promise<EventPlugin[]> {
  const plugins: EventPlugin[] = [];

  for (const { name, config } of configs) {
    const factory = await loadPluginModule(name);
    const plugin = await factory(config);

    if (plugin.type !== "event") {
      throw new Error(`Plugin "${name}" is not an event plugin (got type: ${plugin.type})`);
    }
    plugins.push(plugin as EventPlugin);
  }

  return plugins;
}
