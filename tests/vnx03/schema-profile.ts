export function qualificationSchema() {
  const profile = process.env.VNX03_QUALIFICATION_PROFILE ?? 'historical-schema44';
  if (profile === 'historical-schema44') return { profile, migrations: 44 } as const;
  if (profile === 'candidate-schema47') return { profile, migrations: 47 } as const;
  throw new Error('VNX03_QUALIFICATION_PROFILE_INVALID');
}
