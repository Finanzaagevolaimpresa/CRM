import type { ProfileField } from './record-profile-fields';
export function recordProfileValues(record: object, fields: ProfileField[]) {
  const data = record as Record<string, unknown>;
  return Object.fromEntries(fields.map(field => {
    const value = data[field.name];
    return [field.name, value instanceof Date ? value.toISOString().slice(0, 10) : value === null || value === undefined ? '' : String(value)];
  }));
}
