import { DecryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { parseMasterKey } from "./crypto.js";

/**
 * Master key custody.
 *
 * Two ways to supply the master key:
 *  - PROVIDER_MASTER_KEY: the raw key in a server setting. Test networks only.
 *  - PROVIDER_MASTER_KEY_KMS_CIPHERTEXT (+ PROVIDER_KMS_KEY_ID): the master key
 *    encrypted under an AWS KMS key (envelope encryption). The plaintext exists
 *    only in this process's memory; the server setting alone is useless without
 *    IAM permission to call kms:Decrypt on that key, and every decrypt is logged
 *    in CloudTrail.
 *
 * Make the ciphertext once:
 *   aws kms generate-data-key --key-id <key> --key-spec AES_256 \
 *     --query CiphertextBlob --output text
 */
export type KeySource = "env" | "aws-kms";

export interface Decryptor {
  decrypt(ciphertext: Buffer, keyId: string): Promise<Buffer>;
}

export const awsKms = (region?: string): Decryptor => {
  const client = new KMSClient(region ? { region } : {});
  return {
    async decrypt(ciphertext, keyId) {
      const out = await client.send(new DecryptCommand({ CiphertextBlob: ciphertext, KeyId: keyId, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" }));
      if (!out.Plaintext) throw new Error("KMS returned no plaintext");
      return Buffer.from(out.Plaintext);
    },
  };
};

export async function loadMasterKey(
  env: Record<string, string | undefined>,
  kms: () => Decryptor = () => awsKms(env.PROVIDER_KMS_REGION),
): Promise<{ key: Buffer; source: KeySource }> {
  const blob = env.PROVIDER_MASTER_KEY_KMS_CIPHERTEXT;
  if (blob) {
    if (env.PROVIDER_MASTER_KEY) throw new Error("set PROVIDER_MASTER_KEY or PROVIDER_MASTER_KEY_KMS_CIPHERTEXT, not both");
    const keyId = env.PROVIDER_KMS_KEY_ID;
    if (!keyId) throw new Error("PROVIDER_KMS_KEY_ID is required with PROVIDER_MASTER_KEY_KMS_CIPHERTEXT");
    const plain = await kms().decrypt(Buffer.from(blob, "base64"), keyId);
    try {
      return { key: parseMasterKey(plain.toString("hex")), source: "aws-kms" };
    } finally {
      plain.fill(0);
    }
  }
  if (!env.PROVIDER_MASTER_KEY) throw new Error("PROVIDER_MASTER_KEY_KMS_CIPHERTEXT (AWS KMS) or PROVIDER_MASTER_KEY (test networks only) is required");
  return { key: parseMasterKey(env.PROVIDER_MASTER_KEY), source: "env" };
}
