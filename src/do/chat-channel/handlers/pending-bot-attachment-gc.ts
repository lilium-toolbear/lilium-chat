import { logSwallowedError } from "../../../errors";
import type { Env } from "../../../env";
import { deleteObject } from "../../../s3/presign";
import type { DueRow } from "../../shared/scheduler";

export async function flushExpiredPendingBotAttachments(
  env: Env,
  sql: DurableObjectState["storage"]["sql"],
  rows: DueRow[],
): Promise<void> {
  for (const row of rows) {
    const attachmentId = typeof row.attachment_id === "string" ? row.attachment_id : "";
    const storageKey = typeof row.storage_key === "string" ? row.storage_key : "";
    const ownerBotId = typeof row.owner_bot_id === "string" ? row.owner_bot_id : null;
    if (!attachmentId || !storageKey || !ownerBotId) {
      continue;
    }

    try {
      await deleteObject(env, storageKey);
    } catch (err) {
      logSwallowedError("pending_bot_attachment_object_delete_failed", err, {
        attachment_id: attachmentId,
        storage_key: storageKey,
      });
    }

    sql.exec(
      "DELETE FROM attachments WHERE attachment_id=? AND status='pending' AND owner_bot_id IS NOT NULL",
      attachmentId,
    );
  }
}
