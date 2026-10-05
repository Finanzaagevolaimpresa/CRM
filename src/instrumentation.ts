export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { internalSessionMode } = await import("./lib/session");
  const [{ assertRegistryStartupReady, assertLegacyStartupReady }, { prisma }] = await Promise.all([
    import("./lib/internal-session-registry"),
    import("./lib/prisma"),
  ]);
  if (internalSessionMode() === "registry") await assertRegistryStartupReady(prisma);
  else await assertLegacyStartupReady(prisma);
}
