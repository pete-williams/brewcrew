// functions/index.js
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

let cachedTransporter = null;

/**
 * Lazy-load nodemailer transporter to avoid deployment
 * initialization timeouts.
 * @return {object} Configured nodemailer transporter instance.
 */
function getTransporter() {
  if (!cachedTransporter) {
    const nodemailer = require("nodemailer");
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.GMAIL_EMAIL,
        pass: process.env.GMAIL_PASS,
      },
    });
  }
  return cachedTransporter;
}

/**
 * Safely parses any Firestore timestamp, Date, or date-string into epoch ms.
 * @param {*} ts Timestamp, Date, or string representation.
 * @return {number} Milliseconds since epoch, or 0 if invalid.
 */
function getTimestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? 0 : ms;
}

let cachedTwilioClient = null;

/**
 * Checks whether valid Twilio credentials and WhatsApp number are configured.
 * Supports API Key auth (TWILIO_API_SID, TWILIO_API_KEY, TWILIO_ACCOUNT_SID)
 * and legacy Auth Token auth (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN).
 * @return {boolean} True if all required Twilio environment variables are set.
 */
function isTwilioConfigured() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const apiSid = process.env.TWILIO_API_SID;
  const apiKey = process.env.TWILIO_API_KEY;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER;

  if (!from || from.includes("PLACEHOLDER") || from.includes("xxxx")) {
    return false;
  }

  // API Key authentication (recommended by Twilio)
  if (apiSid && apiKey && accountSid) {
    if (apiSid.includes("PLACEHOLDER") || apiSid.includes("xxxx")) return false;
    if (apiKey.includes("placeholder") || apiKey.includes("xxxx")) return false;
    if (accountSid.includes("PLACEHOLDER") || accountSid.includes("xxxx")) {
      return false;
    }
    return true;
  }

  // Legacy Auth Token authentication fallback
  if (accountSid && authToken) {
    if (accountSid.includes("PLACEHOLDER") || accountSid.includes("xxxx")) {
      return false;
    }
    if (authToken.includes("placeholder") || authToken.includes("xxxx")) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Lazy-load Twilio client to avoid deployment initialization timeouts.
 * Supports both API Key and Auth Token authentication.
 * @return {object|null} Configured Twilio client instance.
 */
function getTwilioClient() {
  if (!cachedTwilioClient) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiSid = process.env.TWILIO_API_SID;
    const apiKey = process.env.TWILIO_API_KEY;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    const twilio = require("twilio");

    if (apiSid && apiKey && accountSid) {
      cachedTwilioClient = twilio(apiSid, apiKey, {accountSid});
    } else if (accountSid && authToken) {
      cachedTwilioClient = twilio(accountSid, authToken);
    } else {
      return null;
    }
  }
  return cachedTwilioClient;
}

/**
 * Normalizes a phone number to standard E.164 format.
 * Defaults to UK (+44) for local 07... mobile numbers.
 * @param {string} rawPhone Raw input phone number.
 * @return {string|null} E.164 phone string (e.g. "+447123456789") or null.
 */
function normalizeE164(rawPhone) {
  if (!rawPhone || typeof rawPhone !== "string") return null;
  let cleaned = rawPhone.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("00")) {
    cleaned = "+" + cleaned.slice(2);
  }
  if (cleaned.startsWith("07") && cleaned.length === 11) {
    cleaned = "+44" + cleaned.slice(1);
  }
  if (!cleaned.startsWith("+") && cleaned.length >= 10) {
    cleaned = "+" + cleaned;
  }
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}

/**
 * Dispatches an automated WhatsApp alert message using Twilio.
 * @param {object} params Message dispatch parameters.
 * @param {string} params.to Destination phone number.
 * @param {string} params.body Message body text.
 * @return {Promise<object|null>} Twilio message response or null if skipped.
 */
async function sendWhatsAppAlert({to, body}) {
  const e164 = normalizeE164(to);
  if (!e164) {
    return {
      success: false,
      reason: "invalid_phone",
      error: `Invalid destination phone number: "${to}"`,
    };
  }
  if (!body || typeof body !== "string" || !body.trim()) {
    return {
      success: false,
      reason: "empty_body",
      error: "Message body cannot be empty.",
    };
  }
  if (!isTwilioConfigured()) {
    console.warn("Twilio WhatsApp is not configured with valid credentials.");
    const isMissingAccountSid = Boolean(
        process.env.TWILIO_API_SID &&
        process.env.TWILIO_API_KEY &&
        !process.env.TWILIO_ACCOUNT_SID,
    );
    const errText = isMissingAccountSid ?
        "Twilio API Key authentication requires TWILIO_ACCOUNT_SID " +
        "(starts with AC...) in functions/.env alongside TWILIO_API_SID " +
        "and TWILIO_API_KEY." :
        "Twilio credentials are not configured in functions/.env.";
    return {
      success: false,
      reason: "unconfigured",
      error: errText,
    };
  }
  const client = getTwilioClient();
  if (!client) {
    console.warn("Twilio client is not initialized.");
    return {
      success: false,
      reason: "client_init_failed",
      error: "Twilio client failed to initialize.",
    };
  }

  let from = (process.env.TWILIO_WHATSAPP_NUMBER || "").trim();
  if (!from.toLowerCase().startsWith("whatsapp:")) {
    from = `whatsapp:${from}`;
  }

  try {
    const res = await client.messages.create({
      from,
      to: `whatsapp:${e164}`,
      body: body.trim(),
    });
    return {
      success: true,
      sid: res.sid,
      status: res.status,
    };
  } catch (err) {
    console.error("Failed to send WhatsApp message via Twilio:", err);
    let friendlyError = err.message || "Unknown Twilio error";
    if (err.code === 21654) {
      friendlyError = "Twilio Error 21654 (ContentSid Required): Twilio " +
          "Trial accounts restrict custom free-form text via API and " +
          "require pre-approved templates (ContentSid). To send custom " +
          "festival announcements, your Twilio account must be upgraded " +
          "from Trial to a paid balance in the Twilio Console.";
    } else if (err.code === 21608) {
      friendlyError = `Twilio Error 21608: The recipient (${e164}) has ` +
          `not joined your WhatsApp sandbox. Send the join keyword to your ` +
          `Twilio number first.`;
    } else if (err.code === 20003) {
      const authDetail = err.message ||
          "Authentication failed. Verify credentials in functions/.env.";
      friendlyError = `Twilio Error 20003: ${authDetail}`;
    } else if (err.code === 21211) {
      friendlyError = `Twilio Error 21211: The recipient phone number ` +
          `(${e164}) is invalid.`;
    } else if (err.code === 21606) {
      friendlyError = `Twilio Error 21606: The configured 'From' number ` +
          `(${from}) is not an active WhatsApp sender.`;
    }
    return {
      success: false,
      code: err.code || null,
      status: err.status || null,
      error: friendlyError,
    };
  }
}

exports._isTwilioConfigured = isTwilioConfigured;
exports._normalizeE164 = normalizeE164;
exports._sendWhatsAppAlert = sendWhatsAppAlert;

/**
 * Atomic Shift Registration to Prevent Overbooking (Race Conditions)
 * Supports self-registration and administrator shift assignment.
 */
exports.claimShift = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const {shiftId, targetUserId} = request.data;
  if (!shiftId) {
    throw new HttpsError("invalid-argument", "shiftId is required.");
  }

  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (callerDoc.exists && callerDoc.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "This account has been disabled.",
    );
  }
  const isAdmin = callerDoc.exists && callerDoc.data().role === "admin";

  if (targetUserId && targetUserId !== callerUid && !isAdmin) {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can assign shifts to other volunteers.",
    );
  }

  const assignedUid = (targetUserId && isAdmin) ? targetUserId : callerUid;
  const shiftRef = db.collection("shifts").doc(shiftId);
  const regDocId = `${shiftId}_${assignedUid}`;
  const registrationRef = db.collection("registrations").doc(regDocId);

  const txResult = await db.runTransaction(async (transaction) => {
    const shiftDoc = await transaction.get(shiftRef);
    if (!shiftDoc.exists) {
      throw new HttpsError("not-found", "Shift does not exist.");
    }

    if (assignedUid !== callerUid) {
      const targetUserDoc = await transaction.get(
          db.collection("users").doc(assignedUid),
      );
      if (!targetUserDoc.exists) {
        throw new HttpsError("not-found", "Target volunteer does not exist.");
      }
      if (targetUserDoc.data().disabled) {
        throw new HttpsError(
            "failed-precondition",
            "Cannot assign shifts to a disabled user account.",
        );
      }
    }

    const shiftData = shiftDoc.data();

    if (shiftData.assignedCount >= shiftData.capacity) {
      throw new HttpsError(
          "failed-precondition",
          "This shift is already full.",
      );
    }

    const existingReg = await transaction.get(registrationRef);
    if (existingReg.exists && existingReg.data().status === "confirmed") {
      const alreadyText = (assignedUid === callerUid) ?
          "You are already registered for this shift." :
          "This volunteer is already registered for this shift.";
      throw new HttpsError("already-exists", alreadyText);
    }

    // Safeguard against overlapping or simultaneous shift registrations
    const targetStartMs = getTimestampMs(shiftData.startTime);
    const targetEndMs = getTimestampMs(shiftData.endTime);

    if (targetStartMs && targetEndMs && targetStartMs < targetEndMs) {
      const userRegsSnap = await transaction.get(
          db.collection("registrations")
              .where("userId", "==", assignedUid)
              .where("status", "==", "confirmed"),
      );

      const otherShiftIds = userRegsSnap.docs
          .map((d) => d.data().shiftId)
          .filter((id) => id && id !== shiftId);

      if (otherShiftIds.length > 0) {
        const otherShiftRefs = otherShiftIds.map((id) =>
          db.collection("shifts").doc(id),
        );
        const otherShiftDocs = await transaction.getAll(...otherShiftRefs);

        for (const otherDoc of otherShiftDocs) {
          if (!otherDoc.exists) continue;
          const otherData = otherDoc.data();
          const otherStartMs = getTimestampMs(otherData.startTime);
          const otherEndMs = getTimestampMs(otherData.endTime);

          if (
            otherStartMs &&
            otherEndMs &&
            targetStartMs < otherEndMs &&
            otherStartMs < targetEndMs
          ) {
            const conflictName = otherData.categoryName || "another shift";
            const whoText = (assignedUid === callerUid) ?
                "your registered shift" :
                "their registered shift";
            throw new HttpsError(
                "failed-precondition",
                `Cannot register: this shift overlaps with ${whoText} ` +
                `for "${conflictName}".`,
            );
          }
        }
      }
    }

    // Execute atomic updates
    transaction.update(shiftRef, {
      assignedCount: admin.firestore.FieldValue.increment(1),
    });

    const regPayload = {
      shiftId: shiftId,
      userId: assignedUid,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "confirmed",
    };
    if (assignedUid !== callerUid) {
      regPayload.assignedBy = callerUid;
    }

    transaction.set(registrationRef, regPayload);

    return {
      success: true,
      assignedUserId: assignedUid,
      categoryName: shiftData.categoryName || "Festival Shift",
      startTime: shiftData.startTime,
      endTime: shiftData.endTime,
    };
  });

  // Out-of-transaction asynchronous alert dispatch:
  // Trigger WhatsApp booking confirmation if volunteer has opted in
  try {
    const userDoc = await db.collection("users").doc(assignedUid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.whatsappNotifications !== false && userData.phoneNumber) {
        const startMs = getTimestampMs(txResult.startTime);
        const endMs = getTimestampMs(txResult.endTime);
        const dateStr = startMs ?
            new Date(startMs).toLocaleDateString("en-GB", {
              weekday: "short",
              day: "numeric",
              month: "short",
            }) : "Festival";
        const timeStr = (startMs && endMs) ?
            `${new Date(startMs).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })} - ${new Date(endMs).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}` : "";

        const volunteerName = userData.fullName || "Volunteer";
        const category = txResult.categoryName;
        const alertMsg =
            `🍺 *BrewCrew Shift Confirmed*\n\n` +
            `Hi ${volunteerName}, you're booked for *${category}* on ` +
            `*${dateStr}* (${timeStr}).\n\n` +
            `You can view your roster anytime in the BrewCrew app. ` +
            `Thank you for volunteering!`;

        await sendWhatsAppAlert({
          to: userData.phoneNumber,
          body: alertMsg,
        });
      }
    }
  } catch (alertErr) {
    console.warn("Could not dispatch WhatsApp booking confirmation:", alertErr);
  }

  return {success: true, assignedUserId: assignedUid};
});

/**
 * Atomic Shift Cancellation with 7-Day Lockout Enforced
 */
exports.cancelShift = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const {shiftId, targetUserId} = request.data;
  if (!shiftId) {
    throw new HttpsError("invalid-argument", "shiftId is required.");
  }

  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (callerDoc.exists && callerDoc.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "This account has been disabled.",
    );
  }
  const isAdmin = callerDoc.exists && callerDoc.data().role === "admin";

  const targetUid = (targetUserId && isAdmin) ? targetUserId : callerUid;
  if (targetUserId && targetUserId !== callerUid && !isAdmin) {
    throw new HttpsError(
        "permission-denied",
        "Only admins can cancel shifts for other volunteers.",
    );
  }

  const shiftRef = db.collection("shifts").doc(shiftId);
  const regDocId = `${shiftId}_${targetUid}`;
  const registrationRef = db.collection("registrations").doc(regDocId);

  const txResult = await db.runTransaction(async (transaction) => {
    const shiftDoc = await transaction.get(shiftRef);
    if (!shiftDoc.exists) {
      throw new HttpsError("not-found", "Shift does not exist.");
    }

    const regDoc = await transaction.get(registrationRef);
    if (!regDoc.exists) {
      throw new HttpsError(
          "not-found",
          "Registration for this shift does not exist.",
      );
    }

    const shiftData = shiftDoc.data();

    // 7-day lockout rule check (unless admin):
    // Volunteer can cancel at any point UNTIL 7 days before shift date.
    // E.g. if shift is on 14-May-2027,
    // user can cancel until 7-May-2027 23:59:59.
    const startTimeMs = getTimestampMs(shiftData.startTime);
    const nowMs = Date.now();

    const shiftDate = new Date(startTimeMs);
    const cutoffDate = new Date(
        shiftDate.getFullYear(),
        shiftDate.getMonth(),
        shiftDate.getDate() - 7,
        23,
        59,
        59,
        999,
    );

    if (!isAdmin && (nowMs > cutoffDate.getTime())) {
      throw new HttpsError(
          "failed-precondition",
          "Cannot cancel shifts within 7 days of shift date.",
      );
    }

    // Atomically decrement assignedCount and remove registration
    const currentCount = shiftData.assignedCount || 0;
    const newCount = Math.max(0, currentCount - 1);

    transaction.update(shiftRef, {
      assignedCount: newCount,
    });

    transaction.delete(registrationRef);

    return {
      success: true,
      categoryName: shiftData.categoryName || "Festival Shift",
      startTime: shiftData.startTime,
      endTime: shiftData.endTime,
    };
  });

  // Out-of-transaction asynchronous alert dispatch:
  // Trigger WhatsApp cancellation notice if volunteer has opted in
  try {
    const userDoc = await db.collection("users").doc(targetUid).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      if (userData.whatsappNotifications !== false && userData.phoneNumber) {
        const startMs = getTimestampMs(txResult.startTime);
        const endMs = getTimestampMs(txResult.endTime);
        const dateStr = startMs ?
            new Date(startMs).toLocaleDateString("en-GB", {
              weekday: "short",
              day: "numeric",
              month: "short",
            }) : "Festival";
        const timeStr = (startMs && endMs) ?
            `${new Date(startMs).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })} - ${new Date(endMs).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
            })}` : "";

        const volunteerName = userData.fullName || "Volunteer";
        const category = txResult.categoryName;
        const alertMsg =
            `⚠️ *BrewCrew Shift Cancelled*\n\n` +
            `Hi ${volunteerName}, your registration for *${category}* on ` +
            `*${dateStr}* (${timeStr}) has been cancelled.\n\n` +
            `If this was unintentional, you can browse open slots in ` +
            `the BrewCrew schedule.`;

        await sendWhatsAppAlert({
          to: userData.phoneNumber,
          body: alertMsg,
        });
      }
    }
  } catch (alertErr) {
    console.warn("Could not dispatch WhatsApp cancellation notice:", alertErr);
  }

  return {success: true};
});

/**
 * Converts a plain-text body into clean HTML paragraphs,
 * preserving embedded HTML blocks like <ul>.
 * @param {string} text Body text.
 * @return {string} Formatted HTML.
 */
function formatEmailBody(text) {
  if (!text) return "";
  const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

  return paragraphs.map((block) => {
    if (
      block.startsWith("<ul") ||
      block.startsWith("<ol") ||
      block.startsWith("<div") ||
      block.startsWith("<p")
    ) {
      return block;
    }
    const inner = block.replace(/\n/g, "<br/>");
    return `<p style="margin: 0 0 14px 0; line-height: 1.6;">${inner}</p>`;
  }).join("\n");
}

/**
 * Builds the branded email container for festival announcements.
 * @param {string} title Header title.
 * @param {string} formattedBody Body HTML.
 * @return {string} Complete HTML email document.
 */
function buildBrandedEmailHtml(title, formattedBody) {
  const outerStyle =
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', " +
      "Roboto, Helvetica, Arial, sans-serif; max-width: 600px; " +
      "margin: 0 auto; padding: 20px 16px; background-color: #f5f5f4; " +
      "color: #1e293b;";
  const cardStyle =
      "background-color: #ffffff; border: 1px solid #fde68a; " +
      "border-radius: 12px; padding: 24px; " +
      "box-shadow: 0 1px 3px rgba(0,0,0,0.05);";
  const headerStyle =
      "border-bottom: 2px solid #b45309; padding-bottom: 12px; " +
      "margin-bottom: 20px;";
  const footerStyle =
      "margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; " +
      "font-size: 11px; color: #64748b;";

  return `
    <div style="${outerStyle}">
      <div style="${cardStyle}">
        <div style="${headerStyle}">
          <h2 style="margin: 0; color: #78350f; font-size: 20px; ` +
            `font-weight: 700;">🍺 ${title}</h2>
        </div>
        <div style="font-size: 14px; line-height: 1.6; color: #334155;">
          ${formattedBody}
        </div>
        <div style="${footerStyle}">
          <p style="margin: 0;">Sent via BrewCrew Volunteer Platform. ` +
            `Received based on festival preferences.` +
          `</p>
        </div>
      </div>
    </div>
  `;
}

/**
 * Formats a chronological list of shifts into HTML or WhatsApp Markdown.
 * Note: Manager name is omitted per specification.
 * @param {Array<object>} shifts List of shift objects.
 * @param {"email"|"whatsapp"} channel Delivery channel.
 * @return {string} Formatted shift schedule string.
 */
function formatVolunteerShiftList(shifts, channel) {
  if (!shifts || shifts.length === 0) {
    if (channel === "email") {
      return `<p style="margin: 8px 0; font-style: italic; color: #64748b;">` +
          `No shifts currently scheduled</p>`;
    }
    return `_No shifts currently scheduled_`;
  }

  const items = shifts.map((s) => {
    const startMs = getTimestampMs(s.startTime);
    const endMs = getTimestampMs(s.endTime);
    const dateStr = startMs ?
        new Date(startMs).toLocaleDateString("en-GB", {
          weekday: "short",
          day: "numeric",
          month: "short",
        }) : "Date TBD";
    const timeStr = (startMs && endMs) ?
        `${new Date(startMs).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        })} - ${new Date(endMs).toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
        })}` : "Time TBD";
    const area = s.categoryName || s.role || "General Shift";

    if (channel === "email") {
      return `<li style="margin-bottom: 4px;">` +
          `<strong>${dateStr} (${timeStr})</strong>: ${area}</li>`;
    }
    return `• *${dateStr} (${timeStr})*: ${area}`;
  });

  if (channel === "email") {
    return `<ul style="margin: 8px 0; padding-left: 20px; line-height: 1.6;">` +
        `${items.join("")}</ul>`;
  }
  return items.join("\n");
}

/**
 * Substitutes dynamic tokens in template text for a specific recipient.
 * @param {string} text Template text containing {{...}} tokens.
 * @param {object} user Recipient user data.
 * @param {Array<object>} shifts Confirmed shifts for recipient.
 * @param {object|null} contextShift Targeted shift context if applicable.
 * @param {"email"|"whatsapp"} channel Delivery channel.
 * @param {string} [targetCategory] Targeted category if applicable.
 * @return {string} Personalized text.
 */
function substitutePlaceholders(
    text,
    user,
    shifts,
    contextShift,
    channel,
    targetCategory,
) {
  if (!text || typeof text !== "string") return "";

  const fullName = user.fullName || "Volunteer";
  const trimmed = user.fullName ? user.fullName.trim() : "";
  const firstName = (trimmed ? trimmed.split(/\s+/)[0] : "") || "there";

  const nextShift = contextShift ||
      (shifts && shifts.length > 0 ? shifts[0] : null);

  let categoryStr = "Festival Shift";
  let dateStr = "Scheduled Date";
  let timeStr = "Scheduled Time";

  if (nextShift) {
    categoryStr = nextShift.categoryName || nextShift.role || "Festival Shift";
    const startMs = getTimestampMs(nextShift.startTime);
    const endMs = getTimestampMs(nextShift.endTime);
    if (startMs) {
      dateStr = new Date(startMs).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
    }
    if (startMs && endMs) {
      timeStr = `${new Date(startMs).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })} - ${new Date(endMs).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
    }
  } else if (targetCategory) {
    categoryStr = targetCategory;
  }

  const allShiftsFormatted = formatVolunteerShiftList(shifts, channel);

  return text
      .replace(/\{\{\s*name\s*\}\}/gi, fullName)
      .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
      .replace(/\{\{\s*all_shifts\s*\}\}/gi, allShiftsFormatted)
      .replace(/\{\{\s*category\s*\}\}/gi, categoryStr)
      .replace(/\{\{\s*date\s*\}\}/gi, dateStr)
      .replace(/\{\{\s*time\s*\}\}/gi, timeStr);
}

/**
 * Resolves targeted recipient users and their confirmed shifts.
 * Supports: all, role, category, shift, users.
 * @param {object} params Target parameters.
 * @param {string} [params.targetType] Target mode.
 * @param {string} [params.targetRole] Target role.
 * @param {string} [params.targetCategory] Target category.
 * @param {string} [params.targetShiftId] Target shift ID.
 * @param {Array<string>} [params.targetUserIds] User IDs.
 * @param {boolean} [params.onlyWithConfirmedShifts] Filter confirmed.
 * @return {Promise<object>} Resolved recipients and context shift.
 */
async function resolveBroadcastRecipients({
  targetType = "all",
  targetRole,
  targetCategory,
  targetShiftId,
  targetUserIds,
  onlyWithConfirmedShifts = false,
}) {
  const usersSnapshot = await db.collection("users").get();
  const allActiveUsers = usersSnapshot.docs
      .filter((doc) => !doc.data().disabled)
      .map((doc) => ({id: doc.id, ...doc.data()}));

  const shiftsSnapshot = await db.collection("shifts").get();
  const shiftsMap = new Map();
  shiftsSnapshot.docs.forEach((doc) => {
    shiftsMap.set(doc.id, {id: doc.id, ...doc.data()});
  });

  const regSnapshot = await db.collection("registrations")
      .where("status", "==", "confirmed")
      .get();

  const userShiftsMap = new Map();
  const addShiftToUser = (uid, shift) => {
    if (!uid || !shift) return;
    if (!userShiftsMap.has(uid)) {
      userShiftsMap.set(uid, []);
    }
    const list = userShiftsMap.get(uid);
    if (!list.some((s) => s.id === shift.id)) {
      list.push(shift);
    }
  };

  regSnapshot.docs.forEach((regDoc) => {
    const regData = regDoc.data();
    const shift = shiftsMap.get(regData.shiftId);
    if (shift && regData.userId) {
      addShiftToUser(regData.userId, shift);
    }
  });

  shiftsMap.forEach((shift) => {
    if (shift.managerId) {
      addShiftToUser(shift.managerId, shift);
    }
  });

  userShiftsMap.forEach((shiftList) => {
    shiftList.sort((a, b) =>
      getTimestampMs(a.startTime) - getTimestampMs(b.startTime),
    );
  });

  let contextShift = null;
  if (targetType === "shift" && targetShiftId) {
    contextShift = shiftsMap.get(targetShiftId) || null;
  }

  let filteredUsers = [];
  if (targetType === "role") {
    filteredUsers = allActiveUsers.filter((u) => {
      if (!targetRole || targetRole === "all") return true;
      return u.role === targetRole;
    });
  } else if (targetType === "category") {
    filteredUsers = allActiveUsers.filter((u) => {
      const userShifts = userShiftsMap.get(u.id) || [];
      return userShifts.some((s) =>
        s.categoryName && s.categoryName.trim() === targetCategory.trim(),
      );
    });
  } else if (targetType === "shift") {
    filteredUsers = allActiveUsers.filter((u) => {
      const userShifts = userShiftsMap.get(u.id) || [];
      return userShifts.some((s) => s.id === targetShiftId);
    });
  } else if (targetType === "users") {
    const idSet = new Set(Array.isArray(targetUserIds) ? targetUserIds : []);
    filteredUsers = allActiveUsers.filter((u) => idSet.has(u.id));
  } else {
    // "all"
    filteredUsers = allActiveUsers;
  }

  if (onlyWithConfirmedShifts) {
    filteredUsers = filteredUsers.filter((u) => {
      const shifts = userShiftsMap.get(u.id) || [];
      return shifts.length > 0;
    });
  }

  const recipients = filteredUsers.map((u) => ({
    ...u,
    shifts: userShiftsMap.get(u.id) || [],
  }));

  return {recipients, contextShift};
}

/**
 * Admin Mass Communication Dispatch Endpoint via Nodemailer
 */
exports.sendAdminBroadcast = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  // Enforce Admin Access
  const callerRef = await db.collection("users").doc(request.auth.uid).get();
  if (!callerRef.exists || callerRef.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Requires Administrator permissions.",
    );
  }
  if (callerRef.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "Administrator account is disabled.",
    );
  }

  const {
    subject,
    body,
    targetRole,
    targetType,
    targetCategory,
    targetShiftId,
    targetUserIds,
    onlyWithConfirmedShifts,
  } = request.data;

  if (!subject || typeof subject !== "string" || !subject.trim()) {
    throw new HttpsError("invalid-argument", "Subject is required.");
  }
  if (!body || typeof body !== "string" || !body.trim()) {
    throw new HttpsError("invalid-argument", "Message body is required.");
  }

  const resolvedTargetType = targetType ||
      (targetRole && targetRole !== "all" ? "role" : "all");

  let broadcastFromName = "BrewCrew Updates";
  try {
    const configDoc = await db.collection("config").doc("festival").get();
    if (configDoc.exists && configDoc.data().festivalName) {
      broadcastFromName = configDoc.data().festivalName;
    }
  } catch (e) {
    console.warn("Could not fetch festival name for broadcast:", e);
  }

  const {recipients, contextShift} = await resolveBroadcastRecipients({
    targetType: resolvedTargetType,
    targetRole,
    targetCategory,
    targetShiftId,
    targetUserIds,
    onlyWithConfirmedShifts: Boolean(onlyWithConfirmedShifts),
  });

  const transporter = getTransporter();
  const gmailEmail = process.env.GMAIL_EMAIL;

  let sentCount = 0;
  let skippedCount = 0;

  for (const recipient of recipients) {
    if (
      recipient.emailNotifications === false ||
      !recipient.email ||
      !recipient.email.includes("@")
    ) {
      skippedCount++;
      continue;
    }

    const personalizedSubject = substitutePlaceholders(
        subject.trim(),
        recipient,
        recipient.shifts,
        contextShift,
        "email",
        targetCategory,
    );

    const personalizedBody = substitutePlaceholders(
        body.trim(),
        recipient,
        recipient.shifts,
        contextShift,
        "email",
        targetCategory,
    );

    const formattedBody = formatEmailBody(personalizedBody);
    const emailHtml = buildBrandedEmailHtml(broadcastFromName, formattedBody);

    try {
      await transporter.sendMail({
        from: `"${broadcastFromName}" <${gmailEmail}>`,
        to: recipient.email,
        subject: personalizedSubject,
        html: emailHtml,
      });
      sentCount++;
    } catch (sendErr) {
      console.warn(
          `Failed sending email broadcast to ${recipient.id}:`,
          sendErr.message,
      );
      skippedCount++;
    }
  }

  return {
    success: true,
    count: sentCount,
    skippedCount,
  };
});

/**
 * Admin Mass Communication Dispatch Endpoint via Twilio WhatsApp
 */
exports.sendWhatsAppBroadcast = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerRef = await db.collection("users").doc(request.auth.uid).get();
  if (!callerRef.exists || callerRef.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Requires Administrator permissions.",
    );
  }
  if (callerRef.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "Administrator account is disabled.",
    );
  }

  const {
    body,
    targetType = "all",
    targetRole,
    targetCategory,
    targetShiftId,
    targetUserIds,
    onlyWithConfirmedShifts,
  } = request.data;

  if (!body || typeof body !== "string" || !body.trim()) {
    throw new HttpsError("invalid-argument", "Message body is required.");
  }

  let broadcastFromName = "BrewCrew Updates";
  try {
    const configDoc = await db.collection("config").doc("festival").get();
    if (configDoc.exists && configDoc.data().festivalName) {
      broadcastFromName = configDoc.data().festivalName;
    }
  } catch (e) {
    console.warn("Could not fetch festival name for broadcast:", e);
  }

  const {recipients, contextShift} = await resolveBroadcastRecipients({
    targetType,
    targetRole,
    targetCategory,
    targetShiftId,
    targetUserIds,
    onlyWithConfirmedShifts: Boolean(onlyWithConfirmedShifts),
  });

  const twilioConfigured = isTwilioConfigured();
  let sentCount = 0;
  let skippedCount = 0;
  const dispatchErrors = [];

  for (const recipient of recipients) {
    const vName = recipient.fullName || "Volunteer";
    if (recipient.whatsappNotifications === false) {
      skippedCount++;
      dispatchErrors.push(`${vName} has opted out of WhatsApp.`);
      continue;
    }
    if (!recipient.phoneNumber) {
      skippedCount++;
      dispatchErrors.push(`${vName} has no phone number on profile.`);
      continue;
    }

    const e164 = normalizeE164(recipient.phoneNumber);
    if (!e164) {
      skippedCount++;
      dispatchErrors.push(
          `${vName}: invalid phone "${recipient.phoneNumber}".`,
      );
      continue;
    }

    if (!twilioConfigured) {
      skippedCount++;
      continue;
    }

    const personalized = substitutePlaceholders(
        body.trim(),
        recipient,
        recipient.shifts,
        contextShift,
        "whatsapp",
        targetCategory,
    );

    const messageText = `🍺 *${broadcastFromName}*\n\n${personalized}`;

    try {
      const dispatchResult = await sendWhatsAppAlert({
        to: e164,
        body: messageText,
      });
      if (dispatchResult && dispatchResult.success && dispatchResult.sid) {
        sentCount++;
      } else {
        skippedCount++;
        if (dispatchResult && dispatchResult.error) {
          dispatchErrors.push(dispatchResult.error);
        }
      }
    } catch (sendErr) {
      console.warn(
          `Failed sending WhatsApp broadcast to ${recipient.id}:`,
          sendErr.message,
      );
      skippedCount++;
      dispatchErrors.push(sendErr.message);
    }
  }

  let warning = null;
  if (!twilioConfigured) {
    const isMissingAccountSid = Boolean(
        process.env.TWILIO_API_SID &&
        process.env.TWILIO_API_KEY &&
        !process.env.TWILIO_ACCOUNT_SID,
    );
    warning = isMissingAccountSid ?
        "Twilio API Key authentication requires TWILIO_ACCOUNT_SID " +
        "(starts with AC...) in functions/.env alongside TWILIO_API_SID " +
        "and TWILIO_API_KEY." :
        "Twilio WhatsApp credentials are not configured in functions/.env. " +
        "All WhatsApp messages were skipped.";
  } else if (sentCount === 0 && skippedCount > 0) {
    if (dispatchErrors.length > 0) {
      const unique = Array.from(new Set(dispatchErrors));
      warning = unique.slice(0, 2).join(" | ");
    } else {
      warning = "All WhatsApp messages were skipped or failed delivery. " +
          "Check volunteer phone numbers and Twilio logs.";
    }
  } else if (dispatchErrors.length > 0) {
    const unique = Array.from(new Set(dispatchErrors));
    warning = `Delivered ${sentCount} message(s). Issues with ` +
        `${skippedCount}: ` + unique.slice(0, 2).join(" | ");
  }

  return {
    success: true,
    count: sentCount,
    skippedCount,
    warning,
    errors: Array.from(new Set(dispatchErrors)),
  };
});

/**
 * Retrieve unique category names from active shift documents.
 */
exports.getShiftCategories = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  try {
    const snapshot = await db.collection("shifts").get();
    const categoriesSet = new Set();
    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (data && typeof data.categoryName === "string") {
        const trimmed = data.categoryName.trim();
        if (trimmed) {
          categoriesSet.add(trimmed);
        }
      }
    });

    const categories = Array.from(categoriesSet).sort((a, b) => {
      return a.localeCompare(b);
    });

    return {categories};
  } catch (err) {
    console.error("Error fetching shift categories:", err);
    throw new HttpsError("internal", err.message);
  }
});

/**
 * Admin: Create a new shift in the schedule
 */
exports.createShift = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can create shifts.",
    );
  }

  const {
    sessionId,
    categoryName,
    capacity,
    startTime,
    endTime,
    managerUserId,
  } = request.data;

  if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
    throw new HttpsError("invalid-argument", "sessionId is required.");
  }

  // Validate that sessionId exists in /config/festival
  const festivalConfigDoc = await db.collection("config").doc("festival").get();
  const festivalSessions = festivalConfigDoc.exists ?
    (festivalConfigDoc.data().sessions || []) : [];
  const sessionExists = festivalSessions.some((s) => s.id === sessionId.trim());
  if (!sessionExists) {
    throw new HttpsError(
        "invalid-argument",
        "The specified session does not exist in festival configuration.",
    );
  }

  if (!categoryName || typeof categoryName !== "string" ||
      !categoryName.trim()) {
    throw new HttpsError("invalid-argument", "categoryName is required.");
  }

  const parsedCapacity = parseInt(capacity, 10);
  if (isNaN(parsedCapacity) || parsedCapacity < 1) {
    throw new HttpsError(
        "invalid-argument",
        "capacity must be a positive integer.",
    );
  }

  if (!startTime || !endTime) {
    throw new HttpsError(
        "invalid-argument",
        "startTime and endTime are required.",
    );
  }

  const startTimestamp = admin.firestore.Timestamp.fromDate(
      new Date(startTime),
  );
  const endTimestamp = admin.firestore.Timestamp.fromDate(
      new Date(endTime),
  );

  if (endTimestamp.toMillis() <= startTimestamp.toMillis()) {
    throw new HttpsError(
        "invalid-argument",
        "Shift end time must be after start time.",
    );
  }

  let managerData = {
    managerId: null,
    managerName: null,
    managerEmail: null,
  };

  if (managerUserId) {
    const mgrDoc = await db.collection("users").doc(managerUserId).get();
    if (!mgrDoc.exists) {
      throw new HttpsError("not-found", "Assigned manager user not found.");
    }
    const mgrRole = mgrDoc.data().role;
    if (mgrRole !== "manager" && mgrRole !== "admin") {
      throw new HttpsError(
          "failed-precondition",
          "Assigned user must have manager or admin role.",
      );
    }
    managerData = {
      managerId: managerUserId,
      managerName: mgrDoc.data().fullName || mgrDoc.data().email,
      managerEmail: mgrDoc.data().email || null,
    };
  }

  const newShift = {
    sessionId: sessionId.trim(),
    categoryName: categoryName.trim(),
    capacity: parsedCapacity,
    assignedCount: 0,
    startTime: startTimestamp,
    endTime: endTimestamp,
    managerId: managerData.managerId,
    managerName: managerData.managerName,
    managerEmail: managerData.managerEmail,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: request.auth.uid,
  };

  const docRef = await db.collection("shifts").add(newShift);
  return {success: true, shiftId: docRef.id};
});

/**
 * Admin: Update an existing shift (times, duration, category, capacity)
 */
exports.updateShift = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can update shifts.",
    );
  }

  const {
    shiftId,
    categoryName,
    capacity,
    startTime,
    endTime,
    sessionId,
  } = request.data;

  if (!shiftId || typeof shiftId !== "string") {
    throw new HttpsError("invalid-argument", "shiftId is required.");
  }

  const shiftRef = db.collection("shifts").doc(shiftId);
  const shiftDoc = await shiftRef.get();
  if (!shiftDoc.exists) {
    throw new HttpsError("not-found", "Shift does not exist.");
  }

  const shiftData = shiftDoc.data();
  const updateData = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  };

  if (categoryName !== undefined) {
    if (typeof categoryName !== "string" || !categoryName.trim()) {
      throw new HttpsError(
          "invalid-argument",
          "categoryName cannot be empty.",
      );
    }
    updateData.categoryName = categoryName.trim();
  }

  if (sessionId !== undefined) {
    if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
      throw new HttpsError("invalid-argument", "sessionId cannot be empty.");
    }
    const configDoc = await db.collection("config").doc("festival").get();
    const festivalSessions = configDoc.exists ?
      (configDoc.data().sessions || []) : [];
    const sessionExists = festivalSessions.some(
        (s) => s.id === sessionId.trim(),
    );
    if (!sessionExists) {
      throw new HttpsError(
          "invalid-argument",
          "The specified session does not exist in festival configuration.",
      );
    }
    updateData.sessionId = sessionId.trim();
  }

  let newStart = shiftData.startTime;
  let newEnd = shiftData.endTime;

  if (startTime) {
    newStart = admin.firestore.Timestamp.fromDate(new Date(startTime));
    updateData.startTime = newStart;
  }
  if (endTime) {
    newEnd = admin.firestore.Timestamp.fromDate(new Date(endTime));
    updateData.endTime = newEnd;
  }

  if (newEnd.toMillis() <= newStart.toMillis()) {
    throw new HttpsError(
        "invalid-argument",
        "Shift end time must be after start time.",
    );
  }

  if (capacity !== undefined) {
    const parsedCapacity = parseInt(capacity, 10);
    if (isNaN(parsedCapacity) || parsedCapacity < 1) {
      throw new HttpsError(
          "invalid-argument",
          "capacity must be a positive integer.",
      );
    }
    if (parsedCapacity < (shiftData.assignedCount || 0)) {
      throw new HttpsError(
          "failed-precondition",
          "Capacity cannot be less than currently assigned volunteers.",
      );
    }
    updateData.capacity = parsedCapacity;
  }

  await shiftRef.update(updateData);
  return {success: true, shiftId: shiftId};
});

/**
 * Admin: Delete a festival session from configuration
 * Strictly prevents deletion if any shifts are currently assigned to it.
 */
exports.deleteFestivalSession = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can delete festival sessions.",
    );
  }

  const {sessionId} = request.data;
  if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
    throw new HttpsError("invalid-argument", "sessionId is required.");
  }

  const trimmedSessionId = sessionId.trim();

  // Check if any shifts are assigned to this session
  const shiftsSnapshot = await db.collection("shifts")
      .where("sessionId", "==", trimmedSessionId)
      .get();

  if (!shiftsSnapshot.empty) {
    const count = shiftsSnapshot.size;
    throw new HttpsError(
        "failed-precondition",
        `Cannot delete session because ${count} shift` +
        `${count === 1 ? "" : "s"} are currently assigned to it. ` +
        `Please reassign or delete the associated shifts first.`,
    );
  }

  const configRef = db.collection("config").doc("festival");
  const configDoc = await configRef.get();
  if (!configDoc.exists) {
    throw new HttpsError("not-found", "Festival configuration not found.");
  }

  const configData = configDoc.data();
  const sessions = configData.sessions || [];
  const sessionIndex = sessions.findIndex((s) => s.id === trimmedSessionId);

  if (sessionIndex === -1) {
    throw new HttpsError("not-found", "Session not found in configuration.");
  }

  if (sessions.length <= 1) {
    throw new HttpsError(
        "failed-precondition",
        "The festival must have at least one session configured.",
    );
  }

  sessions.splice(sessionIndex, 1);

  await configRef.update({
    sessions: sessions,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  });

  return {success: true, sessionId: trimmedSessionId};
});

/**
 * Shift Manager Assignment
 * - Managers can assign themselves if no manager is currently assigned
 *   (only 1 manager per shift)
 * - Managers can unassign themselves if they are the currently assigned manager
 * - Admins can assign any manager/admin user, reassign, or unassign
 */
exports.assignShiftManager = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const {shiftId, managerUserId} = request.data;
  if (!shiftId) {
    throw new HttpsError("invalid-argument", "shiftId is required.");
  }

  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (!callerDoc.exists) {
    throw new HttpsError("not-found", "Caller profile not found.");
  }

  const callerData = callerDoc.data();
  const isAdmin = callerData.role === "admin";
  const isManager = callerData.role === "manager" || isAdmin;

  if (!isManager) {
    throw new HttpsError(
        "permission-denied",
        "Only managers and administrators can assign shift managers.",
    );
  }

  // Managers (non-admins) can only assign themselves or unassign themselves
  if (!isAdmin && managerUserId && managerUserId !== callerUid) {
    throw new HttpsError(
        "permission-denied",
        "Managers can only assign themselves.",
    );
  }

  const shiftRef = db.collection("shifts").doc(shiftId);

  return db.runTransaction(async (transaction) => {
    const shiftDoc = await transaction.get(shiftRef);
    if (!shiftDoc.exists) {
      throw new HttpsError("not-found", "Shift does not exist.");
    }

    const shiftData = shiftDoc.data();

    // If unassigning (managerUserId is falsy)
    if (!managerUserId) {
      // Non-admins can only unassign themselves
      if (!isAdmin && shiftData.managerId !== callerUid) {
        throw new HttpsError(
            "permission-denied",
            "You can only unassign yourself as manager.",
        );
      }

      transaction.update(shiftRef, {
        managerId: null,
        managerName: null,
        managerEmail: null,
      });

      return {success: true, assigned: false};
    }

    // If assigning:
    // Only one manager can be assigned per shift:
    // If shift already has a manager and it's not the same manager
    if (shiftData.managerId && shiftData.managerId !== managerUserId) {
      if (!isAdmin) {
        const currentMgr = shiftData.managerName || "Another manager";
        throw new HttpsError(
            "already-exists",
            `This shift already has a manager (${currentMgr}). ` +
            "Only one manager can be assigned per shift.",
        );
      }
    }

    // Verify target manager exists and has role 'manager' or 'admin'
    let targetUserDoc;
    if (managerUserId === callerUid) {
      targetUserDoc = callerDoc;
    } else {
      targetUserDoc = await transaction.get(
          db.collection("users").doc(managerUserId),
      );
      if (!targetUserDoc.exists) {
        throw new HttpsError(
            "not-found",
            "Selected manager user does not exist.",
        );
      }
    }

    const targetData = targetUserDoc.data();
    if (targetData.role !== "manager" && targetData.role !== "admin") {
      throw new HttpsError(
          "failed-precondition",
          "Assigned user must have manager or admin role.",
      );
    }

    const managerName = targetData.fullName || targetData.email || "Manager";
    const managerEmail = targetData.email || null;

    transaction.update(shiftRef, {
      managerId: managerUserId,
      managerName: managerName,
      managerEmail: managerEmail,
    });

    return {
      success: true,
      assigned: true,
      managerId: managerUserId,
      managerName: managerName,
    };
  });
});

/**
 * Admin: Change User Role (volunteer <-> manager <-> admin)
 */
exports.updateUserRole = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can change user roles.",
    );
  }
  if (callerDoc.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "Administrator account is disabled.",
    );
  }

  const {targetUserId, newRole} = request.data;
  if (!targetUserId || typeof targetUserId !== "string") {
    throw new HttpsError("invalid-argument", "targetUserId is required.");
  }

  const validRoles = ["volunteer", "manager", "admin"];
  if (!validRoles.includes(newRole)) {
    throw new HttpsError(
        "invalid-argument",
        `Role must be one of: ${validRoles.join(", ")}`,
    );
  }

  const targetDocRef = db.collection("users").doc(targetUserId);
  const targetDoc = await targetDocRef.get();
  if (!targetDoc.exists) {
    throw new HttpsError("not-found", "Target user does not exist.");
  }

  // Prevent admin from removing their own admin role to avoid lockout
  if (targetUserId === request.auth.uid && newRole !== "admin") {
    throw new HttpsError(
        "failed-precondition",
        "You cannot revoke your own administrator privileges.",
    );
  }

  await targetDocRef.update({
    role: newRole,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  });

  return {success: true, userId: targetUserId, role: newRole};
});

/**
 * Admin: Disable or Re-enable User Account
 */
exports.setUserDisabledStatus = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can change account status.",
    );
  }
  if (callerDoc.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "Administrator account is disabled.",
    );
  }

  const {targetUserId, disabled, reason} = request.data;
  if (!targetUserId || typeof targetUserId !== "string") {
    throw new HttpsError("invalid-argument", "targetUserId is required.");
  }
  if (typeof disabled !== "boolean") {
    throw new HttpsError("invalid-argument", "disabled must be a boolean.");
  }

  // Prevent self-lockout
  if (targetUserId === callerUid) {
    throw new HttpsError(
        "failed-precondition",
        "You cannot disable your own administrator account.",
    );
  }

  const targetDocRef = db.collection("users").doc(targetUserId);
  const targetDoc = await targetDocRef.get();
  if (!targetDoc.exists) {
    throw new HttpsError("not-found", "Target user does not exist.");
  }

  const updateData = {
    disabled: disabled,
    status: disabled ? "disabled" : "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: callerUid,
  };

  if (disabled) {
    updateData.disabledAt = admin.firestore.FieldValue.serverTimestamp();
    updateData.disabledBy = callerUid;
    if (reason && typeof reason === "string") {
      updateData.disabledReason = reason.trim();
    }
  } else {
    updateData.disabledAt = null;
    updateData.disabledBy = null;
    updateData.disabledReason = null;
  }

  await targetDocRef.update(updateData);

  try {
    await admin.auth().updateUser(targetUserId, {disabled: disabled});
    if (disabled) {
      await admin.auth().revokeRefreshTokens(targetUserId);
    }
  } catch (authErr) {
    console.warn(
        "Auth update warning for user:",
        targetUserId,
        authErr.message,
    );
  }

  return {
    success: true,
    userId: targetUserId,
    disabled: disabled,
  };
});

/**
 * Admin: Delete and Block User, Releasing Allocated Shifts
 */
exports.deleteAndBlockUser = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can delete and block accounts.",
    );
  }
  if (callerDoc.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "Administrator account is disabled.",
    );
  }

  const {targetUserId, reason} = request.data;
  if (!targetUserId || typeof targetUserId !== "string") {
    throw new HttpsError("invalid-argument", "targetUserId is required.");
  }

  // Prevent self-deletion
  if (targetUserId === callerUid) {
    throw new HttpsError(
        "failed-precondition",
        "You cannot delete your own administrator account.",
    );
  }

  const targetDocRef = db.collection("users").doc(targetUserId);
  const targetDoc = await targetDocRef.get();
  if (!targetDoc.exists) {
    throw new HttpsError("not-found", "Target user does not exist.");
  }

  const targetData = targetDoc.data();
  const rawEmail = targetData.email || "";
  const normalizedEmail = rawEmail.trim().toLowerCase();

  if (!normalizedEmail) {
    throw new HttpsError(
        "failed-precondition",
        "Target user does not have a registered email address to block.",
    );
  }

  // Query all active registrations for target user
  const regSnapshot = await db.collection("registrations")
      .where("userId", "==", targetUserId)
      .where("status", "==", "confirmed")
      .get();

  // Query all shifts where user is assigned manager
  const managerShiftsSnapshot = await db.collection("shifts")
      .where("managerId", "==", targetUserId)
      .get();

  const releasedCount = regSnapshot.size;

  // Execute atomic batch cleanup
  const batch = db.batch();

  // 1. Decrement shift assignedCount and delete registration documents
  regSnapshot.docs.forEach((regDoc) => {
    const regData = regDoc.data();
    if (regData.shiftId) {
      const shiftRef = db.collection("shifts").doc(regData.shiftId);
      batch.update(shiftRef, {
        assignedCount: admin.firestore.FieldValue.increment(-1),
      });
    }
    batch.delete(regDoc.ref);
  });

  // 2. Clear manager assignments
  managerShiftsSnapshot.docs.forEach((shiftDoc) => {
    batch.update(shiftDoc.ref, {
      managerId: null,
      managerName: null,
      managerEmail: null,
    });
  });

  // 3. Add to /blockedEmails
  const blockedEmailRef = db.collection("blockedEmails").doc(normalizedEmail);
  batch.set(blockedEmailRef, {
    email: normalizedEmail,
    originalUserId: targetUserId,
    fullName: targetData.fullName || "Volunteer",
    reason: (reason && typeof reason === "string") ?
      reason.trim() :
      "Account deleted and blocked by administrator",
    blockedAt: admin.firestore.FieldValue.serverTimestamp(),
    blockedBy: callerUid,
    blockedByEmail: callerDoc.data().email || null,
  });

  // 4. Delete Firestore user document
  batch.delete(targetDocRef);

  await batch.commit();

  // 5. Delete from Firebase Authentication
  try {
    await admin.auth().deleteUser(targetUserId);
  } catch (authErr) {
    console.warn("Firebase Auth deletion warning:", authErr.message);
  }

  return {
    success: true,
    deletedUserId: targetUserId,
    blockedEmail: normalizedEmail,
    releasedShiftsCount: releasedCount,
  };
});

/**
 * Admin: Unblock Email Address
 */
exports.unblockUserEmail = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const callerUid = request.auth.uid;
  const callerDoc = await db.collection("users").doc(callerUid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can unblock email addresses.",
    );
  }
  if (callerDoc.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "Administrator account is disabled.",
    );
  }

  const {email} = request.data;
  if (!email || typeof email !== "string") {
    throw new HttpsError("invalid-argument", "email is required.");
  }

  const normalizedEmail = email.trim().toLowerCase();
  const blockedDocRef = db.collection("blockedEmails").doc(normalizedEmail);
  const blockedDoc = await blockedDocRef.get();

  if (!blockedDoc.exists) {
    throw new HttpsError("not-found", "Email is not in the blocked list.");
  }

  await blockedDocRef.delete();

  return {
    success: true,
    unblockedEmail: normalizedEmail,
  };
});

/**
 * Inbound Webhook for Twilio WhatsApp Messages.
 * Forwards volunteer replies to Volunteer Manager and sends auto-ack.
 */
exports.twilioWhatsAppWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  const fromRaw = req.body.From || "";
  const volunteerPhone = fromRaw.replace(/^whatsapp:/i, "").trim();
  const volunteerE164 = normalizeE164(volunteerPhone);
  const inboundBody = (req.body.Body || "").trim();
  const messageSid = req.body.MessageSid || null;

  if (!volunteerE164 || !inboundBody) {
    res.status(200).send("<Response></Response>");
    return;
  }

  try {
    // 1. Look up volunteer by phone
    const usersSnapshot = await db.collection("users").get();
    let volunteer = null;
    for (const doc of usersSnapshot.docs) {
      const data = doc.data();
      if (
        data.phoneNumber &&
        normalizeE164(data.phoneNumber) === volunteerE164
      ) {
        volunteer = {id: doc.id, ...data};
        break;
      }
    }

    const volunteerName = volunteer ?
        (volunteer.fullName || "Volunteer") : "Volunteer";

    // 2. Look up upcoming shift for this volunteer
    let upcomingShiftInfo = "No upcoming shifts scheduled";
    if (volunteer) {
      const regSnap = await db.collection("registrations")
          .where("userId", "==", volunteer.id)
          .where("status", "==", "confirmed")
          .get();

      if (!regSnap.empty) {
        const shiftIds = regSnap.docs.map((d) => d.data().shiftId);
        const shiftDocs = await Promise.all(
            shiftIds.map((id) => db.collection("shifts").doc(id).get()),
        );

        const activeShifts = shiftDocs
            .filter((d) => d.exists)
            .map((d) => ({id: d.id, ...d.data()}))
            .sort((a, b) =>
              getTimestampMs(a.startTime) - getTimestampMs(b.startTime),
            );

        if (activeShifts.length > 0) {
          const s = activeShifts[0];
          const startMs = getTimestampMs(s.startTime);
          const endMs = getTimestampMs(s.endTime);
          const dateStr = startMs ?
              new Date(startMs).toLocaleDateString("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
              }) : "Date TBD";
          const timeStr = (startMs && endMs) ?
              `${new Date(startMs).toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
              })} - ${new Date(endMs).toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
              })}` : "";
          const area = s.categoryName || s.role || "Shift";
          upcomingShiftInfo = `${area} on ${dateStr} (${timeStr})`;
        }
      }
    }

    // 3. Look up Volunteer Manager from festival config
    let managerE164 = null;
    const configDoc = await db.collection("config").doc("festival").get();
    if (configDoc.exists) {
      const festData = configDoc.data();
      const managerPhone = festData.volunteerManager?.phone || "";
      managerE164 = normalizeE164(managerPhone);
    }

    // 4. Log message to /inboundMessages
    await db.collection("inboundMessages").add({
      from: volunteerE164,
      fromName: volunteerName,
      userId: volunteer ? volunteer.id : null,
      body: inboundBody,
      messageSid: messageSid,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "received",
      forwardedTo: managerE164 || null,
    });

    // 5. Forward to Volunteer Manager with 1-tap wa.me reply link
    if (managerE164) {
      const cleanPhone = volunteerE164.replace(/^\+/, "");
      const waLink = `https://wa.me/${cleanPhone}`;
      const forwardText =
          `📩 *Inbound Volunteer Reply*\n\n` +
          `*From:* ${volunteerName} (${volunteerE164})\n` +
          `*Upcoming Shift:* ${upcomingShiftInfo}\n\n` +
          `*Message:*\n"${inboundBody}"\n\n` +
          `👉 Tap to reply directly:\n${waLink}`;

      await sendWhatsAppAlert({
        to: managerE164,
        body: forwardText,
      });
    }

    // 6. Send automated acknowledgment reply to the volunteer
    const ackText =
        `Hi ${volunteerName}, thanks for your message! Our volunteer ` +
        `coordinator has received it and will follow up shortly.\n\n` +
        `For shift rosters or info, please check the BrewCrew app.`;

    await sendWhatsAppAlert({
      to: volunteerE164,
      body: ackText,
    });
  } catch (err) {
    console.error("Error processing inbound WhatsApp webhook:", err);
  }

  res.status(200).send("<Response></Response>");
});

// ====================================================================
// GROUP MANAGEMENT
// ====================================================================

const GROUP_NAME_MIN = 2;
const GROUP_NAME_MAX = 50;
const BATCH_LIMIT = 450;

/**
 * Normalises a raw group name: trims and collapses internal whitespace.
 * @param {*} raw Raw input value.
 * @return {string} Cleaned name ("" if not a usable string).
 */
function normalizeGroupName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Builds the case/whitespace-insensitive lookup key for a group name.
 * @param {string} name Group name.
 * @return {string} Lowercased normalised key.
 */
function groupNameKey(name) {
  return normalizeGroupName(name).toLowerCase();
}

/**
 * Validates a group name supplied to an admin callable.
 * @param {*} raw Raw name from request data.
 * @return {string} Normalised, validated name.
 */
function requireValidGroupName(raw) {
  const name = normalizeGroupName(raw);
  if (name.length < GROUP_NAME_MIN || name.length > GROUP_NAME_MAX) {
    throw new HttpsError(
        "invalid-argument",
        `Group name must be ${GROUP_NAME_MIN}-${GROUP_NAME_MAX} characters.`,
    );
  }
  return name;
}

/**
 * Verifies the caller is an enabled administrator.
 * @param {object} request Callable request.
 * @return {Promise<void>}
 */
async function assertActiveAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }
  const callerDoc = await db.collection("users").doc(request.auth.uid).get();
  if (!callerDoc.exists || callerDoc.data().role !== "admin") {
    throw new HttpsError(
        "permission-denied",
        "Only administrators can manage groups.",
    );
  }
  if (callerDoc.data().disabled) {
    throw new HttpsError(
        "permission-denied",
        "Administrator account is disabled.",
    );
  }
}

/**
 * Finds a group whose nameKey matches, optionally inside a transaction.
 * @param {string} key Group name key.
 * @param {object} [tx] Optional Firestore transaction.
 * @return {Promise<object|null>} Matching document snapshot or null.
 */
async function findGroupByKey(key, tx) {
  const q = db.collection("groups").where("nameKey", "==", key).limit(1);
  const snap = tx ? await tx.get(q) : await q.get();
  return snap.empty ? null : snap.docs[0];
}

/**
 * Returns all user docs belonging to a group: either linked by groupId, or
 * (lazy migration) unlinked users whose free-text groupOrClub matches the
 * group's name key.
 * @param {string} groupId Group document ID.
 * @param {string} nameKey Group name key.
 * @return {Promise<Array<object>>} Matching user document snapshots.
 */
async function getGroupMemberDocs(groupId, nameKey) {
  const usersSnap = await db.collection("users").get();
  return usersSnap.docs.filter((d) => {
    const u = d.data();
    if (u.groupId) return u.groupId === groupId;
    return !!u.groupOrClub && groupNameKey(u.groupOrClub) === nameKey;
  });
}

/**
 * Applies the same update to many docs in chunked batches.
 * @param {Array<object>} docs Document snapshots.
 * @param {object} update Update payload.
 * @return {Promise<void>}
 */
async function batchUpdateDocs(docs, update) {
  for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_LIMIT).forEach((d) => batch.update(d.ref, update));
    await batch.commit();
  }
}

/**
 * Firestore Trigger: resolves a user's free-text groupOrClub to a canonical
 * /groups document, creating the group if none matches. Sets groupId and
 * the canonical name server-side so clients can never forge a groupId.
 * Also performs lazy migration of legacy free-text groups on any write.
 */
exports.onUserGroupWrite = onDocumentWritten(
    {document: "users/{userId}", region: "europe-west2"},
    async (event) => {
      const after = event.data?.after;
      if (!after || !after.exists) return;
      const data = after.data();
      const before = event.data.before?.exists ?
        event.data.before.data() : {};

      const name = normalizeGroupName(data.groupOrClub || "");
      const currentGroupId = data.groupId || null;

      // Fast path: nothing group-related changed and already resolved.
      if (
        currentGroupId &&
        before.groupOrClub === data.groupOrClub &&
        before.groupId === currentGroupId
      ) {
        return;
      }

      // No group (or unusable name): ensure groupId is cleared.
      if (name.length < GROUP_NAME_MIN) {
        if (currentGroupId) await after.ref.update({groupId: null});
        return;
      }

      const key = groupNameKey(name);

      // Already linked to a group whose canonical name matches exactly.
      if (currentGroupId) {
        const g = await db.collection("groups").doc(currentGroupId).get();
        if (g.exists && g.data().nameKey === key) {
          if (data.groupOrClub !== g.data().name) {
            await after.ref.update({groupOrClub: g.data().name});
          }
          return;
        }
      }

      // Find or create the group atomically to avoid duplicates under
      // concurrent signups with the same name.
      const resolved = await db.runTransaction(async (tx) => {
        const existing = await findGroupByKey(key, tx);
        if (existing) {
          return {id: existing.id, name: existing.data().name};
        }
        const ref = db.collection("groups").doc();
        const newName = name.slice(0, GROUP_NAME_MAX);
        tx.set(ref, {
          name: newName,
          nameKey: groupNameKey(newName),
          includeInGroupIncentives: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          createdBy: "signup",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return {id: ref.id, name: newName};
      });

      if (
        resolved.id !== currentGroupId ||
        resolved.name !== data.groupOrClub
      ) {
        await after.ref.update({
          groupId: resolved.id,
          groupOrClub: resolved.name,
        });
      }
    },
);

/**
 * Admin: Create a new group.
 */
exports.createGroup = onCall(async (request) => {
  await assertActiveAdmin(request);
  const name = requireValidGroupName(request.data?.name);
  const include = request.data?.includeInGroupIncentives;
  if (include !== undefined && typeof include !== "boolean") {
    throw new HttpsError(
        "invalid-argument",
        "includeInGroupIncentives must be a boolean.",
    );
  }
  const key = groupNameKey(name);

  const groupId = await db.runTransaction(async (tx) => {
    if (await findGroupByKey(key, tx)) {
      throw new HttpsError(
          "already-exists",
          `A group named "${name}" already exists.`,
      );
    }
    const ref = db.collection("groups").doc();
    tx.set(ref, {
      name,
      nameKey: key,
      includeInGroupIncentives: include !== false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: request.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  });

  return {success: true, groupId, name};
});

/**
 * Admin: Rename a group and/or toggle its Group Incentives eligibility.
 * Renames propagate to all member users' groupOrClub.
 */
exports.updateGroup = onCall(async (request) => {
  await assertActiveAdmin(request);
  const {groupId, name: rawName, includeInGroupIncentives} =
    request.data || {};
  if (!groupId || typeof groupId !== "string") {
    throw new HttpsError("invalid-argument", "groupId is required.");
  }
  if (rawName === undefined && includeInGroupIncentives === undefined) {
    throw new HttpsError(
        "invalid-argument",
        "Provide name and/or includeInGroupIncentives.",
    );
  }
  if (
    includeInGroupIncentives !== undefined &&
    typeof includeInGroupIncentives !== "boolean"
  ) {
    throw new HttpsError(
        "invalid-argument",
        "includeInGroupIncentives must be a boolean.",
    );
  }

  const groupRef = db.collection("groups").doc(groupId);
  const groupDoc = await groupRef.get();
  if (!groupDoc.exists) {
    throw new HttpsError("not-found", "Group does not exist.");
  }
  const oldKey = groupDoc.data().nameKey;
  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  };
  let newName = groupDoc.data().name;

  if (rawName !== undefined) {
    newName = requireValidGroupName(rawName);
    const newKey = groupNameKey(newName);
    if (newKey !== oldKey) {
      const clash = await findGroupByKey(newKey);
      if (clash && clash.id !== groupId) {
        throw new HttpsError(
            "already-exists",
            `A group named "${newName}" already exists. Use merge instead.`,
        );
      }
    }
    updates.name = newName;
    updates.nameKey = newKey;
  }
  if (includeInGroupIncentives !== undefined) {
    updates.includeInGroupIncentives = includeInGroupIncentives;
  }

  // Collect members before changing nameKey so lazy (unlinked) members
  // matching the old name are captured too.
  let updatedUsers = 0;
  if (updates.name !== undefined && updates.name !== groupDoc.data().name) {
    const members = await getGroupMemberDocs(groupId, oldKey);
    await groupRef.update(updates);
    await batchUpdateDocs(members, {groupId, groupOrClub: newName});
    updatedUsers = members.length;
  } else {
    await groupRef.update(updates);
  }

  return {
    success: true,
    groupId,
    name: newName,
    includeInGroupIncentives: updates.includeInGroupIncentives ??
      groupDoc.data().includeInGroupIncentives !== false,
    updatedUsers,
  };
});

/**
 * Admin: Merge source group into target group, then delete the source.
 */
exports.mergeGroups = onCall(async (request) => {
  await assertActiveAdmin(request);
  const {sourceGroupId, targetGroupId} = request.data || {};
  if (!sourceGroupId || !targetGroupId ||
      typeof sourceGroupId !== "string" || typeof targetGroupId !== "string") {
    throw new HttpsError(
        "invalid-argument",
        "sourceGroupId and targetGroupId are required.",
    );
  }
  if (sourceGroupId === targetGroupId) {
    throw new HttpsError(
        "invalid-argument",
        "Cannot merge a group into itself.",
    );
  }

  const [sourceDoc, targetDoc] = await Promise.all([
    db.collection("groups").doc(sourceGroupId).get(),
    db.collection("groups").doc(targetGroupId).get(),
  ]);
  if (!sourceDoc.exists || !targetDoc.exists) {
    throw new HttpsError("not-found", "Source or target group not found.");
  }

  const targetName = targetDoc.data().name;
  const members = await getGroupMemberDocs(
      sourceGroupId, sourceDoc.data().nameKey,
  );
  // Delete the source first so the trigger cannot re-link to it.
  await sourceDoc.ref.delete();
  await batchUpdateDocs(members, {
    groupId: targetGroupId,
    groupOrClub: targetName,
  });

  return {
    success: true,
    targetGroupId,
    targetName,
    movedUsers: members.length,
  };
});

/**
 * Admin: Delete a group. Member users are set to "No group".
 */
exports.deleteGroup = onCall(async (request) => {
  await assertActiveAdmin(request);
  const {groupId} = request.data || {};
  if (!groupId || typeof groupId !== "string") {
    throw new HttpsError("invalid-argument", "groupId is required.");
  }
  const groupDoc = await db.collection("groups").doc(groupId).get();
  if (!groupDoc.exists) {
    throw new HttpsError("not-found", "Group does not exist.");
  }

  const members = await getGroupMemberDocs(groupId, groupDoc.data().nameKey);
  await groupDoc.ref.delete();
  await batchUpdateDocs(members, {groupId: null, groupOrClub: ""});

  return {success: true, groupId, affectedUsers: members.length};
});

/**
 * Admin: Assign a user to a group, or clear their group (groupId: null).
 */
exports.setUserGroup = onCall(async (request) => {
  await assertActiveAdmin(request);
  const {targetUserId, groupId} = request.data || {};
  if (!targetUserId || typeof targetUserId !== "string") {
    throw new HttpsError("invalid-argument", "targetUserId is required.");
  }
  if (groupId !== null && (typeof groupId !== "string" || !groupId)) {
    throw new HttpsError(
        "invalid-argument",
        "groupId must be a group ID string or null.",
    );
  }

  const userRef = db.collection("users").doc(targetUserId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    throw new HttpsError("not-found", "Target user does not exist.");
  }

  let groupName = "";
  if (groupId) {
    const groupDoc = await db.collection("groups").doc(groupId).get();
    if (!groupDoc.exists) {
      throw new HttpsError("not-found", "Group does not exist.");
    }
    groupName = groupDoc.data().name;
  }

  await userRef.update({
    groupId: groupId || null,
    groupOrClub: groupName,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  });

  return {
    success: true,
    userId: targetUserId,
    groupId: groupId || null,
    groupName,
  };
});

/**
 * Admin: Update User Profile
 * (Name, Email, Phone, Group, Visibility, Notifications)
 */
exports.adminUpdateUserProfile = onCall(async (request) => {
  await assertActiveAdmin(request);
  const {
    targetUserId,
    fullName,
    email,
    phoneNumber,
    groupOrClub,
    groupId,
    profileVisibility,
    whatsappNotifications,
    emailNotifications,
  } = request.data || {};

  if (!targetUserId || typeof targetUserId !== "string") {
    throw new HttpsError("invalid-argument", "targetUserId is required.");
  }

  const userRef = db.collection("users").doc(targetUserId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) {
    throw new HttpsError("not-found", "Target user does not exist.");
  }

  const currentData = userDoc.data();
  const updates = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  };

  const authUpdates = {};

  if (fullName !== undefined) {
    if (typeof fullName !== "string" || !fullName.trim()) {
      throw new HttpsError("invalid-argument", "Full name cannot be empty.");
    }
    updates.fullName = fullName.trim();
    authUpdates.displayName = fullName.trim();
  }

  if (email !== undefined) {
    if (typeof email !== "string" || !email.trim()) {
      throw new HttpsError("invalid-argument", "Email cannot be empty.");
    }
    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      throw new HttpsError(
          "invalid-argument",
          "Invalid email address format.",
      );
    }

    const blockedDoc = await db
        .collection("blockedEmails")
        .doc(normalizedEmail)
        .get();
    if (blockedDoc.exists) {
      throw new HttpsError(
          "failed-precondition",
          "This email address is currently blocked from registration.",
      );
    }

    updates.email = normalizedEmail;
    authUpdates.email = normalizedEmail;
  }

  if (phoneNumber !== undefined) {
    if (phoneNumber && typeof phoneNumber === "string") {
      const normalizedPhone = normalizeE164(phoneNumber);
      updates.phoneNumber = normalizedPhone || phoneNumber.trim();
    } else {
      updates.phoneNumber = "";
    }
  }

  if (groupOrClub !== undefined) {
    updates.groupOrClub =
      typeof groupOrClub === "string" ? groupOrClub.trim() : "";
  }
  if (groupId !== undefined) {
    updates.groupId = groupId || null;
  }
  if (profileVisibility !== undefined) {
    if (["public", "private"].includes(profileVisibility)) {
      updates.profileVisibility = profileVisibility;
    }
  }
  if (whatsappNotifications !== undefined &&
      typeof whatsappNotifications === "boolean") {
    updates.whatsappNotifications = whatsappNotifications;
  }
  if (emailNotifications !== undefined &&
      typeof emailNotifications === "boolean") {
    updates.emailNotifications = emailNotifications;
  }

  // Update Firebase Authentication
  if (Object.keys(authUpdates).length > 0) {
    try {
      await admin.auth().updateUser(targetUserId, authUpdates);
    } catch (authErr) {
      if (authErr.code === "auth/email-already-exists") {
        throw new HttpsError(
            "already-exists",
            "This email address is already in use by another account.",
        );
      }
      if (authErr.code === "auth/invalid-email") {
        throw new HttpsError(
            "invalid-argument",
            "The email address is invalid.",
        );
      }
      console.warn("Auth updateUser warning:", authErr.message);
    }
  }

  await userRef.update(updates);

  // If fullName or email changed, update shifts where user is manager
  if (updates.fullName || updates.email) {
    const managerShifts = await db
        .collection("shifts")
        .where("managerId", "==", targetUserId)
        .get();
    if (!managerShifts.empty) {
      const batch = db.batch();
      managerShifts.docs.forEach((doc) => {
        const shiftUpdates = {};
        if (updates.fullName) shiftUpdates.managerName = updates.fullName;
        if (updates.email) shiftUpdates.managerEmail = updates.email;
        batch.update(doc.ref, shiftUpdates);
      });
      await batch.commit();
    }
  }

  return {
    success: true,
    userId: targetUserId,
    updates: {
      fullName: updates.fullName || currentData.fullName,
      email: updates.email || currentData.email,
      phoneNumber: updates.phoneNumber !== undefined ?
        updates.phoneNumber :
        currentData.phoneNumber,
    },
  };
});


