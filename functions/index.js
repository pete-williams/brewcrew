// functions/index.js
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// Retrieve Gmail credentials from process.env (.env file)
const gmailEmail = process.env.GMAIL_EMAIL;
const gmailPass = process.env.GMAIL_PASS;

// Configure Nodemailer Transporter for Gmail / Google Workspace
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: gmailEmail,
    pass: gmailPass,
  },
});

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

    // 7-day lockout rule check (unless admin)
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const startTimeMs = typeof shiftData.startTime?.toMillis === "function" ?
      shiftData.startTime.toMillis() :
      (shiftData.startTime?.seconds ?
        shiftData.startTime.seconds * 1000 :
        new Date(shiftData.startTime).getTime());
    const nowMs = Date.now();

    if (!isAdmin && (startTimeMs - nowMs < sevenDaysMs)) {
      throw new HttpsError(
          "failed-precondition",
          "Cannot cancel shifts within 7 days of shift start time.",
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
 * Trigger: Automated Transactional Email Confirmation on Registration
 */
exports.onRegistrationCreated = onDocumentCreated(
    "registrations/{registrationId}",
    async (event) => {
      const snap = event.data;
      if (!snap) return null;

      const regData = snap.data();
      if (!regData) return null;

      const userDoc = await db.collection("users").doc(regData.userId).get();
      const shiftDoc = await db.collection("shifts").doc(regData.shiftId).get();

      if (!userDoc.exists || !shiftDoc.exists) return null;

      const user = userDoc.data();
      const shift = shiftDoc.data();

      const startTimeStr = typeof shift.startTime?.toDate === "function" ?
        shift.startTime.toDate().toLocaleString() :
        new Date(shift.startTime).toLocaleString();

      const projectId = process.env.GCLOUD_PROJECT ||
        process.env.PROJECT_ID ||
        process.env.GCP_PROJECT ||
        "brewcrew-f27fb";

      const mailOptions = {
        from: `"BrewCrew Volunteer Team" <${gmailEmail}>`,
        to: user.email,
        subject: "Shift Registration Confirmation - Beer Festival",
        html: `
      <h2>Hi ${user.fullName},</h2>
      <p>You have successfully registered for a shift!</p>
      <ul>
        <li><strong>Day:</strong> Day ${shift.dayIndex}</li>
        <li><strong>Start Time:</strong> ${startTimeStr}</li>
        <li><strong>Duration:</strong> Minimum 2 Hours</li>
      </ul>
      <p>You can manage your shifts up to 7 days prior to the festival.</p>
      <a href="https://${projectId}.web.app/">Manage My Shifts</a>
    `,
      };

      try {
        await transporter.sendMail(mailOptions);
      } catch (error) {
        console.error("Email dispatch failure:", error);
      }
    },
);

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

  const {subject, body} = request.data;
  const usersSnap = await db.collection("users").get();

  const emails = usersSnap.docs.map((doc) => doc.data().email).filter(Boolean);

  const sendPromises = emails.map((email) =>
    transporter.sendMail({
      from: `"BrewCrew Updates" <${gmailEmail}>`,
      to: email,
      subject: subject,
      html: `<p>${body}</p>`,
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
    dayIndex,
    categoryName,
    capacity,
    startTime,
    endTime,
    managerUserId,
  } = request.data;

  const parsedDay = parseInt(dayIndex, 10);
  if (isNaN(parsedDay) || parsedDay < 1 || parsedDay > 7) {
    throw new HttpsError(
        "invalid-argument",
        "dayIndex must be an integer between 1 and 7.",
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
    dayIndex: parsedDay,
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

