import { sendUrgentEmail } from "./notify.mjs";

const result = await sendUrgentEmail(
  "Liège cloud watcher email test",
  "Cloud watcher email alerts are connected correctly. This is only a test email."
);

if (!result.ok) {
  throw new Error(result.reason || "Email test failed");
}

console.log("Email test sent successfully");
