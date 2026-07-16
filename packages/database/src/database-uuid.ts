const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function assertCanonicalUuid(value: string, label: string): void {
  if (!canonicalUuidPattern.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
}
