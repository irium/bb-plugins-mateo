function unquoteJqlValue(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<plain>[^\s,]+))$/u.exec(
    trimmed
  );
  return (
    quoted?.groups?.double ??
    quoted?.groups?.single ??
    quoted?.groups?.plain ??
    ''
  ).trim();
}

export function jiraProjectKeysFromJql(jql: string): string[] {
  const keys = new Set<string>();
  for (const match of jql.matchAll(
    /\bproject\s*=\s*("[^"]+"|'[^']+'|[A-Za-z][A-Za-z0-9_-]*)/giu
  )) {
    const key = unquoteJqlValue(match[1] ?? '');
    if (key && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) {
      keys.add(key.toUpperCase());
    }
  }
  for (const match of jql.matchAll(/\bproject\s+in\s*\(([^)]*)\)/giu)) {
    for (const value of (match[1] ?? '').split(',')) {
      const key = unquoteJqlValue(value);
      if (key && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) {
        keys.add(key.toUpperCase());
      }
    }
  }
  return [...keys];
}

/**
 * Returns the JQL with a trailing top-level `ORDER BY` clause removed.
 *
 * Scope verification wraps the configured JQL in parentheses and appends a
 * key predicate, and JQL only accepts `ORDER BY` as the final clause of the
 * whole query -- `(project = X ORDER BY created) AND issuekey = Y` is a
 * syntax error. The scan tracks quote state so an `order by` occurring inside
 * a quoted literal (e.g. `summary ~ "order by date"`) is left alone.
 */
export function jqlWithoutOrderBy(jql: string): string {
  let quote: '"' | "'" | null = null;
  let cutAt = -1;
  for (let index = 0; index < jql.length; index += 1) {
    const character = jql[index]!;
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== 'o' && character !== 'O') continue;
    const candidate = /^order\s+by\b/iu.exec(jql.slice(index));
    if (!candidate) continue;
    const before = index === 0 ? '' : jql[index - 1]!;
    if (before && !/\s|\)/u.test(before)) continue;
    cutAt = index;
  }
  return (cutAt === -1 ? jql : jql.slice(0, cutAt)).trim();
}
