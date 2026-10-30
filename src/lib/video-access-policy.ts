import { createHash } from 'node:crypto';
import { communicationRecipientGroups } from './communication-recipient-groups';

export const videoAreas = communicationRecipientGroups;
export type VideoArea = keyof typeof videoAreas;
export type VideoPerson = {
  id: string; name: string; email: string; role: string; active: boolean; deleted: boolean;
  epoch: number; canRead: boolean; canManage: boolean;
};
export type VideoSelection = { people: string[]; areas: VideoArea[] };
export type VideoAudience = { id: string; epoch: number; role: string }[];
export class VideoPolicyError extends Error {
  constructor(public readonly code: 'VIDEO_SELECTION_INVALID' | 'VIDEO_SELECTION_CHANGED') { super(code); }
}
function invalid(): never { throw new VideoPolicyError('VIDEO_SELECTION_INVALID'); }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const available = (person: VideoPerson) => person.active && !person.deleted && person.canRead
  && Number.isSafeInteger(person.epoch) && person.epoch > 0;

/** Resolve existing areas to named people. The result is a frozen audience, not
 * automatic access for future area members. Call under the native directory lock. */
export function resolveVideoAudience(raw: unknown, directory: readonly VideoPerson[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'people') || !Object.hasOwn(value, 'areas')) invalid();
  const ids = (input: unknown, max: number): string[] => {
    if (!Array.isArray(input) || input.length > max || input.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      || new Set(input).size !== input.length) invalid();
    return (input as string[]).slice().sort();
  };
  const people = ids(value.people, 100), areas = ids(value.areas, Object.keys(videoAreas).length);
  if ((!people.length && !areas.length) || areas.some(area => !Object.hasOwn(videoAreas, area))) invalid();
  if (new Set(directory.map(person => person.id)).size !== directory.length) invalid();
  const selected = new Set(people);
  for (const area of areas) {
    const roles: readonly string[] = videoAreas[area as VideoArea].roles;
    const members = directory.filter(person => available(person) && roles.includes(person.role));
    if (!members.length) invalid();
    members.forEach(person => selected.add(person.id));
  }
  if (selected.size > 100) invalid();
  const resolved = [...selected].sort().map(id => {
    const person = directory.find(item => item.id === id);
    if (!person || !available(person)) throw new VideoPolicyError('VIDEO_SELECTION_CHANGED');
    return person;
  });
  const selection: VideoSelection = { people, areas: areas as VideoArea[] };
  const audience: VideoAudience = resolved.map(({ id, epoch, role }) => ({ id, epoch, role }));
  const binding = digest({ selection, audience, people: resolved.map(({ id, name, email }) => ({ id, name, email })),
    // Group changes between preview and confirmation must not use an old decision.
    directory: areas.length ? directory.map(({ id, role, active, deleted, epoch, canRead }) =>
      ({ id, role, active, deleted, epoch, canRead })).sort((a, b) => a.id.localeCompare(b.id)) : null });
  return { selection, audience, binding, people: resolved.map(({ id, name, email, role }) => ({ id, name, email, role })) };
}

export type VideoPublication = {
  state: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; fileReady: boolean;
  expiresAt: Date | null; authorId: string | null; authorEpoch: number | null;
  audience: VideoAudience; downloadAllowed: boolean;
};
/** Fresh session/registry validation and a locked current row are required before
 * this policy, on list/search/metadata and every GET, HEAD or Range request. */
export function canReadPublishedVideo(video: VideoPublication, person: VideoPerson, author: VideoPerson | null, now: Date) {
  if (!Number.isFinite(now.getTime()) || video.state !== 'PUBLISHED' || !video.fileReady || !available(person)
    || (video.expiresAt !== null && (!Number.isFinite(video.expiresAt.getTime()) || video.expiresAt <= now))) return false;
  if (!author || !author.active || author.deleted || author.role !== 'admin' || !author.canManage
    || author.id !== video.authorId || author.epoch !== video.authorEpoch) return false;
  return video.audience.some(member => member.id === person.id && member.epoch === person.epoch && member.role === person.role);
}

export function canDownloadPublishedVideo(video: VideoPublication, person: VideoPerson, author: VideoPerson | null, now: Date) {
  return video.downloadAllowed && canReadPublishedVideo(video, person, author, now);
}
