import { timingSafeEqual } from "node:crypto";
import { deliverReceivedOutbox } from "@/utils/mailbox-events/worker";
import { processReceivedCheckpoint } from "@/utils/mailbox-events/checkpoint-worker";

export const maxDuration = 300;

// Do not log authorization headers, response bodies, or provider identifiers.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = request.headers.get("authorization") || "";
  const expected = secret ? `Bearer ${secret}` : "";
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b))
    return new Response("Unauthorized", { status: 401 });
  const checkpoint = await processReceivedCheckpoint();
  const delivery = await deliverReceivedOutbox();
  return Response.json({ checkpoint, delivery });
}
