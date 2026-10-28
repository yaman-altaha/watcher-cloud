import nodemailer from "nodemailer";

const TARGET = "https://rendez-vous.liege.be/nationalites";

function safeHeaderText(value) {
  return String(value || "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function sendNtfy(title, message, {priority = 5} = {}) {
  const topic = String(process.env.NTFY_TOPIC || "").trim();
  if (!topic) return {ok:false, skipped:true, reason:"NTFY_TOPIC is not configured"};

  const base = String(process.env.NTFY_BASE_URL || "https://ntfy.sh").replace(/\/$/, "");
  const response = await fetch(`${base}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      "Title": safeHeaderText(title) || "Liege appointment update",
      "Priority": String(priority),
      "Tags": "calendar,rotating_light",
      "Click": TARGET,
      "Content-Type": "text/plain; charset=utf-8"
    },
    body: message
  });

  if (!response.ok) throw new Error(`ntfy HTTP ${response.status}`);
  return {ok:true};
}

export async function sendUrgentEmail(subject, text) {
  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 0);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const to = String(process.env.EMAIL_TO || "").trim();
  const from = String(process.env.EMAIL_FROM || user).trim();

  if (!host || !port || !user || !pass || !to || !from) {
    return {ok:false, skipped:true, reason:"SMTP email secrets are not fully configured"};
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {user, pass}
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    text: `${text}\n\nOpen the official booking page:\n${TARGET}`
  });

  return {ok:true};
}
