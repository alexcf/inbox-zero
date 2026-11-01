import { timingSafeEqual } from "node:crypto";
import { deliverReceivedOutbox } from "@/utils/mailbox-events/worker";

// Do not log authorization headers, response bodies, or provider identifiers.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = request.headers.get("authorization") || "";
  const expected = secret ? `Bearer ${secret}` : "";
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b))
    return new Response("Unauthorized", { status: 401 });
  return Response.json(await deliverReceivedOutbox());
}
