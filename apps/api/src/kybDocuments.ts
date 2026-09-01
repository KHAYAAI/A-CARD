import { randomBytes } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage for merchant KYB registration documents — the piece
 * explicitly deferred when the operator console shipped ("registration
 * documents are collected and filed outside this console for now"). The API
 * never touches the file bytes: it hands the browser a presigned PUT URL,
 * the browser uploads straight to the bucket, and only the storage key
 * (never the contents) is recorded against the merchant's KYB record.
 *
 * The narrow interface app.ts depends on mirrors every other optional
 * integration in this file (`payfast.ts`, `sudo.ts`, `merchantAuthKit.ts`):
 * a config object builds the real S3 client, a fake implementing this
 * interface in tests.
 */

export interface KybDocumentStoreConfig {
  bucket: string;
  region: string;
}

export interface PresignedUpload {
  key: string;
  uploadUrl: string;
}

export interface KybDocumentStore {
  /** A short-lived URL the browser PUTs the file bytes to directly — never routed through this API. */
  createUploadUrl(merchantId: string, filename: string, contentType: string): Promise<PresignedUpload>;
  /** A short-lived URL to view/download an already-uploaded document. */
  createDownloadUrl(key: string): Promise<string>;
}

const UPLOAD_URL_TTL_SECONDS = 300; // 5 minutes — long enough for a slow upload, short enough not to be a standing credential
const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Keeps a document's storage key scoped to its merchant and free of path traversal, regardless of what the filename contains. */
function safeKey(merchantId: string, filename: string): string {
  const ext = (filename.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0] ?? "").toLowerCase();
  return `kyb/${merchantId}/${randomBytes(16).toString("hex")}${ext}`;
}

export function createKybDocumentStore(config: KybDocumentStoreConfig): KybDocumentStore {
  const s3 = new S3Client({ region: config.region });

  return {
    async createUploadUrl(merchantId, filename, contentType) {
      const key = safeKey(merchantId, filename);
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType }),
        { expiresIn: UPLOAD_URL_TTL_SECONDS },
      );
      return { key, uploadUrl };
    },

    async createDownloadUrl(key) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        expiresIn: DOWNLOAD_URL_TTL_SECONDS,
      });
    },
  };
}
