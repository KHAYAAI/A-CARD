/**
 * Renders the OpenAPI document as a single markdown reference
 * (docs/api/reference.md), so the full API is readable on GitHub without
 * hosting anything. Generated, never hand-edited — the freshness test in
 * apps/api/test/openapi.test.ts fails if it falls behind the spec.
 */

type Json = Record<string, any>;

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"];

function typeOf(schema: Json | undefined): string {
  if (!schema) return "any";
  if (schema.$ref) return String(schema.$ref).split("/").pop()!;
  if (schema.enum) return schema.enum.map((v: unknown) => `\`${String(v)}\``).join(" \\| ");
  if (schema.anyOf) return schema.anyOf.map(typeOf).join(" \\| ");
  if (schema.type === "array") return `${typeOf(schema.items)}[]`;
  if (Array.isArray(schema.type)) return schema.type.join(" \\| ");
  return schema.type ?? "object";
}

function fieldRows(schema: Json | undefined, prefix = ""): string[] {
  if (!schema || schema.type !== "object" || !schema.properties) return [];
  const required = new Set<string>(schema.required ?? []);
  const rows: string[] = [];
  for (const [name, prop] of Object.entries<Json>(schema.properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const desc = (prop.description ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    rows.push(`| \`${path}\` | ${typeOf(prop)} | ${required.has(name) ? "yes" : ""} | ${desc} |`);
    if (prop.type === "object" && prop.properties) rows.push(...fieldRows(prop, path));
    if (prop.type === "array" && prop.items?.type === "object") rows.push(...fieldRows(prop.items, `${path}[]`));
  }
  return rows;
}

function table(rows: string[]): string {
  return rows.length ? ["| Field | Type | Required | Notes |", "|---|---|---|---|", ...rows].join("\n") : "";
}

function anchor(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");
}

export function renderMarkdown(doc: Json): string {
  const out: string[] = [];
  out.push(`# ${doc.info.title} reference`, "");
  out.push(`> Generated from \`docs/api/openapi.json\` (version ${doc.info.version}) by \`npm run openapi\`. Do not edit by hand.`, "");
  out.push(doc.info.description, "");

  out.push("## Authentication", "");
  out.push("| Scheme | How to send it | Notes |", "|---|---|---|");
  for (const [name, scheme] of Object.entries<Json>(doc.components.securitySchemes)) {
    const how = scheme.type === "http" ? `\`Authorization: Bearer …\`` : `${scheme.in} \`${scheme.name}\``;
    out.push(`| \`${name}\` | ${how} | ${scheme.description ?? ""} |`);
  }
  out.push("");

  // Group operations by tag, preserving the spec's tag order.
  const byTag = new Map<string, Array<{ method: string; path: string; op: Json }>>();
  for (const tag of doc.tags) byTag.set(tag.name, []);
  for (const [path, methods] of Object.entries<Json>(doc.paths)) {
    for (const method of METHOD_ORDER) {
      const op = methods[method];
      if (op) byTag.get(op.tags[0])!.push({ method, path, op });
    }
  }

  out.push("## Contents", "");
  for (const tag of doc.tags) out.push(`- [${tag.name}](#${anchor(tag.name)}) — ${tag.description ?? ""}`);
  out.push("- [Schemas](#schemas)", "");

  for (const tag of doc.tags) {
    out.push(`## ${tag.name}`, "");
    if (tag.description) out.push(tag.description, "");
    for (const { method, path, op } of byTag.get(tag.name) ?? []) {
      out.push(`### \`${method.toUpperCase()} ${path}\``, "");
      out.push(`**${op.summary}**`, "");
      if (op.description) out.push(op.description, "");
      const auth = (op.security ?? []).map((s: Json) => `\`${Object.keys(s)[0]}\``).join(" or ");
      out.push(`- **Auth:** ${auth || "none"}`);
      if (op["x-acard-min-role"]) out.push(`- **Minimum role:** \`${op["x-acard-min-role"]}\``);
      out.push("");

      const params = (op.parameters ?? []) as Json[];
      if (params.length) {
        out.push("| Parameter | In | Type | Required | Notes |", "|---|---|---|---|---|");
        for (const p of params) out.push(`| \`${p.name}\` | ${p.in} | ${typeOf(p.schema)} | ${p.required ? "yes" : ""} | ${(p.description ?? "").replace(/\|/g, "\\|")} |`);
        out.push("");
      }

      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (body) {
        out.push("**Request body**", "");
        const rows = fieldRows(body);
        out.push(rows.length ? table(rows) : `\`${typeOf(body)}\``, "");
      }

      const [status, success] = Object.entries<Json>(op.responses).find(([code]) => code.startsWith("2")) ?? [];
      if (status && success) {
        const schema = success.content?.["application/json"]?.schema;
        out.push(`**Response \`${status}\`**${success.description && success.description !== "Success" ? ` — ${success.description}` : ""}`, "");
        const rows = fieldRows(schema);
        out.push(rows.length ? table(rows) : `\`${typeOf(schema)}\``, "");
      }
      const errors = Object.keys(op.responses).filter((code) => /^[45]/.test(code));
      if (errors.length) out.push(`Errors: ${errors.map((c) => `\`${c}\``).join(", ")} — see [errors.md](../reference/errors.md).`, "");
    }
  }

  out.push("## Schemas", "");
  for (const [name, schema] of Object.entries<Json>(doc.components.schemas)) {
    out.push(`### ${name}`, "");
    out.push(table(fieldRows(schema)) || `\`${typeOf(schema)}\``, "");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
