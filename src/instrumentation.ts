export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { internalSessionMode } = await import("./lib/session");
  if (internalSessionMode() !== "registry") return;

  const [{ assertRegistryStartupReady }, { prisma }] = await Promise.all([
    import("./lib/internal-session-registry"),
    import("./lib/prisma"),
  ]);
  await assertRegistryStartupReady(prisma);
}
