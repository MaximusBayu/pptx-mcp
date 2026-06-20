import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const bucket = process.env.S3_BUCKET ?? "pptx";

const credentials = {
  accessKeyId: process.env.S3_ACCESS_KEY ?? "minioadmin",
  secretAccessKey: process.env.S3_SECRET_KEY ?? "minioadmin",
};
const region = process.env.S3_REGION ?? "us-east-1";

// Internal client: container-to-container put/get over the compose network.
const client = new S3Client({
  region,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials,
});

// Presign client: signs URLs with a host the *caller's* browser can reach.
// Falls back to the internal endpoint when no public endpoint is configured
// (e.g. an agent running inside the Docker network).
const presignEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT;
const presignClient = new S3Client({
  region,
  endpoint: presignEndpoint,
  forcePathStyle: true,
  credentials,
});

export async function putObject(key: string, body: Buffer, contentType: string) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await r.Body!.transformToByteArray());
}

export function presignGet(key: string, ttl = 3600) {
  return getSignedUrl(presignClient, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttl });
}
