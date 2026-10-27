import { readSessionMessageSequence } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { removePairingQrContent } from "../../lib/chat/pairing-qr.ts";
import {
  MAX_CHAT_THUMBNAILS,
  MAX_CHAT_THUMBNAIL_BYTES,
  MAX_CHAT_THUMBNAIL_SIZE,
} from "../../lib/chat/row-display-facts.ts";
import {
  isChatTranscriptMetadata,
  isProgressCard,
  isMessageReactionSummary,
} from "../../lib/protocol-validators.generated/transcript.js";
import * as json from "../../lib/snapshot-json.ts";
import { projectChatMessageReactions } from "./chat-message-reactions-snapshot.ts";
import { type ChatSessionSnapshot } from "./session-message-cache.ts";
import {
  boundChatThumbnails,
  chatThumbnailWeight,
  projectChatRowDisplay,
} from "./session-message-display-facts.ts";

export const CHAT_SNAPSHOT_PROJECTION_VERSION = 6;
const CHAT_SNAPSHOT_MESSAGE_LIMIT = 80;

const nonnegative = json.refine(json.number, (value) => value >= 0);
const sessionKeySchema = json.refine(json.text, (value) => value.length > 0);
const completePaginationSchema = json.object(
  {
    completeSnapshot: json.optional(json.literal(true)),
    hasMore: json.literal(false),
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const morePaginationSchema = json.object(
  {
    hasMore: json.literal(true),
    nextOffset: nonnegative,
    totalMessages: json.optional(nonnegative),
  },
  true,
);
const paginationSchema = {
  parse(value: unknown) {
    return asOptionalRecord(value)?.hasMore === true
      ? morePaginationSchema.parse(value)
      : completePaginationSchema.parse(value);
  },
};
const permissionModeSchema = json.enumeration(["read-only", "guarded", "workspace", "full"]);
const shortText = json.refine(json.text, (value) => value.length <= 256);
const displayKey = json.refine(json.text, (value) => value.length <= 4096);
const boundedDisplayRecord = <T>(reader: json.SnapshotReader<T>) =>
  json.refine(
    json.record(reader),
    (value) =>
      Object.keys(value).length <= 8 &&
      Object.keys(value).every((key) => displayKey.parse(key) === key),
  );
const thumbnailSchema = json.checked(
  (value): value is Blob =>
    value instanceof Blob &&
    value.size > 0 &&
    value.size <= MAX_CHAT_THUMBNAIL_SIZE &&
    /^(?:image\/png|image\/jpeg|image\/webp|image\/avif)$/u.test(value.type),
);
const imageDimension = json.refine(
  json.number,
  (value) => Number.isInteger(value) && value > 0 && value <= 100_000,
);
const snapshotSchema = json.object(
  {
    rowDisplay: json.optional(
      json.refine(
        json.record(
          json.object({
            links: json.optional(
              boundedDisplayRecord(
                json.object({
                  title: json.optional(shortText),
                  badge: json.optional(
                    json.object({
                      label: shortText,
                      tone: json.enumeration([
                        "neutral",
                        "positive",
                        "negative",
                        "attention",
                        "accent",
                      ]),
                    }),
                  ),
                }),
              ),
            ),
            images: json.optional(
              boundedDisplayRecord(
                json.object({
                  width: imageDimension,
                  height: imageDimension,
                  rendition: json.checked(
                    (value): value is 480 | 960 => value === 480 || value === 960,
                  ),
                  thumbnail: json.optional(thumbnailSchema),
                }),
              ),
            ),
          }),
        ),
        (rows) => Object.keys(rows).length <= 80,
      ),
    ),
    avatarSources: json.optional(
      json.refine(
        json.record(json.nullable(json.refine(json.text, (value) => value.length <= 2048))),
        (value) => Object.keys(value).length <= 24,
      ),
    ),
    composer: json.optional(
      json.nullable(
        json.object({
          id: json.text,
          provider: json.text,
          name: json.text,
          reasoning: json.optional(json.boolean),
          speed: json.optional(
            json.object({
              active: json.boolean,
              currentOverride: json.enumeration(["", "on", "off", "auto", "ultrafast"]),
              label: json.text,
              supported: json.boolean,
            }),
          ),
          thinkingLevel: json.optional(json.text),
          thinkingDefault: json.optional(json.text),
          thinkingLevels: json.optional(
            json.array(json.object({ id: json.text, label: json.text }), 30),
          ),
          permissionMode: json.optional(permissionModeSchema),
          defaultPermissionMode: json.optional(permissionModeSchema),
        }),
      ),
    ),
    board: json.optional(
      json.nullable(json.object({ snapshot: json.unknown, receivedAtMs: nonnegative }, true)),
    ),
    widgetHeights: json.optional(
      json.refine(
        json.record(json.refine(json.number, (height) => height >= 1 && height <= 8000)),
        (heights) => Object.keys(heights).length <= 100,
      ),
    ),
    transcriptMetadata: json.optional(json.checked(isChatTranscriptMetadata)),
    messageReactions: json.optional(
      json.record(json.array(json.checked(isMessageReactionSummary))),
    ),
    progressCard: json.optional(json.nullable(json.checked(isProgressCard))),
    deltaCursor: json.optional(json.text),
    // Only persisted warm metadata needs its full validator; read admission loads it below.
    historyState: json.optional(json.unknown),
    displayedLeafEntryId: json.optional(json.nullable(json.text)),
    // Message contents are opaque; only the array boundary needs validation.
    messages: json.checked<unknown[]>(Array.isArray),
    pagination: paginationSchema,
    sessionId: json.nullable(json.text),
  },
  true,
);
export const recordSchema = json.refine(
  json.object(
    {
      projectionVersion: json.refine(
        json.number,
        (value) => Number.isSafeInteger(value) && value > 0,
      ),
      savedAt: nonnegative,
      sessionId: json.nullable(json.text),
      sessionKey: sessionKeySchema,
      snapshot: snapshotSchema,
    },
    true,
  ),
  (record) => {
    const thumbnails = chatThumbnailWeight(record.snapshot);
    return (
      record.sessionId === record.snapshot.sessionId &&
      thumbnails.count <= MAX_CHAT_THUMBNAILS &&
      thumbnails.bytes <= MAX_CHAT_THUMBNAIL_BYTES
    );
  },
);

export type SessionSnapshotRecord = Omit<json.SnapshotValue<typeof recordSchema>, "snapshot"> & {
  snapshot: ChatSessionSnapshot;
};
const metadataFields = {
  savedAt: nonnegative,
  sessionKey: sessionKeySchema,
};
export const metadataSchema = json.object(
  {
    ...metadataFields,
    weight: nonnegative,
    thumbnailCount: json.defaulted(nonnegative, () => 0),
    thumbnailBytes: json.defaulted(nonnegative, () => 0),
  },
  true,
);
export type SessionSnapshotMetadata = json.SnapshotValue<typeof metadataSchema>;
export type PreparedSnapshotRecord = {
  record: SessionSnapshotRecord;
  metadata: SessionSnapshotMetadata;
};
export type PendingSessionState = {
  savedAt: number;
  snapshot: ChatSessionSnapshot;
};
export function createSnapshotRecord(
  sessionKey: string,
  pending: PendingSessionState,
): PreparedSnapshotRecord | null {
  let snapshot: ChatSessionSnapshot;
  let weight: number;
  try {
    let projected = pending.snapshot;
    const messages = projected.messages;
    let start = Math.max(0, messages.length - CHAT_SNAPSHOT_MESSAGE_LIMIT);
    // A history entry can project multiple rows; retain its whole sequence group.
    while (start > 0) {
      const seq = readSessionMessageSequence(messages[start]);
      if (seq === null || seq !== readSessionMessageSequence(messages[start - 1])) {
        break;
      }
      start--;
    }
    if (start > 0) {
      // Display rows are not Gateway page boundaries. Refill from zero on the
      // first upward scroll; the history owner deduplicates the overlap and
      // returns the next authoritative offset, including merged CLI histories.
      projected = {
        ...projected,
        messages: messages.slice(start),
        pagination: {
          hasMore: true,
          nextOffset: 0,
          ...(projected.pagination.totalMessages !== undefined
            ? { totalMessages: projected.pagination.totalMessages }
            : {}),
        },
      };
    }
    if (projected.messageReactions) {
      projected = {
        ...projected,
        messageReactions: projectChatMessageReactions(
          projected.messages,
          new Map(Object.entries(projected.messageReactions)),
        ),
      };
    }
    const rowDisplay = projectChatRowDisplay(projected);
    if (rowDisplay !== projected.rowDisplay) {
      projected = { ...projected, rowDisplay };
    }
    projected = boundChatThumbnails(projected);
    // Pairing credentials stay in the live projection, never the browser's disk cache.
    let redacted = false;
    const serialized = JSON.stringify(projected, (_key, value: unknown) => {
      if (value instanceof Blob) {
        return undefined;
      }
      if (value === projected.messages) {
        return projected.messages.map((message) => {
          const record = asOptionalRecord(message);
          if (!record || !Object.hasOwn(record, "openclawResponsesInputReplay")) {
            return message;
          }
          const { openclawResponsesInputReplay: _replay, ...display } = record;
          return display;
        });
      }
      const sanitized = removePairingQrContent(value);
      redacted ||= sanitized !== value;
      return sanitized;
    });
    snapshot = JSON.parse(serialized);
    // Structured clone stores bounded thumbnails alongside the JSON projection.
    // No image decode or object URL creation runs on the snapshot-read path.
    for (const [id, row] of Object.entries(projected.rowDisplay ?? {})) {
      for (const [key, image] of Object.entries(row.images ?? {})) {
        if (image.thumbnail && snapshot.rowDisplay?.[id]?.images?.[key]) {
          snapshot.rowDisplay[id]!.images![key]!.thumbnail = image.thumbnail;
        }
      }
    }
    // A receipt cannot certify metadata changed by the disk privacy projection.
    if (redacted) {
      delete snapshot.historyState;
    }
    weight = serialized.length;
  } catch {
    return null;
  }
  const envelope = {
    projectionVersion: CHAT_SNAPSHOT_PROJECTION_VERSION,
    savedAt: pending.savedAt,
    sessionId: pending.snapshot.sessionId,
    sessionKey,
  };
  const thumbnails = chatThumbnailWeight(snapshot);
  return {
    record: { ...envelope, snapshot },
    metadata: {
      savedAt: pending.savedAt,
      sessionKey,
      weight: weight + JSON.stringify(envelope).length,
      thumbnailCount: thumbnails.count,
      thumbnailBytes: thumbnails.bytes,
    },
  };
}
