/**
 * Workspace path resolution — hand-written.
 *
 * Mirrors the bridge worker's `resolveWorkspacePath`: a path without a
 * leading `/` is resolved under `/workspace`, an absolute path is used
 * verbatim, and the result is POSIX-normalized (`.`/`..` folded). Anything
 * escaping `/workspace` resolves to `undefined` — the same condition the
 * file endpoints answer with 403 `invalid_request`.
 *
 * The file endpoints apply this server-side; operations synthesized
 * through exec (there is no stat/list/mkdir/remove endpoint) must apply
 * the identical rule before embedding a path in argv, or a relative path
 * would resolve against the container root instead of the workspace.
 */
export const WORKSPACE_ROOT = "/workspace";

export const resolveSandboxPath = (userPath: string): string | undefined => {
  const abs = userPath.startsWith("/")
    ? userPath
    : `${WORKSPACE_ROOT}/${userPath}`;

  const parts: Array<string> = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }

  const resolved = `/${parts.join("/")}`;
  return resolved === WORKSPACE_ROOT ||
    resolved.startsWith(`${WORKSPACE_ROOT}/`)
    ? resolved
    : undefined;
};
