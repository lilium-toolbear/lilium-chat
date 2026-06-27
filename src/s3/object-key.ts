import { s3PublicObjectUrl } from "./url";

/** Object key prefix inside the s3.kuma.homes bucket. */
export const ATTACHMENT_NAMESPACE = "chat/attachments";
export const AVATAR_NAMESPACE = "chat/avatars";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const ALLOWED_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

/** Derive a safe object suffix from the client filename, falling back to mime_type. */
export function attachmentFileExtension(filename: string, mimeType: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot > 0 && dot < base.length - 1) {
    const ext = base.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,10}$/.test(ext) && ALLOWED_EXTENSIONS.has(ext)) {
      return ext;
    }
  }
  return EXT_BY_MIME[mimeType] ?? "bin";
}

function namespacedObjectKey(namespace: string, attachmentId: string, filename: string, mimeType: string): string {
  const ext = attachmentFileExtension(filename, mimeType);
  return `${namespace}/${attachmentId}.${ext}`;
}

export function attachmentObjectKey(attachmentId: string, filename: string, mimeType: string): string {
  return namespacedObjectKey(ATTACHMENT_NAMESPACE, attachmentId, filename, mimeType);
}

export function avatarObjectKey(attachmentId: string, filename: string, mimeType: string): string {
  return namespacedObjectKey(AVATAR_NAMESPACE, attachmentId, filename, mimeType);
}

export function attachmentPublicUrl(
  publicBase: string,
  attachmentId: string,
  filename: string,
  mimeType: string,
): string {
  return s3PublicObjectUrl(publicBase, attachmentObjectKey(attachmentId, filename, mimeType));
}

export function avatarPublicUrl(
  publicBase: string,
  attachmentId: string,
  filename: string,
  mimeType: string,
): string {
  return s3PublicObjectUrl(publicBase, avatarObjectKey(attachmentId, filename, mimeType));
}
