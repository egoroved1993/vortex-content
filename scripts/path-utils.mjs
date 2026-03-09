import fs from "node:fs";
import path from "node:path";

export function detectProjectRoot(start = process.cwd()) {
  const cwd = path.resolve(start);

  if (looksLikeGithubActionsRepo(cwd)) return cwd;

  const nested = path.join(cwd, "github-actions");
  if (looksLikeGithubActionsRepo(nested)) return nested;

  return cwd;
}

export function resolveProjectPath(...segments) {
  return path.resolve(detectProjectRoot(), ...segments);
}

function looksLikeGithubActionsRepo(candidate) {
  return (
    fs.existsSync(path.join(candidate, "scripts")) &&
    fs.existsSync(path.join(candidate, "content"))
  );
}
