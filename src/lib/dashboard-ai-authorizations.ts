import type { Prisma } from "@prisma/client";

export const DASHBOARD_AI_AUTHORIZATION_PREVIEW_LIMIT = 20;

type PendingAuthorizationWhere = Prisma.AiExecutionRequestWhereInput;

type PendingAuthorizationPreviewQuery = {
  where: PendingAuthorizationWhere;
  include: {
    requester: { select: { name: true } };
    client: { select: { displayName: true } };
  };
  orderBy: { createdAt: "asc" };
  take: number;
};

type LoadPendingAiAuthorizationsInput<T> = {
  isAdmin: boolean;
  now: Date;
  count: (where: PendingAuthorizationWhere) => Promise<number>;
  preview: (query: PendingAuthorizationPreviewQuery) => Promise<T[]>;
};

export async function loadDashboardPendingAiAuthorizations<T>({
  isAdmin,
  now,
  count,
  preview,
}: LoadPendingAiAuthorizationsInput<T>) {
  if (!isAdmin) return { total: 0, requests: [] as T[] };

  // Count and preview intentionally share the exact filter and reference instant.
  const where = {
    status: "PENDING_ADMIN_APPROVAL",
    expiresAt: { gt: now },
  } satisfies PendingAuthorizationWhere;
  const [total, requests] = await Promise.all([
    count(where),
    preview({
      where,
      include: {
        requester: { select: { name: true } },
        client: { select: { displayName: true } },
      },
      orderBy: { createdAt: "asc" },
      take: DASHBOARD_AI_AUTHORIZATION_PREVIEW_LIMIT,
    }),
  ]);

  return { total, requests };
}
