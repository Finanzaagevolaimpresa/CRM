'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePermission } from './auth';
import { prisma } from './prisma';
import { CatalogV2PreparationError, prepareInternalServiceCatalogV2 } from './service-catalog-v2-persistence';

export async function prepareInternalCatalogAction() {
  const actor = await requirePermission('service.write');
  let denied = false;
  try {
    await prepareInternalServiceCatalogV2(prisma, actor);
  } catch (error) {
    if (!(error instanceof CatalogV2PreparationError)) throw error;
    denied = true;
  }
  if (denied) redirect('/service-catalog?preparation=denied');
  revalidatePath('/service-catalog');
  redirect('/service-catalog?preparation=complete');
}
