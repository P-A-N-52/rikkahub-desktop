// api/handlers/workspaces.ts — 工作区路由(agent 模式,§5.4)
// CRUD + 信任门确认。工具执行/文件面板路由随 M1-4/M3 加入。

import type { Workspace } from "../../foundation/types";
import type { WorkspaceDto } from "../../foundation/types/dto";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, trustWorkspace, updateWorkspace, workspaceStatus } from "../../workspace";
import { deleteWorkspaceEntry, listWorkspaceDir, previewWorkspaceFile, renameWorkspaceEntry, revealWorkspaceEntry } from "../../workspace/files";
import { error, json, readJson } from "../request";

function toDto(workspace: Workspace): WorkspaceDto {
  return { ...workspace, status: workspaceStatus(workspace) };
}

export async function handleWorkspaceRoutes(request: Request, _url: URL, path: string): Promise<Response | null> {
  if (path === "workspaces" && request.method === "GET") {
    return json({ workspaces: listWorkspaces().map(toDto) });
  }

  if (path === "workspaces" && request.method === "POST") {
    const body = await readJson<{ type?: string; name?: string; root?: string }>(request);
    const type = String(body.type ?? "");
    if (type !== "managed" && type !== "folder") return error("type must be managed or folder", 400);
    try {
      return json({ workspace: toDto(createWorkspace({ type, name: body.name, root: body.root })) });
    } catch (err) {
      return error(err instanceof Error ? err.message : "创建工作区失败", 400);
    }
  }

  const workspaceRoute = path.match(/^workspaces\/([^/]+)(?:\/(.*))?$/);
  if (!workspaceRoute) return null;
  const workspaceId = decodeURIComponent(workspaceRoute[1]);
  const sub = workspaceRoute[2] ?? "";

  if (!sub && request.method === "GET") {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    return json({ workspace: toDto(workspace) });
  }

  if (!sub && request.method === "PATCH") {
    const body = await readJson<{ name?: string; permissionPreset?: string }>(request);
    try {
      const updated = updateWorkspace(workspaceId, body);
      if (!updated) return error("Workspace not found", 404);
      return json({ workspace: toDto(updated) });
    } catch (err) {
      return error(err instanceof Error ? err.message : "更新工作区失败", 400);
    }
  }

  // ---- 文件面板路由(M3-5,§4.4):path 参数为相对 root 的路径,边界断言在领域层 ----
  if (sub === "files" || sub.startsWith("files/")) {
    const workspace = getWorkspace(workspaceId);
    if (!workspace) return error("Workspace not found", 404);
    const relPath = _url.searchParams.get("path") ?? "";
    try {
      if (sub === "files" && request.method === "GET") {
        return json({ entries: listWorkspaceDir(workspace, relPath) });
      }
      if (sub === "files/content" && request.method === "GET") {
        return json({ preview: await previewWorkspaceFile(workspace, relPath) });
      }
      if (sub === "files/rename" && request.method === "POST") {
        const body = await readJson<{ path?: string; newName?: string }>(request);
        renameWorkspaceEntry(workspace, String(body.path ?? ""), String(body.newName ?? ""));
        return new Response(null, { status: 204 });
      }
      if (sub === "files" && request.method === "DELETE") {
        deleteWorkspaceEntry(workspace, relPath);
        return new Response(null, { status: 204 });
      }
      if (sub === "files/reveal" && request.method === "POST") {
        const body = await readJson<{ path?: string }>(request);
        revealWorkspaceEntry(workspace, String(body.path ?? ""));
        return new Response(null, { status: 204 });
      }
      return null;
    } catch (err) {
      return error(err instanceof Error ? err.message : "文件操作失败", 400);
    }
  }

  if (sub === "trust" && request.method === "POST") {
    const trusted = trustWorkspace(workspaceId);
    if (!trusted) return error("Workspace not found", 404);
    return json({ workspace: toDto(trusted) });
  }

  if (!sub && request.method === "DELETE") {
    if (!deleteWorkspace(workspaceId)) return error("Workspace not found", 404);
    return new Response(null, { status: 204 });
  }

  return null;
}
