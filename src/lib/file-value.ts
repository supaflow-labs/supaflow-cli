/** Match the frontend's FILE content encoding before encryption or submission. */
export function normalizeFileValue(
  value: string,
  property?: { inputType: string; type: string },
): string {
  if (property?.inputType !== 'FILE' && property?.type !== 'FILE') return value;
  if (!value || value.startsWith('enc:')) return value;
  // Explicit raw input disambiguates content that is itself valid Base64 text.
  if (value.startsWith('raw:')) return Buffer.from(value.slice(4), 'utf8').toString('base64');

  const encoded = value.trim();
  // Buffer's decoder is lenient, so require canonical Base64 before passing it through.
  if (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) &&
    Buffer.from(encoded, 'base64').toString('base64') === encoded
  ) {
    return encoded;
  }
  return Buffer.from(value, 'utf8').toString('base64');
}
