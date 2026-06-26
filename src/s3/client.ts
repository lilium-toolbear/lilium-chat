import { AwsClient } from "aws4fetch";
import type { Env } from "../env";

// S3Client interface matching aws4fetch.AwsClient's actual API surface (sign + fetch, NOT presign).
// Tests inject a fake via setTestS3Client.
export interface S3Client {
  sign(
    input: string | URL,
    init?: (RequestInit & {
      aws?: {
        signQuery?: boolean;
        allHeaders?: boolean;
        datetime?: string;
        singleEncode?: boolean;
        appendSessionToken?: boolean;
      };
    }) | null,
  ): Promise<Request>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function createS3Client(env: Env): S3Client {
  return new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
    service: "s3",
  }) as unknown as S3Client;
}

let _testClient: S3Client | null = null;

export function setTestS3Client(client: S3Client | null): void {
  _testClient = client;
}

export function getS3Client(env: Env): S3Client {
  return _testClient ?? createS3Client(env);
}

export function isTestS3ClientActive(): boolean {
  return _testClient !== null;
}