import type { GatewaySessionRow } from "../../api/types.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveUiSessionNavigationParentKey } from "../../lib/sessions/session-key.ts";
import * as json from "../../lib/snapshot-json.ts";
import type { ChatState } from "./chat-state-contract.ts";

export const chatSessionStateSnapshotSchema = json.object({
  archived: json.optional(json.boolean),
  unarchiveAllowed: json.boolean,
  visibility: json.optional(json.enumeration(["read-only", "shared", "suggest", "draft"])),
  sharingRole: json.optional(json.enumeration(["owner", "admin", "member", "viewer"])),
  parentSession: json.optional(json.nullable(json.object({ key: json.text, title: json.text }))),
});

export type ChatSessionStateSnapshot = json.SnapshotValue<typeof chatSessionStateSnapshotSchema>;

export function projectChatSessionStateSnapshot(
  state: Pick<ChatState, "client" | "hello" | "connected" | "sessionKey">,
  session: GatewaySessionRow,
  previous: ChatSessionStateSnapshot | undefined,
): ChatSessionStateSnapshot {
  return {
    archived: session.archived,
    // Display only; the composer still requires current live mutation authority.
    unarchiveAllowed: readSessionMethodAccess(
      {
        client: state.client,
        hello: state.hello,
        phase: state.connected ? "connected" : "offline",
      },
      {
        method: "sessions.patch",
        params: { key: state.sessionKey, archived: false },
        sessionScope: true,
        session,
        allowDeferred: true,
      },
    ).allowed,
    visibility: session.visibility,
    sharingRole: session.sharingRole,
    parentSession:
      resolveUiSessionNavigationParentKey(session) === previous?.parentSession?.key
        ? previous?.parentSession
        : null,
  };
}
