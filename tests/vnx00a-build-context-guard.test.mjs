import assert from "node:assert/strict";
import test from "node:test";

import {
  GuardFailure,
  assertCiPolicy,
  assertComposeBuildContexts,
  assertDockerProtection,
  assertGitProtection,
  assertNoAdditionalBuildContexts,
  assertProtectedUntracked,
  enumerateTrackedFiles,
  inspectDockerfile,
  parseNulRecords,
} from "../scripts/vnx00a-build-context-guard.mjs";

const CANARY = "VNX00A_SYNTHETIC_CANARY.txt";
const tracked = [
  ".dockerignore",
  ".gitignore",
  ".github/workflows/ci.yml",
  "Dockerfile.prod.example",
  "package-lock.json",
  "package.json",
  "prisma/schema.prisma",
  "public/favicon.ico",
  "scripts/smoke-docker-prod.sh",
  "src/app/page.tsx",
];

test("tracked-only enumeration requires valid NUL-delimited Git output", () => {
  const exec = (_git, args) => {
    assert.deepEqual(args, ["ls-files", "-z", "--cached"]);
    return Buffer.from("a.txt\0src/b.ts\0");
  };
  assert.deepEqual(enumerateTrackedFiles({ exec }), ["a.txt", "src/b.ts"]);
  assert.throws(() => parseNulRecords(Buffer.from("a.txt\n")), GuardFailure);
});

test("tracked-only enumeration fails closed when Git is missing or fails", () => {
  const missing = () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  };
  const failed = () => {
    throw Object.assign(new Error("failed"), { status: 128 });
  };
  assert.throws(() => enumerateTrackedFiles({ exec: missing }), /Git executable not found/);
  assert.throws(() => enumerateTrackedFiles({ exec: failed }), /Git command failed/);
});

test("the synthetic canary is rejected when tracked, including Windows case variants", () => {
  assert.doesNotThrow(() => assertProtectedUntracked(["src/a.ts"], CANARY));
  assert.throws(() => assertProtectedUntracked([CANARY], CANARY), /tracked/);
  assert.throws(() => assertProtectedUntracked(["vnx00a_synthetic_canary.TXT"], CANARY), /tracked/);
});

test("ambiguous separators and traversal fail closed", () => {
  assert.throws(() => assertProtectedUntracked(["folder\\..\\VNX00A_SYNTHETIC_CANARY.txt"], CANARY), /canonical/);
  assert.throws(() => assertProtectedUntracked(["/VNX00A_SYNTHETIC_CANARY.txt"], CANARY), /absolute/);
});

test("Git protection requires the tracked root rule to be the effective rule", () => {
  const content = "node_modules\n/VNX00A_SYNTHETIC_CANARY.txt\n";
  const winner = {
    source: ".gitignore",
    line: 2,
    pattern: "/VNX00A_SYNTHETIC_CANARY.txt",
    pathname: CANARY,
  };
  assert.doesNotThrow(() => assertGitProtection(content, winner, CANARY));
  assert.throws(() => assertGitProtection("node_modules\n", winner, CANARY), /exactly one/);
  assert.throws(() => assertGitProtection(content, null, CANARY), /effective Git rule/);
});

test("Docker protection fails when removed or re-enabled by a later negation", () => {
  assert.doesNotThrow(() => assertDockerProtection(`node_modules\n/${CANARY}\n`, CANARY));
  assert.throws(() => assertDockerProtection("node_modules\n", CANARY), /exactly one/);
  assert.throws(
    () => assertDockerProtection(`/${CANARY}\n!*.txt\n`, CANARY),
    /later .dockerignore negation/,
  );
  assert.throws(
    () => assertDockerProtection(`/${CANARY}\n!**/VNX00A_SYNTHETIC_*\n`, CANARY),
    /later .dockerignore negation/,
  );
});

test("Dockerfile inspection accepts explicit tracked copies and prior stages", () => {
  const dockerfile = `
FROM node:22 AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY public ./public
COPY scripts ./scripts
COPY src ./src
FROM node:22
COPY --from=build /app ./
`;
  assert.equal(inspectDockerfile(dockerfile, tracked, "Dockerfile.prod.example"), 6);
});

test("Dockerfile inspection rejects equivalent broad COPY and ADD forms", () => {
  for (const instruction of ["COPY . .", "COPY ./ /app", 'COPY ["./", "/app"]', "ADD . /app", "ADD ./ /app"]) {
    assert.throws(
      () => inspectDockerfile(`FROM scratch\n${instruction}\n`, tracked, "Dockerfile.prod.example"),
      /broad or absolute/,
    );
  }
});

test("Dockerfile inspection only accepts COPY from previous build stages", () => {
  const previousStage = `
FROM scratch AS build
COPY package.json /app/
FROM scratch AS runner
COPY --from=build /app/package.json /app/package.json
`;
  assert.equal(inspectDockerfile(previousStage, tracked, "Dockerfile.prod.example"), 1);
  for (const dockerfile of [
    "FROM scratch AS runner\nCOPY --from=node:22 /app /app\n",
    "FROM scratch AS runner\nCOPY --from=runner /app /app\n",
    "FROM scratch AS runner\nCOPY --from=0 /app /app\n",
  ]) {
    assert.throws(
      () => inspectDockerfile(dockerfile, tracked, "Dockerfile.prod.example"),
      /previous build stage/,
    );
  }
});

test("Dockerfile inspection rejects untracked, globbed and traversing sources", () => {
  for (const instruction of ["COPY untracked.txt /app/", "COPY src/* /app/", "COPY ../src /app/"]) {
    assert.throws(
      () => inspectDockerfile(`FROM scratch\n${instruction}\n`, tracked, "Dockerfile.prod.example"),
      GuardFailure,
    );
  }
});

test("additional contexts and unsafe Compose contexts fail closed", () => {
  assert.doesNotThrow(() => assertNoAdditionalBuildContexts([["safe.yml", "build:\n  context: .\n"]]));
  assert.throws(
    () => assertNoAdditionalBuildContexts([["unsafe.yml", "additional_contexts:\n  assets: ../assets\n"]]),
    /additional Docker build context/,
  );
  const safeCompose = "services:\n  app:\n    build:\n      context: .\n      dockerfile: Dockerfile.prod.example\n";
  assert.doesNotThrow(() => assertComposeBuildContexts("compose.yml", safeCompose, tracked));
  assert.throws(
    () => assertComposeBuildContexts("compose.yml", safeCompose.replace("context: .", "context: .."), tracked),
    /other than the repository root/,
  );
  assert.throws(
    () => assertComposeBuildContexts("compose.yml", "services:\n  app:\n    build: ..\n", tracked),
    /inline build configuration/,
  );
});

test("CI policy requires an exact-head guard dependency and tracked-only worktree", () => {
  const workflow = `
jobs:
  build-context-guard:
    steps:
      - ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - run: test "$(git rev-parse HEAD)" = "\${{ github.event.pull_request.head.sha || github.sha }}"
      - run: node --test tests/vnx00a-build-context-guard.test.mjs
      - run: node scripts/vnx00a-build-context-guard.mjs
  validate:
    needs: build-context-guard
    defaults:
      run:
        working-directory: ../vnx00a-tracked
    steps:
      - ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - run: git worktree add --detach ../vnx00a-tracked HEAD
      - run: test "$(git -C ../vnx00a-tracked rev-parse HEAD)" = "\${{ github.event.pull_request.head.sha || github.sha }}"
      - run: npm ci
      - if: always()
        run: git worktree remove --force ../vnx00a-tracked
`;
  assert.doesNotThrow(() => assertCiPolicy(workflow));
  assert.throws(() => assertCiPolicy(workflow.replace("needs: build-context-guard", "needs: other")), /does not depend/);
});
