export async function register() {
  // Keep Node-only imports inside the runtime branch so webpack excludes them
  // from Edge instrumentation; both session startup validations stay mandatory.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { internalSessionMode } = await import("./lib/session");
    const [{ assertRegistryStartupReady, assertLegacyStartupReady }, { prisma }] = await Promise.all([
      import("./lib/internal-session-registry"),
      import("./lib/prisma"),
    ]);
    if (internalSessionMode() === "registry") await assertRegistryStartupReady(prisma);
    else await assertLegacyStartupReady(prisma);
  }
}
