import { createSessionStore } from "@tideline/db/sessions";
import { createDigestDelivery } from "./digest-delivery";

const databaseUrl = process.env.NEON_DB_URL;
if (!databaseUrl) {
  throw new Error("Set NEON_DB_URL to run the Tideline worker.");
}

const sessions = createSessionStore(databaseUrl);
const digestDelivery = createDigestDelivery(databaseUrl, sessions);
let deliveryCheck = 0;
let delivery = Promise.resolve();
let stopping = false;

function stop() {
  stopping = true;
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

console.info("Tideline worker is ready to process imports.");
let working = true;

try {
  while (!stopping) {
    if (digestDelivery && Date.now() >= deliveryCheck) {
      deliveryCheck = Infinity;
      delivery = digestDelivery.run().catch((error: unknown) => {
        console.error("Tideline could not check scheduled digest delivery.", { error: error instanceof Error ? error.name : "UnknownError" });
      }).finally(() => { deliveryCheck = Date.now() + 60_000; });
    }
    try {
      const processed = await sessions.processNext();
      if (!working) {
        console.info("Tideline worker database access recovered.");
        working = true;
      }
      if (processed) {
        console.info("Processed agent session.", { id: processed });
        continue;
      }
    } catch (error) {
      if (working) {
        console.error("Tideline worker could not process imports.", { error: error instanceof Error ? error.name : "UnknownError" });
        working = false;
      }
    }

    await Bun.sleep(1_000);
  }
} finally {
  await delivery;
  await digestDelivery?.close();
  await sessions.close();
}
