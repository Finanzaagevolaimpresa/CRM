import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROTECTED_PATH = "CRM TXT.txt";

export class GuardFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardFailure";
  }
}

function fail(message) {
  throw new GuardFailure(message);
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

export function parseNulRecords(buffer, label = "Git output") {
  if (!Buffer.isBuffer(buffer)) {
    fail(`${label} was not returned as bytes`);
  }
  if (buffer.length === 0) {
    return [];
  }
  if (buffer.at(-1) !== 0) {
    fail(`${label} is not NUL terminated`);
  }
  const records = decodeUtf8(buffer.subarray(0, -1), label).split("\0");
  if (records.some((record) => record.length === 0)) {
    fail(`${label} contains an empty record`);
  }
  return records;
}

export function normalizeRepoPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    fail("Repository path is empty or not a string");
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    fail(`Repository path is absolute: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    fail("Repository path contains control characters");
  }
  const slashPath = value.replaceAll("\\", "/").normalize("NFC");
  const segments = slashPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`Repository path is not canonical: ${value}`);
  }
  return slashPath;
}

function windowsIdentity(value) {
  return normalizeRepoPath(value).toLocaleLowerCase("en-US");
}

function runGitBytes(args, { cwd = process.cwd(), git = "git", exec = execFileSync } = {}) {
  try {
    const result = exec(git, args, {
      cwd,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return Buffer.isBuffer(result) ? result : Buffer.from(result ?? "");
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "Git executable not found" : `Git command failed (${error?.status ?? "unknown"})`;
    fail(reason);
  }
}

export function enumerateTrackedFiles(options = {}) {
  const output = runGitBytes(["ls-files", "-z", "--cached"], options);
  const files = parseNulRecords(output, "git ls-files output").map(normalizeRepoPath);
  if (files.length === 0) {
    fail("Tracked source set is empty");
  }
  const identities = new Set();
  for (const file of files) {
    const identity = windowsIdentity(file);
    if (identities.has(identity)) {
      fail("Tracked source set has a Windows-ambiguous path collision");
    }
    identities.add(identity);
  }
  return files;
}

export function assertProtectedUntracked(files, target = PROTECTED_PATH) {
  const targetIdentity = windowsIdentity(target);
  for (const file of files) {
    if (windowsIdentity(file) === targetIdentity) {
      fail("Protected path is tracked");
    }
  }
}

function readIndexedText(file, trackedSet, options) {
  const normalized = normalizeRepoPath(file);
  if (!trackedSet.has(normalized)) {
    fail(`Required guard input is not tracked: ${normalized}`);
  }
  const output = runGitBytes(["show", `:${normalized}`], options);
  return decodeUtf8(output, normalized);
}

function readGitIgnoreWinner(target, options) {
  let output;
  try {
    output = options.exec(options.git, ["check-ignore", "--no-index", "--verbose", "--stdin", "-z"], {
      cwd: options.cwd,
      encoding: null,
      input: Buffer.from(`${target}\0`),
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    if (error?.status === 1) {
      fail("Protected path is not effectively ignored by Git");
    }
    const reason = error?.code === "ENOENT" ? "Git executable not found" : `git check-ignore failed (${error?.status ?? "unknown"})`;
    fail(reason);
  }
  const records = parseNulRecords(Buffer.isBuffer(output) ? output : Buffer.from(output ?? ""), "git check-ignore output");
  if (records.length !== 4) {
    fail("git check-ignore returned an unanalysable result");
  }
  return {
    source: records[0],
    line: Number.parseInt(records[1], 10),
    pattern: records[2],
    pathname: records[3],
  };
}

export function assertGitProtection(content, winner, target = PROTECTED_PATH) {
  if (typeof content !== "string" || content.includes("\0")) {
    fail(".gitignore is not analysable text");
  }
  const exactPattern = `/${target}`;
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const exactLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === exactPattern) {
      exactLines.push(index + 1);
    }
  }
  if (exactLines.length !== 1) {
    fail("Tracked .gitignore must contain exactly one root-specific protected-path rule");
  }
  if (
    !winner ||
    normalizeRepoPath(winner.source) !== ".gitignore" ||
    winner.line !== exactLines[0] ||
    winner.pattern !== exactPattern ||
    windowsIdentity(winner.pathname) !== windowsIdentity(target)
  ) {
    fail("The root-specific .gitignore rule is not the effective Git rule");
  }
}

function dockerGlobRegex(pattern) {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return expression;
}

export function parseDockerIgnore(content) {
  if (typeof content !== "string" || content.includes("\0")) {
    fail(".dockerignore is not analysable text");
  }
  const rules = [];
  for (const [offset, rawLine] of content.replaceAll("\r\n", "\n").split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("\\") || /[\[\]{}]/u.test(line)) {
      fail(`.dockerignore line ${offset + 1} uses unsupported matching syntax`);
    }
    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;
    if (pattern === "" || pattern === ".") {
      fail(`.dockerignore line ${offset + 1} is not safely analysable`);
    }
    if (pattern.includes("\\")) {
      fail(`.dockerignore line ${offset + 1} uses an ambiguous separator`);
    }
    pattern = pattern.replace(/^\/+|\/+$/g, "");
    if (pattern === "") {
      fail(`.dockerignore line ${offset + 1} has an empty pattern`);
    }
    const hasSlash = pattern.includes("/");
    const body = dockerGlobRegex(pattern);
    const prefix = hasSlash ? "^" : "^(?:.*/)?";
    rules.push({
      line: offset + 1,
      raw: line,
      negated,
      matcher: new RegExp(`${prefix}${body}(?:$|/.*)`),
    });
  }
  return rules;
}

export function assertDockerProtection(content, target = PROTECTED_PATH) {
  const exactPattern = `/${target}`;
  const rules = parseDockerIgnore(content);
  const exactIndexes = [];
  let ignored = false;
  let lastMatchingIndex = -1;
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule.raw === exactPattern && !rule.negated) {
      exactIndexes.push(index);
    }
    if (rule.matcher.test(target)) {
      ignored = !rule.negated;
      lastMatchingIndex = index;
    }
  }
  if (exactIndexes.length !== 1) {
    fail("Tracked .dockerignore must contain exactly one root-specific protected-path rule");
  }
  const exactIndex = exactIndexes[0];
  for (let index = exactIndex + 1; index < rules.length; index += 1) {
    if (rules[index].negated && rules[index].matcher.test(target)) {
      fail("A later .dockerignore negation re-enables the protected path");
    }
  }
  if (!ignored || lastMatchingIndex !== exactIndex) {
    fail("The root-specific .dockerignore rule is not the effective Docker rule");
  }
}

function dockerLogicalLines(content, file) {
  const logical = [];
  let pending = "";
  for (const physical of content.replaceAll("\r\n", "\n").split("\n")) {
    const trimmedRight = physical.trimEnd();
    if (pending === "" && (trimmedRight.trim() === "" || trimmedRight.trimStart().startsWith("#"))) {
      continue;
    }
    if (trimmedRight.endsWith("\\")) {
      pending += `${trimmedRight.slice(0, -1)} `;
      continue;
    }
    const complete = `${pending}${trimmedRight}`.trim();
    pending = "";
    if (complete !== "") {
      logical.push(complete);
    }
  }
  if (pending !== "") {
    fail(`${file} ends with an incomplete instruction`);
  }
  return logical;
}

function parseInstructionArguments(rest, file) {
  let body = rest.trim();
  const flags = new Map();
  const valueFlags = new Set(["from", "chown", "chmod", "exclude"]);
  const booleanFlags = new Set(["link", "parents"]);
  while (body.startsWith("--")) {
    const match = body.match(/^--([A-Za-z][A-Za-z0-9-]*)(?:=([^\s]+))?(?:\s+|$)/);
    if (!match) {
      fail(`${file} contains an unanalysable COPY/ADD flag`);
    }
    const name = match[1].toLocaleLowerCase("en-US");
    if (!valueFlags.has(name) && !booleanFlags.has(name)) {
      fail(`${file} contains an unsupported COPY/ADD flag: --${name}`);
    }
    if ((valueFlags.has(name) && !match[2]) || (booleanFlags.has(name) && match[2])) {
      fail(`${file} contains an invalid COPY/ADD flag: --${name}`);
    }
    if (flags.has(name)) {
      fail(`${file} repeats a COPY/ADD flag: --${name}`);
    }
    flags.set(name, match[2] ?? true);
    body = body.slice(match[0].length).trim();
  }
  if (body === "") {
    fail(`${file} contains COPY/ADD without paths`);
  }
  let paths;
  if (body.startsWith("[")) {
    try {
      paths = JSON.parse(body);
    } catch {
      fail(`${file} contains invalid JSON COPY/ADD syntax`);
    }
    if (!Array.isArray(paths) || paths.some((item) => typeof item !== "string")) {
      fail(`${file} contains non-string JSON COPY/ADD paths`);
    }
  } else {
    if (/["'\\]/u.test(body)) {
      fail(`${file} contains shell COPY/ADD escaping that cannot be proved safe`);
    }
    paths = body.split(/\s+/u);
  }
  if (paths.length < 2 || paths.some((item) => item.length === 0)) {
    fail(`${file} contains COPY/ADD without a source and destination`);
  }
  return { flags, paths };
}

function normalizeDockerSource(source, file) {
  if (/^(?:https?|git|ssh):/iu.test(source) || source.startsWith("git@")) {
    fail(`${file} contains a remote ADD/COPY source`);
  }
  if (source.includes("\\") || source.includes("$") || /[*?\[]/u.test(source)) {
    fail(`${file} contains a dynamic or globbed ADD/COPY source`);
  }
  let normalized = source;
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized === "" || normalized === "." || normalized === "/" || normalized.startsWith("/")) {
    fail(`${file} contains a broad or absolute ADD/COPY source`);
  }
  normalized = normalizeRepoPath(normalized.replace(/\/+$/u, ""));
  return normalized;
}

export function inspectDockerfile(content, trackedFiles, file = "Dockerfile") {
  const trackedSet = new Set(trackedFiles.map(normalizeRepoPath));
  const stages = [];
  let contextSourceCount = 0;
  for (const logical of dockerLogicalLines(content, file)) {
    const match = logical.match(/^([A-Za-z]+)(?:\s+(.*))?$/u);
    if (!match) {
      fail(`${file} contains an unanalysable instruction`);
    }
    const instruction = match[1].toLocaleUpperCase("en-US");
    if (instruction === "FROM") {
      const from = (match[2] ?? "").trim().match(/^(?:--platform=\S+\s+)?\S+(?:\s+AS\s+([A-Za-z0-9_.-]+))?$/iu);
      if (!from) {
        fail(`${file} contains an unanalysable FROM instruction`);
      }
      const alias = from[1]?.toLocaleLowerCase("en-US") ?? null;
      if (alias && stages.some((stage) => stage.alias === alias)) {
        fail(`${file} repeats a build stage name: ${alias}`);
      }
      stages.push({ alias });
      continue;
    }
    if (instruction !== "COPY" && instruction !== "ADD") {
      continue;
    }
    if (stages.length === 0) {
      fail(`${file} contains COPY/ADD before its first FROM instruction`);
    }
    const { flags, paths } = parseInstructionArguments(match[2] ?? "", file);
    if (flags.has("from")) {
      const stage = flags.get("from");
      if (typeof stage !== "string" || stage.includes("$") || /\s/u.test(stage)) {
        fail(`${file} contains a dynamic COPY/ADD stage`);
      }
      const currentStageIndex = stages.length - 1;
      const numericStage = /^\d+$/u.test(stage) ? Number.parseInt(stage, 10) : null;
      const namedStageIndex = stages.findIndex(
        (candidate) => candidate.alias === stage.toLocaleLowerCase("en-US"),
      );
      if (
        (numericStage !== null && numericStage >= currentStageIndex) ||
        (numericStage === null && (namedStageIndex === -1 || namedStageIndex >= currentStageIndex))
      ) {
        fail(`${file} COPY/ADD --from must reference a previous build stage`);
      }
      continue;
    }
    if (flags.has("exclude")) {
      fail(`${file} contains a context exclusion that cannot be proved tracked-only`);
    }
    for (const source of paths.slice(0, -1)) {
      const normalized = normalizeDockerSource(source, file);
      if (windowsIdentity(normalized) === windowsIdentity(PROTECTED_PATH)) {
        fail(`${file} attempts to acquire the protected path`);
      }
      const exact = trackedSet.has(normalized);
      const prefix = `${normalized}/`;
      const directory = trackedFiles.some((candidate) => candidate.startsWith(prefix));
      if (!exact && !directory) {
        fail(`${file} context source is not tracked: ${normalized}`);
      }
      if (instruction === "ADD" && exact && /\.(?:tar|tar\.[a-z0-9]+|tgz|tbz2|txz)$/iu.test(normalized)) {
        fail(`${file} contains an archive ADD source that cannot be proved safe`);
      }
      contextSourceCount += 1;
    }
  }
  if (contextSourceCount === 0) {
    fail(`${file} has no explicit tracked build-context source`);
  }
  if (stages.length === 0) {
    fail(`${file} has no analysable FROM instruction`);
  }
  return contextSourceCount;
}

export function assertNoAdditionalBuildContexts(entries) {
  const forbidden = ["additional_" + "contexts", "--build-" + "context", "build-" + "contexts"];
  for (const [file, content] of entries) {
    for (const token of forbidden) {
      if (content.toLocaleLowerCase("en-US").includes(token)) {
        fail(`${file} configures an additional Docker build context`);
      }
    }
  }
}

export function assertComposeBuildContexts(file, content, trackedFiles) {
  const buildEntries = [...content.matchAll(/^[ \t]+build:[ \t]*([^\r\n]*)$/gmu)];
  const buildCount = buildEntries.length;
  if (buildCount === 0) {
    return;
  }
  if (buildEntries.some((match) => match[1].trim() !== "")) {
    fail(`${file} has an inline build configuration that cannot be proved safe`);
  }
  const contexts = [...content.matchAll(/^[ \t]+context:[ \t]*([^\r\n]+)$/gmu)].map((match) =>
    match[1].trim().replace(/^['"]|['"]$/g, ""),
  );
  const dockerfiles = [...content.matchAll(/^[ \t]+dockerfile:[ \t]*([^\r\n]+)$/gmu)].map((match) =>
    match[1].trim().replace(/^['"]|['"]$/g, ""),
  );
  if (contexts.length !== buildCount || dockerfiles.length !== buildCount) {
    fail(`${file} has an unanalysable build configuration`);
  }
  if (contexts.some((context) => context !== ".")) {
    fail(`${file} uses a Docker build context other than the repository root`);
  }
  const trackedSet = new Set(trackedFiles);
  for (const dockerfile of dockerfiles) {
    if (!trackedSet.has(normalizeRepoPath(dockerfile))) {
      fail(`${file} references an untracked Dockerfile`);
    }
  }
}

function extractWorkflowJob(content, jobName) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  if (start === -1) {
    fail(`CI job is missing: ${jobName}`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export function assertCiPolicy(content) {
  const guardJob = extractWorkflowJob(content, "build-context-guard");
  const validateJob = extractWorkflowJob(content, "validate");
  if (/^ {4}services:/mu.test(guardJob)) {
    fail("Build-context guard CI job must not start services");
  }
  const selfTest = guardJob.indexOf("node --test tests/vnx00a-build-context-guard.test.mjs");
  const guardRun = guardJob.indexOf("node scripts/vnx00a-build-context-guard.mjs");
  if (selfTest === -1 || guardRun === -1 || selfTest > guardRun) {
    fail("CI guard job does not run self-tests before the guard");
  }
  if (!/^ {4}needs: build-context-guard\s*$/mu.test(validateJob)) {
    fail("CI validation job does not depend on the build-context guard");
  }
  const exactHead = "ref: ${{ github.event.pull_request.head.sha || github.sha }}";
  if (!guardJob.includes(exactHead) || !validateJob.includes(exactHead)) {
    fail("CI checkouts do not pin the effective pull-request head");
  }
  if (!guardJob.includes('test "$(git rev-parse HEAD)" = "${{ github.event.pull_request.head.sha || github.sha }}"')) {
    fail("CI guard job does not verify its effective pull-request head");
  }
  const snapshot = validateJob.indexOf("git worktree add --detach ../vnx00a-tracked HEAD");
  const install = validateJob.indexOf("run: npm ci");
  if (snapshot === -1 || install === -1 || snapshot > install) {
    fail("CI does not create the tracked-only worktree before source-consuming tools");
  }
  if (!validateJob.includes("working-directory: ../vnx00a-tracked")) {
    fail("CI validation commands are not rooted in the tracked-only worktree");
  }
  if (!validateJob.includes('test "$(git -C ../vnx00a-tracked rev-parse HEAD)" = "${{ github.event.pull_request.head.sha || github.sha }}"')) {
    fail("CI tracked-only worktree does not verify its effective pull-request head");
  }
  if (!validateJob.includes("if: always()") || !validateJob.includes("git worktree remove --force ../vnx00a-tracked")) {
    fail("CI tracked-only worktree cleanup is missing");
  }
}

function isDockerfile(file) {
  return /(?:^|\/)Dockerfile(?:\..+)?$/u.test(file);
}

function isComposeFile(file) {
  const base = path.posix.basename(file);
  return /^(?:docker-)?compose(?:\.[^.]+)*\.ya?ml$/iu.test(base);
}

function isBuildControlFile(file) {
  return (
    file === "package.json" ||
    file.startsWith(".github/workflows/") ||
    isDockerfile(file) ||
    isComposeFile(file) ||
    (/^scripts\//u.test(file) && /\.(?:sh|ps1|mjs|cjs|js|ts)$/iu.test(file))
  );
}

export function runGuard({ cwd = process.cwd(), git = "git", exec = execFileSync } = {}) {
  const options = { cwd, git, exec };
  const trackedFiles = enumerateTrackedFiles(options);
  assertProtectedUntracked(trackedFiles);
  const trackedSet = new Set(trackedFiles);
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) {
      cache.set(file, readIndexedText(file, trackedSet, options));
    }
    return cache.get(file);
  };

  const gitIgnore = read(".gitignore");
  const gitWinner = readGitIgnoreWinner(PROTECTED_PATH, options);
  assertGitProtection(gitIgnore, gitWinner);
  assertDockerProtection(read(".dockerignore"));

  const dockerfiles = trackedFiles.filter(isDockerfile);
  if (dockerfiles.length === 0) {
    fail("No tracked Dockerfile was found");
  }
  let dockerSources = 0;
  for (const dockerfile of dockerfiles) {
    dockerSources += inspectDockerfile(read(dockerfile), trackedFiles, dockerfile);
  }

  const controlEntries = trackedFiles.filter(isBuildControlFile).map((file) => [file, read(file)]);
  assertNoAdditionalBuildContexts(controlEntries);
  for (const file of trackedFiles.filter(isComposeFile)) {
    assertComposeBuildContexts(file, read(file), trackedFiles);
  }
  assertCiPolicy(read(".github/workflows/ci.yml"));

  return { trackedFiles: trackedFiles.length, dockerfiles: dockerfiles.length, dockerSources };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  try {
    const result = runGuard();
    process.stdout.write(
      `VNX-00A build-context guard PASS: ${result.trackedFiles} tracked files, ${result.dockerfiles} Dockerfile, ${result.dockerSources} explicit context sources\n`,
    );
  } catch (error) {
    const message = error instanceof GuardFailure ? error.message : "Unexpected guard failure";
    process.stderr.write(`VNX-00A build-context guard FAIL: ${message}\n`);
    process.exitCode = 1;
  }
}
