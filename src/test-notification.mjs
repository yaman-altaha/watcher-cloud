import { sendNtfy } from "./notify.mjs";

const result = await sendNtfy(
  "Liege cloud watcher test",
  "Cloud watcher is connected to ntfy. This is only a test notification.",
  { priority: 3 }
);

if (!result.ok) {
  throw new Error(result.reason || "ntfy test notification failed");
}

console.log("ntfy test notification sent successfully");
