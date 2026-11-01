/** Normalize common Brazilian phone input to the API's E.164 format. */
export function normalizeCustomerPhone(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return `+${digits}`;
  if (/^55\d{10,11}$/.test(digits)) return `+${digits}`;
  if (/^0\d{10,11}$/.test(digits)) return `+55${digits.slice(1)}`;
  if (/^\d{10,11}$/.test(digits)) return `+55${digits}`;
  return raw;
}
