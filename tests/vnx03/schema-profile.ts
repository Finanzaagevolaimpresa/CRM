export function qualificationSchema() {
  const profile = process.env.VNX03_QUALIFICATION_PROFILE ?? 'historical-schema44';
  if (profile === 'historical-schema44') return { profile, migrations: 44 } as const;
  if (profile === 'candidate-schema47') return { profile, migrations: 47 } as const;
  if (profile === 'candidate-schema48') return { profile, migrations: 48 } as const;
  if (profile === 'candidate-schema49') return { profile, migrations: 49 } as const;
  if (profile === 'candidate-schema50') return { profile, migrations: 50 } as const;
  if (profile === 'candidate-schema52') return { profile, migrations: 52 } as const;
  if (profile === 'candidate-schema53') return { profile, migrations: 53 } as const;
  if (profile === 'candidate-schema54') return { profile, migrations: 54 } as const;
  if (profile === 'candidate-schema55') return { profile, migrations: 55 } as const;
  if (profile === 'candidate-schema56') return { profile, migrations: 56 } as const;
  if (profile === 'candidate-schema51') return { profile, migrations: 51 } as const;
  if (profile === 'candidate-schema57') return { profile, migrations: 57 } as const;
  if (profile === 'candidate-schema58') return { profile, migrations: 58 } as const;
  if (profile === 'candidate-schema59') return { profile, migrations: 59 } as const;
  throw new Error('VNX03_QUALIFICATION_PROFILE_INVALID');
}
