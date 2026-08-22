/** One frontend or backend as the Data Plane API declares it. */
export interface ProxyConfig {
  name: string;
  [key: string]: unknown;
}

export interface NodeConfig {
  frontends: ProxyConfig[];
  backends: ProxyConfig[];
}

export type ProxyStatus = "same" | "differs" | "only-a" | "only-b";

export interface FieldDiff {
  /** Dotted path, e.g. "httpchk_params.uri". */
  path: string;
  a: string | null;
  b: string | null;
}

export interface ProxyDiff {
  name: string;
  status: ProxyStatus;
  fields: FieldDiff[];
}

export interface ConfigDiff {
  frontends: ProxyDiff[];
  backends: ProxyDiff[];
  /** Proxies that differ or exist on only one side. */
  changed: number;
}

/**
 * Fields that say nothing about behaviour and would drown the real differences.
 *
 * `from` names the anonymous defaults section a proxy inherits from, and the
 * Data Plane API numbers those per file - two identical configs routinely
 * disagree on it. `name` is the key being compared, not a difference in it.
 */
const IGNORED = new Set(["from", "name"]);

/**
 * Flatten nested config into dotted paths.
 *
 * Null and absent are folded together on purpose: in HAProxy config an unset
 * option and one explicitly reported as null mean the same thing, and treating
 * them as different would report a difference that does not exist.
 */
export function flatten(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};

  if (value === null || value === undefined) return out;

  if (Array.isArray(value)) {
    // Order matters in HAProxy rule lists, so index rather than sort.
    value.forEach((item, i) => Object.assign(out, flatten(item, `${prefix}[${i}]`)));
    return out;
  }

  if (typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (!prefix && IGNORED.has(key)) continue;
      Object.assign(out, flatten(inner, prefix ? `${prefix}.${key}` : key));
    }
    return out;
  }

  if (prefix) out[prefix] = String(value);
  return out;
}

function diffProxies(a: ProxyConfig[], b: ProxyConfig[]): ProxyDiff[] {
  const byName = (list: ProxyConfig[]) =>
    new Map(list.filter((p) => p?.name).map((p) => [p.name, p]));
  const left = byName(a);
  const right = byName(b);

  const names = [...new Set([...left.keys(), ...right.keys()])].sort();

  return names.map((name) => {
    const onLeft = left.get(name);
    const onRight = right.get(name);

    if (!onRight) return { name, status: "only-a" as const, fields: [] };
    if (!onLeft) return { name, status: "only-b" as const, fields: [] };

    const flatA = flatten(onLeft);
    const flatB = flatten(onRight);
    const paths = [...new Set([...Object.keys(flatA), ...Object.keys(flatB)])].sort();

    const fields = paths
      .filter((path) => flatA[path] !== flatB[path])
      .map((path) => ({ path, a: flatA[path] ?? null, b: flatB[path] ?? null }));

    return {
      name,
      status: fields.length ? ("differs" as const) : ("same" as const),
      fields,
    };
  });
}

/**
 * Compare two nodes' declared configuration.
 *
 * Matched by proxy name, which is what an operator means by "the same backend
 * on both nodes" - position in the file is meaningless across hosts.
 */
export function diffConfigs(a: NodeConfig, b: NodeConfig): ConfigDiff {
  const frontends = diffProxies(a.frontends ?? [], b.frontends ?? []);
  const backends = diffProxies(a.backends ?? [], b.backends ?? []);
  const changed = [...frontends, ...backends].filter((p) => p.status !== "same").length;
  return { frontends, backends, changed };
}

/** Config for one node, flattened for display as a plain settings list. */
export function describe(config: NodeConfig): {
  frontends: { name: string; fields: FieldDiff[] }[];
  backends: { name: string; fields: FieldDiff[] }[];
} {
  const one = (list: ProxyConfig[]) =>
    (list ?? [])
      .filter((p) => p?.name)
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((proxy) => ({
        name: proxy.name,
        fields: Object.entries(flatten(proxy))
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([path, value]) => ({ path, a: value, b: null })),
      }));
  return { frontends: one(config.frontends), backends: one(config.backends) };
}
