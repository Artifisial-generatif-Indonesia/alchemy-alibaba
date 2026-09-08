const SECRET_KEY = /(?:access.?key|authorization|password|secret|signature|security.?token)/i;
const SECRET_QUERY = /(?:AccessKeyId|AccessKeySecret|Signature|SecurityToken|Password|BearerToken|ClientToken|Token)=([^&]*)/gi;

export const PROTOCOL_ACCESS_KEY_ID = "example-protocol-ak";
export const PROTOCOL_ACCESS_KEY_SECRET = "example-protocol-sk";

const secretValues = [PROTOCOL_ACCESS_KEY_ID, PROTOCOL_ACCESS_KEY_SECRET];

export const containsSecretValue = (text: string): boolean =>
  secretValues.some((value) => value.length > 0 && text.includes(value));

export const redactText = (text: string): string => {
  let redacted = text.replace(SECRET_QUERY, (match, value: string) => {
    const prefix = match.slice(0, match.length - value.length);
    return `${prefix}[redacted]`;
  });
  for (const value of secretValues) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
};

export const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : redactValue(nested),
    ]),
  );
};

export const assertNoSecrets = (value: unknown, location = "protocol"): void => {
  if (typeof value === "string") {
    if (containsSecretValue(value) || SECRET_QUERY.test(value)) {
      SECRET_QUERY.lastIndex = 0;
      throw new Error(`Secret material leaked at ${location}`);
    }
    SECRET_QUERY.lastIndex = 0;
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key) && typeof nested === "string" && nested !== "[redacted]") {
      throw new Error(`Secret-shaped key leaked at ${location}.${key}`);
    }
    assertNoSecrets(nested, `${location}.${key}`);
  }
};
