/** Helpers for jCard (RFC 7095) arrays inside RDAP entities. */
export type JCardProp = [string, Record<string, unknown>, string, unknown];

export function vcardProps(entity: unknown): JCardProp[] {
  const arr = (entity as { vcardArray?: unknown } | null)?.vcardArray;
  if (!Array.isArray(arr) || arr[0] !== 'vcard' || !Array.isArray(arr[1])) return [];
  return (arr[1] as unknown[]).filter(
    (p): p is JCardProp => Array.isArray(p) && p.length >= 4 && typeof p[0] === 'string',
  );
}

export function vcardValues(entity: unknown, name: string): string[] {
  return vcardProps(entity)
    .filter((p) => p[0] === name && typeof p[3] === 'string')
    .map((p) => p[3] as string);
}

export function vcardValue(entity: unknown, name: string): string | undefined {
  return vcardValues(entity, name)[0];
}

export function entityKind(entity: unknown): string | undefined {
  return vcardValue(entity, 'kind')?.toLowerCase();
}

/** Conservative PII rule (spec §4): anything not explicitly an org or group is a person. */
export function isPersonLike(entity: unknown): boolean {
  const kind = entityKind(entity);
  return kind !== 'org' && kind !== 'group';
}
