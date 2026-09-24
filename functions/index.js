// functions/index.js
const {onCall, HttpsError} = require("firebase-functions/v2/https");
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
 * Atomic Shift Registration to Prevent Overbooking (Race Conditions)
 */
exports.claimShift = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const {shiftId} = request.data;
  if (!shiftId) {
    throw new HttpsError("invalid-argument", "shiftId is required.");
  }

  const uid = request.auth.uid;
  const shiftRef = db.collection("shifts").doc(shiftId);
  const regDocId = `${shiftId}_${uid}`;
  const registrationRef = db.collection("registrations").doc(regDocId);

  return db.runTransaction(async (transaction) => {
    const shiftDoc = await transaction.get(shiftRef);
    if (!shiftDoc.exists) {
      throw new HttpsError("not-found", "Shift does not exist.");
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
      throw new HttpsError(
          "already-exists",
          "You are already registered for this shift.",
      );
    }

    // Execute atomic updates
    transaction.update(shiftRef, {
      assignedCount: admin.firestore.FieldValue.increment(1),
    });

    transaction.set(registrationRef, {
      shiftId: shiftId,
      userId: uid,
      registeredAt: admin.firestore.FieldValue.serverTimestamp(),
      status: "confirmed",
    });

    return {success: true};
  });
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

  return db.runTransaction(async (transaction) => {
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
    const startTimeMs = typeof shiftData.startTime?.toMillis === "function" ?
      shiftData.startTime.toMillis() :
      (shiftData.startTime?.seconds ?
        shiftData.startTime.seconds * 1000 :
        new Date(shiftData.startTime).getTime());
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

    return {success: true};
  });
});

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

  const {subject, body, targetRole} = request.data;
  if (!subject || typeof subject !== "string" || !subject.trim()) {
    throw new HttpsError("invalid-argument", "Subject is required.");
  }
  if (!body || typeof body !== "string" || !body.trim()) {
    throw new HttpsError("invalid-argument", "Message body is required.");
  }

  let usersQuery = db.collection("users");
  if (targetRole && targetRole !== "all") {
    usersQuery = usersQuery.where("role", "==", targetRole);
  }
  const usersSnap = await usersQuery.get();

  const emails = [...new Set(
      usersSnap.docs
          .map((doc) => doc.data().email)
          .filter((e) => e && typeof e === "string" && e.includes("@")),
  )];

  let broadcastFromName = "BrewCrew Updates";
  try {
    const configDoc = await db.collection("config").doc("festival").get();
    if (configDoc.exists && configDoc.data().festivalName) {
      broadcastFromName = configDoc.data().festivalName;
    }
  } catch (e) {
    console.warn("Could not fetch festival name for broadcast:", e);
  }

  const formattedBody = body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((p) => `<p style="margin-bottom: 12px;">${p}</p>`)
      .join("");

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; color: #1e293b;">
      ${formattedBody}
    </div>
  `;

  const transporter = getTransporter();
  const gmailEmail = process.env.GMAIL_EMAIL;
  const sendPromises = emails.map((email) =>
    transporter.sendMail({
      from: `"${broadcastFromName}" <${gmailEmail}>`,
      to: email,
      subject: subject.trim(),
      html: emailHtml,
    }),
  );

  try {
    await Promise.all(sendPromises);
    return {success: true, count: emails.length};
  } catch (err) {
    throw new HttpsError("internal", err.message);
  }
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

