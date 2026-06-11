/**
 * Mirror of the prototype's `handleize` (data.jsx): lowercase-safe slug —
 * strip non-alphanumerics (keep spaces/hyphens), collapse whitespace to
 * hyphens, collapse repeats, trim leading/trailing hyphens. Used for shop
 * handles and product slugs.
 */
export function handleize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
