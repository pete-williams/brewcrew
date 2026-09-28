// public/admin.js
// Dedicated Administrator & Configuration Portal Logic for BrewCrew

// 1. Initialize Firebase
const firebaseConfig = window.firebaseConfig;
if (!firebaseConfig || !firebaseConfig.apiKey) {
  console.error("Firebase config not loaded.");
}

firebase.initializeApp(firebaseConfig || {});
const auth = firebase.auth();
const db = firebase.firestore();
const functions = firebase.functions();

// Global State
let currentAdminUser = null;
let currentAdminProfile = null;
let activeAdminTab = "crew";

let allUsersMap = new Map();
let currentShiftsDocs = [];
let allRegistrationsDocs = [];
let blockedEmailsMap = new Map();
let currentFestivalConfig = {
  festivalName: "BrewCrew",
  festivalWebsite: "",
  festivalLogoUrl: "",
  volunteerManager: { name: "", email: "", phone: "" },
  sessions: []
};
let currentIncentivesConfig = {
  welcomeTitle: "Welcome to BrewCrew!",
  welcomeText: "Join our volunteer team to earn rewards while enjoying the festival.",
  items: []
};
let currentRolesConfig = { roles: {} };

// Crew Directory State (Scalable for 50-100 Volunteers)
let crewSearchQuery = "";
let crewRoleFilter = "ALL";
let crewStatusFilter = "ALL";
let crewSortMode = "name-asc";
let crewPageSize = 25;
let crewCurrentPage = 1;

// Shift Filter State
let shiftSessionFilter = "ALL";

// Auth Gate Listener
auth.onAuthStateChanged(async (user) => {
  const gateEl = document.getElementById("admin-auth-gate");
  const appEl = document.getElementById("admin-app");
  const gateTitle = document.getElementById("gate-title");
  const gateMsg = document.getElementById("gate-message");
  const gateAction = document.getElementById("gate-action");

  if (!user) {
    if (gateTitle) gateTitle.innerText = "Authentication Required";
    if (gateMsg) gateMsg.innerText = "Please sign in to access the BrewCrew Administrator Portal.";
    if (gateAction) gateAction.classList.remove("hidden");
    return;
  }

  currentAdminUser = user;

  try {
    const userDoc = await db.collection("users").doc(user.uid).get();
    if (!userDoc.exists || userDoc.data().role !== "admin") {
      if (gateTitle) gateTitle.innerText = "Access Restricted";
      if (gateMsg) gateMsg.innerText = "Your account does not possess administrator privileges. Only designated festival administrators can access this console.";
      if (gateAction) gateAction.classList.remove("hidden");
      return;
    }

    currentAdminProfile = userDoc.data();

    if (currentAdminProfile.disabled) {
      if (gateTitle) gateTitle.innerText = "Account Deactivated";
      if (gateMsg) gateMsg.innerText = "This administrator account has been deactivated. Please contact festival leadership.";
      if (gateAction) gateAction.classList.remove("hidden");
      await auth.signOut();
      return;
    }

    // Authorized Admin -> Reveal App
    if (gateEl) gateEl.classList.add("hidden");
    if (appEl) {
      appEl.classList.remove("hidden");
      appEl.classList.add("flex");
    }

    populateAdminHeader();
    initializeRealtimeSubscriptions();
    handleHashNavigation();
  } catch (err) {
    console.error("Admin verification error:", err);
    if (gateTitle) gateTitle.innerText = "Verification Error";
    if (gateMsg) gateMsg.innerText = "Failed to verify administrator credentials: " + err.message;
    if (gateAction) gateAction.classList.remove("hidden");
  }
});

function populateAdminHeader() {
  const nameEl = document.getElementById("admin-user-name");
  const emailEl = document.getElementById("admin-user-email");
  const initialsEl = document.getElementById("admin-avatar-initials");
  const imgEl = document.getElementById("admin-avatar-img");

  const displayName = currentAdminProfile?.fullName || currentAdminUser?.displayName || "Administrator";
  const email = currentAdminProfile?.email || currentAdminUser?.email || "";
  const photo = currentAdminProfile?.photoURL || currentAdminUser?.photoURL || "";

  if (nameEl) nameEl.textContent = displayName;
  if (emailEl) emailEl.textContent = email;

  if (photo && imgEl && initialsEl) {
    imgEl.src = photo;
    imgEl.classList.remove("hidden");
    initialsEl.classList.add("hidden");
  } else if (initialsEl) {
    initialsEl.textContent = (displayName[0] || "A").toUpperCase();
    if (imgEl) imgEl.classList.add("hidden");
  }
}

function adminSignOut() {
  auth.signOut().then(() => {
    window.location.href = "index.html";
  }).catch((err) => {
    console.error("Sign out error:", err);
  });
}

// ============================================================================
// REAL-TIME FIRESTORE SUBSCRIPTIONS
// ============================================================================
function initializeRealtimeSubscriptions() {
  // 1. Users Collection
  db.collection("users").onSnapshot((snapshot) => {
    allUsersMap.clear();
    snapshot.docs.forEach((doc) => {
      allUsersMap.set(doc.id, { id: doc.id, ...doc.data() });
    });
    updateCrewSummaryStats();
    renderCrewDirectory();
  }, (err) => console.warn("Users subscription error:", err));

  // 2. Shifts Collection
  db.collection("shifts").onSnapshot((snapshot) => {
    currentShiftsDocs = snapshot.docs;
    const badgeEl = document.getElementById("badge-shifts-count");
    if (badgeEl) badgeEl.textContent = snapshot.size;
    renderShiftsPanel();
    renderSessionsTable();
    renderRolesTable();
  }, (err) => console.warn("Shifts subscription error:", err));

  // 3. Registrations Collection (Realtime for occupancy and volunteer shift count)
  db.collection("registrations").where("status", "==", "confirmed").onSnapshot((snapshot) => {
    allRegistrationsDocs = snapshot.docs;
    renderCrewDirectory();
    renderShiftsPanel();
  }, (err) => console.warn("Registrations subscription error:", err));

  // 4. Festival Configuration
  db.collection("config").doc("festival").onSnapshot((doc) => {
    if (doc.exists) {
      currentFestivalConfig = doc.data();
      const nameEl = document.getElementById("header-festival-name");
      if (nameEl && currentFestivalConfig.festivalName) {
        nameEl.textContent = currentFestivalConfig.festivalName;
      }
      populateFestivalConfigForm();
      renderSessionsTable();
      renderShiftsSessionFilters();
    }
  }, (err) => console.warn("Festival config subscription error:", err));

  // 5. Incentives Configuration
  db.collection("config").doc("incentives").onSnapshot((doc) => {
    if (doc.exists) {
      currentIncentivesConfig = doc.data();
      populateIncentivesForm();
      renderIncentivesTable();
    }
  }, (err) => console.warn("Incentives config subscription error:", err));

  // 6. Roles Configuration
  db.collection("config").doc("roles").onSnapshot((doc) => {
    if (doc.exists) {
      currentRolesConfig = doc.data();
      renderRolesTable();
    }
  }, (err) => console.warn("Roles config subscription error:", err));

  // 7. Blocked Emails Blacklist
  db.collection("blockedEmails").onSnapshot((snapshot) => {
    blockedEmailsMap.clear();
    snapshot.docs.forEach((doc) => {
      blockedEmailsMap.set(doc.id, { id: doc.id, ...doc.data() });
    });
    const badge = document.getElementById("badge-blocked-count");
    const stat = document.getElementById("stat-blocked-count");
    if (badge) badge.textContent = snapshot.size;
    if (stat) stat.textContent = snapshot.size;
    renderBlockedEmailsTable();
  }, (err) => console.warn("Blocked emails subscription error:", err));
}

// ============================================================================
// TAB NAVIGATION & HASH ROUTING
// ============================================================================
const VALID_TABS = ["crew", "sessions", "shifts", "incentives", "roles", "broadcast", "blocked"];

function switchAdminTab(tabName) {
  if (!VALID_TABS.includes(tabName)) tabName = "crew";
  activeAdminTab = tabName;

  VALID_TABS.forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    const panel = document.getElementById(`panel-${t}`);
    const isActive = t === tabName;

    if (panel) {
      if (isActive) {
        panel.classList.remove("hidden");
      } else {
        panel.classList.add("hidden");
      }
    }

    if (btn) {
      if (isActive) {
        btn.className = "admin-tab-btn flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold whitespace-nowrap transition min-h-[44px] bg-amber-700 text-white shadow-xs";
      } else {
        btn.className = "admin-tab-btn flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition min-h-[44px] text-amber-200/90 hover:text-white hover:bg-amber-900/60";
      }
    }
  });

  if (window.location.hash !== `#${tabName}`) {
    window.location.hash = `#${tabName}`;
  }
}

function handleHashNavigation() {
  const hash = (window.location.hash || "").replace("#", "").trim();
  if (VALID_TABS.includes(hash)) {
    switchAdminTab(hash);
  } else {
    switchAdminTab("crew");
  }
}

window.addEventListener("hashchange", handleHashNavigation);

// ============================================================================
// TAB 1: CREW & VOLUNTEER DIRECTORY (50-100 Volunteers Scalability)
// ============================================================================
function updateCrewSummaryStats() {
  let countVolunteers = 0;
  let countManagers = 0;
  let countAdmins = 0;
  let countDisabled = 0;

  allUsersMap.forEach((u) => {
    if (u.disabled) countDisabled++;
    const r = u.role || "volunteer";
    if (r === "admin") countAdmins++;
    else if (r === "manager") countManagers++;
    else countVolunteers++;
  });

  const total = allUsersMap.size;
  const statTotal = document.getElementById("stat-total-crew");
  const statVol = document.getElementById("stat-volunteers");
  const statMgr = document.getElementById("stat-managers");
  const statAdm = document.getElementById("stat-admins");
  const statDis = document.getElementById("stat-disabled");
  const badgeCrew = document.getElementById("badge-crew-count");

  if (statTotal) statTotal.textContent = total;
  if (statVol) statVol.textContent = countVolunteers;
  if (statMgr) statMgr.textContent = countManagers;
  if (statAdm) statAdm.textContent = countAdmins;
  if (statDis) statDis.textContent = countDisabled;
  if (badgeCrew) badgeCrew.textContent = total;
}

function handleCrewSearch(query) {
  crewSearchQuery = (query || "").trim().toLowerCase();
  crewCurrentPage = 1;
  renderCrewDirectory();
}

function setCrewRoleFilter(role) {
  crewRoleFilter = role;
  crewCurrentPage = 1;

  ["ALL", "volunteer", "manager", "admin"].forEach((r) => {
    const pill = document.getElementById(`role-pill-${r}`);
    if (!pill) return;
    if (r === role) {
      pill.className = "crew-role-pill px-2.5 py-1 rounded-full text-2xs font-bold transition bg-amber-700 text-white shadow-2xs";
    } else {
      pill.className = "crew-role-pill px-2.5 py-1 rounded-full text-2xs font-bold transition bg-stone-100 text-slate-600 hover:bg-stone-200";
    }
  });

  renderCrewDirectory();
}

function setCrewStatusFilter(status) {
  crewStatusFilter = status;
  crewCurrentPage = 1;

  ["ALL", "active", "disabled"].forEach((s) => {
    const pill = document.getElementById(`status-pill-${s}`);
    if (!pill) return;
    if (s === status) {
      pill.className = "crew-status-pill px-2 py-0.5 rounded-md text-2xs font-bold transition bg-slate-800 text-white shadow-2xs";
    } else {
      pill.className = "crew-status-pill px-2 py-0.5 rounded-md text-2xs font-bold transition bg-stone-100 text-slate-600 hover:bg-stone-200 border border-slate-300";
    }
  });

  renderCrewDirectory();
}

function handleCrewSortChange(val) {
  crewSortMode = val;
  renderCrewDirectory();
}

function handleCrewPageSizeChange(val) {
  crewPageSize = parseInt(val, 10) || 25;
  crewCurrentPage = 1;
  renderCrewDirectory();
}

function getVolunteerShiftCount(userId) {
  return allRegistrationsDocs.filter((doc) => doc.data().userId === userId).length;
}

function getFilteredAndSortedCrew() {
  const users = Array.from(allUsersMap.values());

  // Filter
  const filtered = users.filter((u) => {
    // Role filter
    if (crewRoleFilter !== "ALL" && (u.role || "volunteer") !== crewRoleFilter) {
      return false;
    }
    // Status filter
    if (crewStatusFilter === "active" && u.disabled) return false;
    if (crewStatusFilter === "disabled" && !u.disabled) return false;

    // Search query
    if (crewSearchQuery) {
      const name = (u.fullName || "").toLowerCase();
      const email = (u.email || "").toLowerCase();
      const phone = (u.phoneNumber || "").toLowerCase();
      const group = (u.groupOrClub || "").toLowerCase();
      return name.includes(crewSearchQuery) ||
             email.includes(crewSearchQuery) ||
             phone.includes(crewSearchQuery) ||
             group.includes(crewSearchQuery);
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    const nameA = (a.fullName || a.email || "").toLowerCase();
    const nameB = (b.fullName || b.email || "").toLowerCase();

    if (crewSortMode === "name-desc") {
      return nameB.localeCompare(nameA);
    }
    if (crewSortMode === "role") {
      const order = { admin: 1, manager: 2, volunteer: 3 };
      const rA = order[a.role || "volunteer"] || 9;
      const rB = order[b.role || "volunteer"] || 9;
      if (rA !== rB) return rA - rB;
      return nameA.localeCompare(nameB);
    }
    if (crewSortMode === "shifts-desc") {
      const sA = getVolunteerShiftCount(a.id);
      const sB = getVolunteerShiftCount(b.id);
      if (sB !== sA) return sB - sA;
      return nameA.localeCompare(nameB);
    }
    if (crewSortMode === "status") {
      const disA = Boolean(a.disabled);
      const disB = Boolean(b.disabled);
      if (disA !== disB) return disA ? 1 : -1;
      return nameA.localeCompare(nameB);
    }
    // default: name-asc
    return nameA.localeCompare(nameB);
  });

  return filtered;
}

function renderCrewDirectory() {
  const tableBody = document.getElementById("crew-table-body");
  const cardsContainer = document.getElementById("crew-cards-container");
  const paginationInfo = document.getElementById("crew-pagination-info");
  const paginationControls = document.getElementById("crew-pagination-controls");

  if (!tableBody || !cardsContainer) return;

  const filteredUsers = getFilteredAndSortedCrew();
  const totalCount = filteredUsers.length;

  if (totalCount === 0) {
    tableBody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400 italic">No crew members match the selected filters.</td></tr>`;
    cardsContainer.innerHTML = `<div class="p-6 text-center text-slate-400 italic text-xs">No crew members match the selected filters.</div>`;
    if (paginationInfo) paginationInfo.textContent = "Showing 0 to 0 of 0 crew members";
    if (paginationControls) paginationControls.innerHTML = "";
    return;
  }

  // Pagination calculation
  const totalPages = Math.ceil(totalCount / crewPageSize);
  if (crewCurrentPage > totalPages) crewCurrentPage = totalPages;
  if (crewCurrentPage < 1) crewCurrentPage = 1;

  const startIndex = (crewCurrentPage - 1) * crewPageSize;
  const endIndex = Math.min(startIndex + crewPageSize, totalCount);
  const pageUsers = filteredUsers.slice(startIndex, endIndex);

  // Update Pagination Info
  if (paginationInfo) {
    paginationInfo.innerHTML = `Showing <strong class="text-slate-700 font-semibold tabular-nums">${startIndex + 1}</strong> to <strong class="text-slate-700 font-semibold tabular-nums">${endIndex}</strong> of <strong class="text-slate-700 font-semibold tabular-nums">${totalCount}</strong> crew members`;
  }

  // Build Pagination Controls
  if (paginationControls) {
    paginationControls.innerHTML = "";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.disabled = crewCurrentPage === 1;
    prevBtn.className = `px-2.5 py-1 rounded-md text-xs font-semibold border ${crewCurrentPage === 1 ? 'border-slate-200 text-slate-300 cursor-not-allowed' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;
    prevBtn.textContent = "Previous";
    prevBtn.onclick = () => { if (crewCurrentPage > 1) { crewCurrentPage--; renderCrewDirectory(); } };
    paginationControls.appendChild(prevBtn);

    // Page indicator
    const pageIndicator = document.createElement("span");
    pageIndicator.className = "px-2 text-2xs font-bold text-slate-500 tabular-nums";
    pageIndicator.textContent = `Page ${crewCurrentPage} of ${totalPages}`;
    paginationControls.appendChild(pageIndicator);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.disabled = crewCurrentPage === totalPages;
    nextBtn.className = `px-2.5 py-1 rounded-md text-xs font-semibold border ${crewCurrentPage === totalPages ? 'border-slate-200 text-slate-300 cursor-not-allowed' : 'border-slate-300 text-slate-700 hover:bg-slate-100'}`;
    nextBtn.textContent = "Next";
    nextBtn.onclick = () => { if (crewCurrentPage < totalPages) { crewCurrentPage++; renderCrewDirectory(); } };
    paginationControls.appendChild(nextBtn);
  }

  // 1. Render Desktop Table Rows
  tableBody.innerHTML = "";
  pageUsers.forEach((u) => {
    const tr = document.createElement("tr");
    tr.className = `hover:bg-amber-50/40 transition ${u.disabled ? 'bg-rose-50/30' : ''}`;

    const isSelf = currentAdminUser && u.id === currentAdminUser.uid;
    const role = u.role || "volunteer";
    const shiftsCount = getVolunteerShiftCount(u.id);

    let roleBadgeClass = "bg-amber-100 text-amber-900 border border-amber-300";
    let roleText = "Volunteer";
    if (role === "admin") {
      roleBadgeClass = "bg-purple-100 text-purple-900 border border-purple-300";
      roleText = "Admin";
    } else if (role === "manager") {
      roleBadgeClass = "bg-blue-100 text-blue-900 border border-blue-300";
      roleText = "Shift Mgr";
    }

    const statusBadge = u.disabled ?
      `<span class="px-2 py-0.5 rounded-full text-2xs font-bold bg-rose-100 text-rose-800 border border-rose-300">Disabled</span>` :
      `<span class="px-2 py-0.5 rounded-full text-2xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">Active</span>`;

    tr.innerHTML = `
      <td class="p-3">
        <div class="flex items-center space-x-2.5">
          ${u.photoURL ? `
            <img src="${escapeHtml(u.photoURL)}" class="w-8 h-8 rounded-full object-cover shrink-0 border border-amber-300 shadow-2xs" alt="Avatar" />
          ` : `
            <div class="w-8 h-8 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 border border-amber-300">
              ${escapeHtml((u.fullName || u.email || "U")[0].toUpperCase())}
            </div>
          `}
          <div>
            <p class="font-bold text-slate-800 text-xs flex items-center gap-1.5">
              ${escapeHtml(u.fullName || "Volunteer")}
              ${isSelf ? '<span class="text-2xs text-amber-800 font-bold bg-amber-100 px-1 py-0.2 rounded">(You)</span>' : ''}
            </p>
            ${u.groupOrClub ? `<p class="text-2xs text-slate-400 font-medium">${escapeHtml(u.groupOrClub)}</p>` : ''}
          </div>
        </div>
      </td>
      <td class="p-3 text-slate-600 font-mono text-2xs">${escapeHtml(u.email || "—")}</td>
      <td class="p-3 text-slate-700 text-xs font-mono">${escapeHtml(u.phoneNumber || "—")}</td>
      <td class="p-3 text-center">
        ${isSelf ? `
          <span class="px-2 py-0.5 rounded-full text-2xs font-bold ${roleBadgeClass}">${roleText}</span>
        ` : `
          <select onchange="handleRoleChange('${u.id}', this.value, '${escapeJs(u.fullName || u.email)}', this)"
            class="text-xs p-1 rounded-md border border-slate-300 bg-white font-semibold focus:ring-2 focus:ring-amber-500">
            <option value="volunteer" ${role === 'volunteer' ? 'selected' : ''}>Volunteer</option>
            <option value="manager" ${role === 'manager' ? 'selected' : ''}>Shift Manager</option>
            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Administrator</option>
          </select>
        `}
      </td>
      <td class="p-3 text-center">
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums ${shiftsCount > 0 ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-500'}">
          ${shiftsCount} shift${shiftsCount === 1 ? '' : 's'}
        </span>
      </td>
      <td class="p-3 text-center">${statusBadge}</td>
      <td class="p-3 text-right">
        <div class="flex items-center justify-end gap-1.5">
          <button type="button" onclick="openAssignVolunteerModal(null, '${u.id}', '${escapeJs(u.fullName || u.email)}')"
            title="Assign shift to this volunteer"
            class="px-2 py-1 rounded-md text-2xs font-bold bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 transition">
            + Assign Shift
          </button>
          ${!isSelf ? `
            <button type="button" onclick="openToggleDisableModal('${u.id}', '${escapeJs(u.fullName || u.email)}', ${Boolean(u.disabled)})"
              title="${u.disabled ? 'Re-activate account' : 'Deactivate account'}"
              class="px-2 py-1 rounded-md text-2xs font-bold transition border ${u.disabled ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-stone-50 hover:bg-stone-100 text-slate-700 border-slate-300'}">
              ${u.disabled ? 'Enable' : 'Disable'}
            </button>
            <button type="button" onclick="openDeleteBlockModal('${u.id}', '${escapeJs(u.fullName || u.email)}', '${escapeJs(u.email || '')}')"
              title="Permanently delete account, release shifts, and block email"
              class="px-2 py-1 rounded-md text-2xs font-bold bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-300 transition">
              Delete &amp; Block
            </button>
          ` : ''}
        </div>
      </td>
    `;
    tableBody.appendChild(tr);
  });

  // 2. Render Mobile Cards
  cardsContainer.innerHTML = "";
  pageUsers.forEach((u) => {
    const card = document.createElement("div");
    card.className = `p-3 rounded-xl border ${u.disabled ? 'border-rose-200 bg-rose-50/20' : 'border-amber-200 bg-white'} shadow-2xs space-y-2.5`;

    const isSelf = currentAdminUser && u.id === currentAdminUser.uid;
    const role = u.role || "volunteer";
    const shiftsCount = getVolunteerShiftCount(u.id);

    card.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center space-x-2">
          ${u.photoURL ? `
            <img src="${escapeHtml(u.photoURL)}" class="w-8 h-8 rounded-full object-cover shrink-0 border border-amber-300" alt="Avatar" />
          ` : `
            <div class="w-8 h-8 rounded-full bg-amber-200 text-amber-900 font-bold flex items-center justify-center text-xs shrink-0 border border-amber-300">
              ${escapeHtml((u.fullName || u.email || "U")[0].toUpperCase())}
            </div>
          `}
          <div>
            <p class="font-bold text-slate-800 text-xs">
              ${escapeHtml(u.fullName || "Volunteer")} ${isSelf ? '<span class="text-2xs text-amber-800 font-bold bg-amber-100 px-1 py-0.2 rounded">(You)</span>' : ''}
            </p>
            <p class="text-2xs text-slate-500 font-mono">${escapeHtml(u.email || "No email")}</p>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="px-2 py-0.5 rounded-full text-2xs font-bold ${u.disabled ? 'bg-rose-100 text-rose-800 border border-rose-300' : 'bg-emerald-50 text-emerald-800 border border-emerald-300'}">
            ${u.disabled ? 'Disabled' : 'Active'}
          </span>
          <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums bg-amber-100 text-amber-900 border border-amber-300">
            ${shiftsCount} shift${shiftsCount === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div class="flex items-center justify-between text-2xs text-slate-600 border-t border-slate-100 pt-2">
        <span>Phone: <strong class="font-mono text-slate-800">${escapeHtml(u.phoneNumber || '—')}</strong></span>
        ${u.groupOrClub ? `<span>Club: <strong class="text-slate-800">${escapeHtml(u.groupOrClub)}</strong></span>` : ''}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-1.5 border-t border-slate-100 pt-2">
        <div class="flex items-center gap-1">
          <label class="text-2xs text-slate-500">Role:</label>
          ${isSelf ? `
            <span class="text-2xs font-bold text-slate-700 uppercase">${role}</span>
          ` : `
            <select onchange="handleRoleChange('${u.id}', this.value, '${escapeJs(u.fullName || u.email)}', this)"
              class="text-xs p-1 rounded-md border border-slate-300 bg-white font-semibold min-h-[36px]">
              <option value="volunteer" ${role === 'volunteer' ? 'selected' : ''}>Volunteer</option>
              <option value="manager" ${role === 'manager' ? 'selected' : ''}>Manager</option>
              <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
            </select>
          `}
        </div>

        <div class="flex items-center gap-1">
          <button type="button" onclick="openAssignVolunteerModal(null, '${u.id}', '${escapeJs(u.fullName || u.email)}')"
            class="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-amber-700 hover:bg-amber-800 text-white min-h-[36px] shadow-2xs">
            + Assign
          </button>
          ${!isSelf ? `
            <button type="button" onclick="openToggleDisableModal('${u.id}', '${escapeJs(u.fullName || u.email)}', ${Boolean(u.disabled)})"
              class="px-2 py-1.5 rounded-lg text-xs font-semibold border ${u.disabled ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : 'bg-stone-50 text-slate-700 border-slate-300'} min-h-[36px]">
              ${u.disabled ? 'Enable' : 'Disable'}
            </button>
            <button type="button" onclick="openDeleteBlockModal('${u.id}', '${escapeJs(u.fullName || u.email)}', '${escapeJs(u.email || '')}')"
              class="px-2 py-1.5 rounded-lg text-xs font-bold bg-rose-50 text-rose-800 border border-rose-300 min-h-[36px]">
              Delete
            </button>
          ` : ''}
        </div>
      </div>
    `;
    cardsContainer.appendChild(card);
  });
}

async function handleRoleChange(targetUserId, newRole, userName, selectEl) {
  if (!confirm(`Are you sure you want to change the role of "${userName}" to ${newRole.toUpperCase()}?`)) {
    renderCrewDirectory();
    return;
  }

  if (selectEl) selectEl.disabled = true;
  try {
    const fn = functions.httpsCallable("updateUserRole");
    await fn({ targetUserId, newRole });
  } catch (err) {
    alert("Role update failed: " + err.message);
    renderCrewDirectory();
  }
}

// ============================================================================
// MODAL: DISABLE / RE-ENABLE ACCOUNT
// ============================================================================
function openToggleDisableModal(userId, userName, currentDisabled) {
  const modal = document.getElementById("modal-toggle-disable");
  const titleEl = document.getElementById("toggle-disable-title");
  const promptEl = document.getElementById("toggle-disable-prompt");
  const targetUidInput = document.getElementById("disable-target-uid");
  const targetActionInput = document.getElementById("disable-target-action");
  const reasonWrap = document.getElementById("disable-reason-wrap");
  const alertEl = document.getElementById("toggle-disable-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (targetUidInput) targetUidInput.value = userId;

  const nextState = !currentDisabled;
  if (targetActionInput) targetActionInput.value = nextState ? "disable" : "enable";

  if (nextState) {
    if (titleEl) titleEl.innerHTML = `<svg class="w-4 h-4 text-amber-700"><use href="#icon-user-x" /></svg> Deactivate Account`;
    if (promptEl) promptEl.textContent = `Are you sure you want to deactivate the account for "${userName}"? They will be immediately signed out and unable to log in.`;
    if (reasonWrap) reasonWrap.classList.remove("hidden");
  } else {
    if (titleEl) titleEl.innerHTML = `<svg class="w-4 h-4 text-emerald-700"><use href="#icon-user-check" /></svg> Reactivate Account`;
    if (promptEl) promptEl.textContent = `Are you sure you want to reactivate the account for "${userName}"? They will regain access to register for shifts.`;
    if (reasonWrap) reasonWrap.classList.add("hidden");
  }

  if (modal) modal.classList.remove("hidden");
}

function closeToggleDisableModal() {
  const modal = document.getElementById("modal-toggle-disable");
  if (modal) modal.classList.add("hidden");
}

async function handleToggleDisableSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById("disable-target-uid")?.value;
  const action = document.getElementById("disable-target-action")?.value;
  const reason = document.getElementById("disable-reason-input")?.value?.trim() || "";
  const alertEl = document.getElementById("toggle-disable-alert");
  const submitBtn = document.getElementById("btn-submit-disable");

  if (!userId) return;

  if (submitBtn) submitBtn.disabled = true;
  try {
    const fn = functions.httpsCallable("setUserDisabledStatus");
    await fn({
      targetUserId: userId,
      disabled: action === "disable",
      reason: reason
    });
    closeToggleDisableModal();
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Error: " + err.message;
      alertEl.classList.remove("hidden");
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ============================================================================
// MODAL: DELETE & BLOCK USER (Danger Zone)
// ============================================================================
function openDeleteBlockModal(userId, userName, userEmail) {
  const modal = document.getElementById("modal-delete-block");
  const uidInput = document.getElementById("delete-block-uid");
  const emailPreview = document.getElementById("delete-block-email-preview");
  const reasonInput = document.getElementById("delete-block-reason");
  const alertEl = document.getElementById("delete-block-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (uidInput) uidInput.value = userId;
  if (emailPreview) emailPreview.textContent = userEmail || "No email";
  if (reasonInput) reasonInput.value = "";

  if (modal) modal.classList.remove("hidden");
}

function closeDeleteBlockModal() {
  const modal = document.getElementById("modal-delete-block");
  if (modal) modal.classList.add("hidden");
}

async function handleDeleteBlockSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById("delete-block-uid")?.value;
  const reason = document.getElementById("delete-block-reason")?.value?.trim();
  const alertEl = document.getElementById("delete-block-alert");
  const submitBtn = document.getElementById("btn-submit-delete-block");
  const submitText = document.getElementById("btn-delete-block-text");

  if (!userId || !reason) return;

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Releasing shifts and deleting...";

  try {
    const fn = functions.httpsCallable("deleteAndBlockUser");
    const result = await fn({ targetUserId: userId, reason });
    closeDeleteBlockModal();
    alert(`Account deleted and blocked. ${result.data?.releasedShiftsCount || 0} shift(s) were automatically released back to the schedule.`);
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Failed to delete & block user: " + err.message;
      alertEl.classList.remove("hidden");
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Release Shifts & Delete Account";
  }
}

// ============================================================================
// TAB 7: BLOCKED EMAILS MANAGEMENT
// ============================================================================
function renderBlockedEmailsTable() {
  const tbody = document.getElementById("admin-blocked-table-body");
  if (!tbody) return;

  const blockedList = Array.from(blockedEmailsMap.values());
  if (blockedList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 italic">No blocked accounts on file.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  blockedList.forEach((b) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-rose-50/30 transition text-xs";

    const dateStr = b.blockedAt ? formatTimestamp(b.blockedAt) : "Recently";

    tr.innerHTML = `
      <td class="p-3 font-mono font-bold text-rose-950">${escapeHtml(b.email)}</td>
      <td class="p-3 text-slate-700 font-medium">${escapeHtml(b.fullName || '—')}</td>
      <td class="p-3 text-slate-600 text-2xs italic">${escapeHtml(b.reason || 'Blocked by admin')}</td>
      <td class="p-3 text-slate-500 font-mono text-2xs">${dateStr}</td>
      <td class="p-3 text-slate-500 text-2xs font-mono">${escapeHtml(b.blockedByEmail || b.blockedBy || 'Admin')}</td>
      <td class="p-3 text-right">
        <button type="button" onclick="handleUnblockEmail('${escapeJs(b.email)}')"
          class="px-2.5 py-1 rounded-md text-2xs font-bold bg-white hover:bg-stone-100 text-slate-700 border border-slate-300 shadow-2xs transition">
          Unblock Email
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleUnblockEmail(email) {
  if (!confirm(`Are you sure you want to remove "${email}" from the blocked list? This will allow this email to register again.`)) {
    return;
  }

  try {
    const fn = functions.httpsCallable("unblockUserEmail");
    await fn({ email });
    alert(`Email "${email}" has been successfully unblocked.`);
  } catch (err) {
    alert("Failed to unblock email: " + err.message);
  }
}

// ============================================================================
// TAB 3: SHIFTS & COVERAGE MANAGEMENT
// ============================================================================
function renderShiftsSessionFilters() {
  const container = document.getElementById("shifts-session-filter-pills");
  if (!container) return;

  const sessions = currentFestivalConfig.sessions || [];
  container.innerHTML = `
    <button type="button" onclick="setShiftsSessionFilter('ALL')"
      class="px-3 py-1.5 rounded-full text-2xs font-bold transition whitespace-nowrap ${shiftSessionFilter === 'ALL' ? 'bg-amber-700 text-white shadow-2xs' : 'bg-stone-100 text-slate-700 hover:bg-stone-200'}">
      All Sessions
    </button>
  `;

  sessions.forEach((sess) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.onclick = () => setShiftsSessionFilter(sess.id);
    const isActive = shiftSessionFilter === sess.id;
    btn.className = `px-3 py-1.5 rounded-full text-2xs font-bold transition whitespace-nowrap ${isActive ? 'bg-amber-700 text-white shadow-2xs' : 'bg-stone-100 text-slate-700 hover:bg-stone-200'}`;
    btn.textContent = `${sess.name} (${sess.date})`;
    container.appendChild(btn);
  });
}

function setShiftsSessionFilter(sessionId) {
  shiftSessionFilter = sessionId;
  renderShiftsSessionFilters();
  renderShiftsPanel();
}

function renderShiftsPanel() {
  const grid = document.getElementById("admin-shifts-grid");
  if (!grid) return;

  let shifts = currentShiftsDocs.map((d) => ({ id: d.id, ...d.data() }));

  if (shiftSessionFilter !== "ALL") {
    shifts = shifts.filter((s) => s.sessionId === shiftSessionFilter);
  }

  if (shifts.length === 0) {
    grid.innerHTML = `<div class="col-span-full p-8 text-center text-slate-400 italic text-xs bg-stone-50 rounded-xl border border-dashed border-slate-200">No shifts configured for this session. Click "Create New Shift" above to add one.</div>`;
    return;
  }

  // Sort shifts chronologically by startTime
  shifts.sort((a, b) => getTimestampMs(a.startTime) - getTimestampMs(b.startTime));

  grid.innerHTML = "";
  shifts.forEach((shift) => {
    const card = document.createElement("div");
    card.className = "bg-white p-4 rounded-xl border border-amber-200 shadow-2xs flex flex-col justify-between space-y-3";

    const sTime = formatTime(shift.startTime);
    const eTime = formatTime(shift.endTime);
    const sDate = formatDate(shift.startTime);
    const capacity = shift.capacity || 1;
    const assigned = shift.assignedCount || 0;
    const isFull = assigned >= capacity;

    const fillPercent = Math.min(100, Math.round((assigned / capacity) * 100));

    // Find assigned volunteers from allRegistrationsDocs
    const shiftRegs = allRegistrationsDocs.filter((d) => d.data().shiftId === shift.id);

    card.innerHTML = `
      <div class="space-y-2">
        <div class="flex items-start justify-between gap-2">
          <div>
            <h4 class="font-bold text-slate-800 text-sm leading-tight">${escapeHtml(shift.categoryName || 'Shift')}</h4>
            <p class="text-2xs text-slate-500 font-mono mt-0.5">${sDate ? `${sDate} &bull; ` : ''}${sTime} &ndash; ${eTime}</p>
          </div>
          <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums shrink-0 ${isFull ? 'bg-emerald-100 text-emerald-900 border border-emerald-300' : 'bg-amber-100 text-amber-900 border border-amber-300'}">
            ${assigned} / ${capacity} Filled
          </span>
        </div>

        <!-- Progress Bar -->
        <div class="w-full bg-stone-100 h-1.5 rounded-full overflow-hidden">
          <div class="h-full ${isFull ? 'bg-emerald-600' : 'bg-amber-600'} transition-all" style="width: ${fillPercent}%"></div>
        </div>

        <!-- Manager -->
        <div class="text-2xs text-slate-600 flex items-center justify-between pt-1 border-t border-slate-100">
          <span>Shift Manager:</span>
          <span class="font-semibold text-slate-800">${escapeHtml(shift.managerName || 'Unassigned')}</span>
        </div>

        <!-- Assigned Volunteers preview -->
        <div class="text-2xs text-slate-500 space-y-1">
          <span class="font-bold text-slate-600">Volunteers (${shiftRegs.length}):</span>
          <div class="flex flex-wrap gap-1">
            ${shiftRegs.length > 0 ? shiftRegs.map((r) => {
              const u = allUsersMap.get(r.data().userId);
              const name = u?.fullName || u?.email || "Volunteer";
              return `<span class="px-1.5 py-0.5 bg-stone-100 border border-slate-200 rounded text-2xs text-slate-700">${escapeHtml(name)}</span>`;
            }).join("") : '<span class="italic text-slate-400">None assigned</span>'}
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="pt-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-1.5">
        <button type="button" onclick="openAssignVolunteerModal('${shift.id}', null, '${escapeJs(shift.categoryName)} (${sTime} - ${eTime})')"
          ${isFull ? 'disabled class="px-2.5 py-1.5 rounded-lg text-2xs font-semibold bg-stone-100 text-slate-400 border border-slate-200 cursor-not-allowed"' : 'class="px-2.5 py-1.5 rounded-lg text-2xs font-bold bg-amber-700 hover:bg-amber-800 text-white shadow-2xs transition min-h-[36px]"'}>
          + Assign Volunteer
        </button>
        <div class="flex items-center gap-1">
          <button type="button" onclick="openEditShiftModal('${shift.id}')"
            class="px-2 py-1.5 rounded-lg text-2xs font-semibold bg-white hover:bg-stone-100 text-slate-700 border border-slate-300 min-h-[36px]">
            Edit
          </button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
}

// ============================================================================
// MODAL: ASSIGN VOLUNTEER TO SHIFT
// ============================================================================
function openAssignVolunteerModal(presetShiftId, presetUserId, titleInfo) {
  const modal = document.getElementById("modal-assign-volunteer");
  const modalTitle = document.getElementById("assign-volunteer-modal-title");
  const shiftIdInput = document.getElementById("assign-vol-shift-id");
  const userIdInput = document.getElementById("assign-vol-user-id");
  const shiftDetailsBox = document.getElementById("assign-vol-shift-details");
  const userSelectWrap = document.getElementById("assign-vol-user-select-wrap");
  const shiftSelectWrap = document.getElementById("assign-vol-shift-select-wrap");
  const userSelect = document.getElementById("assign-vol-user-select");
  const shiftSelect = document.getElementById("assign-vol-shift-select");
  const alertEl = document.getElementById("assign-volunteer-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (shiftIdInput) shiftIdInput.value = presetShiftId || "";
  if (userIdInput) userIdInput.value = presetUserId || "";

  if (modalTitle) {
    modalTitle.textContent = titleInfo ? `Assign Volunteer: ${titleInfo}` : "Assign Volunteer to Shift";
  }

  // Populate Users Dropdown (active volunteers & managers)
  if (userSelect) {
    userSelect.innerHTML = `<option value="">-- Choose a Volunteer --</option>`;
    const users = Array.from(allUsersMap.values()).filter((u) => !u.disabled);
    users.sort((a, b) => (a.fullName || a.email || "").localeCompare(b.fullName || b.email || ""));
    users.forEach((u) => {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = `${u.fullName || 'Volunteer'} (${u.email || 'No email'}) - ${u.role || 'volunteer'}`;
      if (presetUserId && presetUserId === u.id) opt.selected = true;
      userSelect.appendChild(opt);
    });
  }

  // Populate Shifts Dropdown (shifts with open spots)
  if (shiftSelect) {
    shiftSelect.innerHTML = `<option value="">-- Choose an Available Shift --</option>`;
    const shifts = currentShiftsDocs.map((d) => ({ id: d.id, ...d.data() }));
    shifts.sort((a, b) => getTimestampMs(a.startTime) - getTimestampMs(b.startTime));
    shifts.forEach((s) => {
      const assigned = s.assignedCount || 0;
      const capacity = s.capacity || 1;
      const spotsLeft = Math.max(0, capacity - assigned);
      const opt = document.createElement("option");
      opt.value = s.id;
      const sTime = formatTime(s.startTime);
      const eTime = formatTime(s.endTime);
      const sDate = formatDate(s.startTime);
      opt.textContent = `${sDate ? `${sDate} ` : ''}${s.categoryName || 'Shift'} (${sTime}-${eTime}) [${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left]`;
      if (presetShiftId && presetShiftId === s.id) opt.selected = true;
      shiftSelect.appendChild(opt);
    });
  }

  // Determine which selector to show
  if (presetShiftId) {
    // Opened from shift card: Shift is fixed, pick volunteer
    if (userSelectWrap) userSelectWrap.classList.remove("hidden");
    if (shiftSelectWrap) shiftSelectWrap.classList.add("hidden");
    const shiftDoc = currentShiftsDocs.find((d) => d.id === presetShiftId);
    if (shiftDoc && shiftDetailsBox) {
      const s = shiftDoc.data();
      shiftDetailsBox.innerHTML = `
        <p class="font-bold text-amber-950">${escapeHtml(s.categoryName)}</p>
        <p class="text-2xs text-amber-900 font-mono">${formatDate(s.startTime)} &bull; ${formatTime(s.startTime)} &ndash; ${formatTime(s.endTime)}</p>
        <p class="text-2xs text-slate-600">Capacity: <span class="font-bold tabular-nums">${s.assignedCount || 0}/${s.capacity || 1}</span> filled</p>
      `;
      shiftDetailsBox.classList.remove("hidden");
    }
  } else if (presetUserId) {
    // Opened from crew directory row: Volunteer is fixed, pick shift
    if (shiftSelectWrap) shiftSelectWrap.classList.remove("hidden");
    if (userSelectWrap) userSelectWrap.classList.add("hidden");
    const u = allUsersMap.get(presetUserId);
    if (u && shiftDetailsBox) {
      shiftDetailsBox.innerHTML = `
        <p class="font-bold text-amber-950">${escapeHtml(u.fullName || 'Volunteer')}</p>
        <p class="text-2xs text-amber-900 font-mono">${escapeHtml(u.email || '')}</p>
        <p class="text-2xs text-slate-600">Role: <span class="font-bold uppercase">${escapeHtml(u.role || 'volunteer')}</span></p>
      `;
      shiftDetailsBox.classList.remove("hidden");
    }
  } else {
    // Neither fixed
    if (userSelectWrap) userSelectWrap.classList.remove("hidden");
    if (shiftSelectWrap) shiftSelectWrap.classList.remove("hidden");
    if (shiftDetailsBox) shiftDetailsBox.classList.add("hidden");
  }

  if (modal) modal.classList.remove("hidden");
}

function closeAssignVolunteerModal() {
  const modal = document.getElementById("modal-assign-volunteer");
  if (modal) modal.classList.add("hidden");
}

async function handleAssignVolunteerSubmit(e) {
  e.preventDefault();
  const alertEl = document.getElementById("assign-volunteer-alert");
  const submitBtn = document.getElementById("btn-submit-assign-vol");
  const submitText = document.getElementById("btn-submit-assign-vol-text");

  let shiftId = document.getElementById("assign-vol-shift-id")?.value;
  let targetUserId = document.getElementById("assign-vol-user-id")?.value;

  if (!shiftId) {
    shiftId = document.getElementById("assign-vol-shift-select")?.value;
  }
  if (!targetUserId) {
    targetUserId = document.getElementById("assign-vol-user-select")?.value;
  }

  if (!shiftId) {
    showModalAlert(alertEl, "Please select a shift.", false);
    return;
  }
  if (!targetUserId) {
    showModalAlert(alertEl, "Please select a volunteer to assign.", false);
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Assigning volunteer...";

  try {
    const fn = functions.httpsCallable("claimShift");
    await fn({ shiftId, targetUserId });
    closeAssignVolunteerModal();
    alert("Volunteer successfully assigned to shift!");
  } catch (err) {
    showModalAlert(alertEl, err.message || "Failed to assign volunteer.", false);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Confirm Shift Assignment";
  }
}

// ============================================================================
// TAB 2: SESSIONS & FESTIVAL CONFIGURATION
// ============================================================================
function populateFestivalConfigForm() {
  const nameInput = document.getElementById("admin-cfg-festival-name");
  const webInput = document.getElementById("admin-cfg-festival-website");
  const logoInput = document.getElementById("admin-cfg-festival-logo");
  const mgrName = document.getElementById("admin-cfg-manager-name");
  const mgrEmail = document.getElementById("admin-cfg-manager-email");
  const mgrPhone = document.getElementById("admin-cfg-manager-phone");

  if (nameInput) nameInput.value = currentFestivalConfig.festivalName || "";
  if (webInput) webInput.value = currentFestivalConfig.festivalWebsite || "";
  if (logoInput) {
    logoInput.value = currentFestivalConfig.festivalLogoUrl || "";
    previewFestivalLogo(currentFestivalConfig.festivalLogoUrl || "");
  }

  const mgr = currentFestivalConfig.volunteerManager || {};
  if (mgrName) mgrName.value = mgr.name || "";
  if (mgrEmail) mgrEmail.value = mgr.email || "";
  if (mgrPhone) mgrPhone.value = mgr.phone || "";
}

function previewFestivalLogo(url) {
  const img = document.getElementById("admin-cfg-logo-preview-img");
  const emoji = document.getElementById("admin-cfg-logo-preview-emoji");
  if (!img || !emoji) return;

  if (url && url.trim().startsWith("http")) {
    img.src = url.trim();
    img.classList.remove("hidden");
    emoji.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    emoji.classList.remove("hidden");
  }
}

function renderSessionsTable() {
  const tbody = document.getElementById("admin-sessions-table-body");
  if (!tbody) return;

  const sessions = currentFestivalConfig.sessions || [];
  if (sessions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 italic">No festival sessions configured.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  sessions.forEach((sess) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-amber-50/30 transition text-xs";

    const shiftCount = currentShiftsDocs.filter((d) => d.data().sessionId === sess.id).length;

    tr.innerHTML = `
      <td class="p-2.5 font-bold text-slate-800">${escapeHtml(sess.name)}</td>
      <td class="p-2.5 font-mono text-2xs text-slate-600">${escapeHtml(sess.date)}</td>
      <td class="p-2.5 font-mono text-2xs text-slate-700">${escapeHtml(sess.startTime)} &ndash; ${escapeHtml(sess.endTime)}</td>
      <td class="p-2.5 text-2xs text-slate-500">${escapeHtml(sess.description || '—')}</td>
      <td class="p-2.5 text-center">
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold tabular-nums ${shiftCount > 0 ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-500'}">
          ${shiftCount} shift${shiftCount === 1 ? '' : 's'}
        </span>
      </td>
      <td class="p-2.5 text-right">
        <button type="button" onclick="handleDeleteFestivalSession('${sess.id}', '${escapeJs(sess.name)}', ${shiftCount})"
          class="px-2 py-1 rounded-md text-2xs font-bold text-rose-700 hover:bg-rose-50 border border-rose-300 transition">
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleSaveFestivalConfig() {
  const name = document.getElementById("admin-cfg-festival-name")?.value?.trim() || "BrewCrew Festival";
  const web = document.getElementById("admin-cfg-festival-website")?.value?.trim() || "";
  const logo = document.getElementById("admin-cfg-festival-logo")?.value?.trim() || "";
  const mgrName = document.getElementById("admin-cfg-manager-name")?.value?.trim() || "";
  const mgrEmail = document.getElementById("admin-cfg-manager-email")?.value?.trim() || "";
  const mgrPhone = document.getElementById("admin-cfg-manager-phone")?.value?.trim() || "";
  const btn = document.getElementById("btn-save-sessions-cfg");

  if (btn) btn.disabled = true;
  try {
    await db.collection("config").doc("festival").set({
      festivalName: name,
      festivalWebsite: web,
      festivalLogoUrl: logo,
      volunteerManager: { name: mgrName, email: mgrEmail, phone: mgrPhone },
      sessions: currentFestivalConfig.sessions || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });
    alert("Festival settings saved successfully!");
  } catch (err) {
    alert("Failed to save festival configuration: " + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleAddFestivalSession() {
  const nameInput = document.getElementById("admin-new-session-name");
  const dateInput = document.getElementById("admin-new-session-date");
  const startInput = document.getElementById("admin-new-session-start");
  const endInput = document.getElementById("admin-new-session-end");
  const descInput = document.getElementById("admin-new-session-desc");

  const name = nameInput?.value?.trim();
  const date = dateInput?.value;
  const startTime = startInput?.value;
  const endTime = endInput?.value;
  const desc = descInput?.value?.trim() || "";

  if (!name || !date || !startTime || !endTime) {
    alert("Please provide Session Name, Date, Start Time, and End Time.");
    return;
  }

  const newId = "sess_" + Date.now();
  const newSession = { id: newId, name, date, startTime, endTime, description: desc };

  const updatedSessions = [...(currentFestivalConfig.sessions || []), newSession];

  try {
    await db.collection("config").doc("festival").update({
      sessions: updatedSessions,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    });
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";
  } catch (err) {
    alert("Failed to add session: " + err.message);
  }
}

async function handleDeleteFestivalSession(sessionId, sessionName, shiftCount) {
  if (shiftCount > 0) {
    alert(`Cannot delete session "${sessionName}" because ${shiftCount} shift(s) are currently assigned to it. Please delete or reassign associated shifts first.`);
    return;
  }

  if (!confirm(`Are you sure you want to delete session "${sessionName}"?`)) return;

  try {
    const fn = functions.httpsCallable("deleteFestivalSession");
    await fn({ sessionId });
  } catch (err) {
    alert("Delete session failed: " + err.message);
  }
}

// ============================================================================
// TAB 4: INCENTIVES & MILESTONE REWARDS
// ============================================================================
function populateIncentivesForm() {
  const title = document.getElementById("admin-incentive-welcome-title");
  const text = document.getElementById("admin-incentive-welcome-text");
  if (title) title.value = currentIncentivesConfig.welcomeTitle || "";
  if (text) text.value = currentIncentivesConfig.welcomeText || "";
}

function renderIncentivesTable() {
  const tbody = document.getElementById("admin-incentives-table-body");
  if (!tbody) return;

  const items = currentIncentivesConfig.items || [];
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400 italic">No milestone rewards configured.</td></tr>`;
    return;
  }

  items.sort((a, b) => (a.hours || a.hoursRequired || 0) - (b.hours || b.hoursRequired || 0));

  tbody.innerHTML = "";
  items.forEach((item, idx) => {
    const tr = document.createElement("tr");
    tr.className = "hover:bg-amber-50/30 transition text-xs";
    const hrs = item.hours || item.hoursRequired || 0;
    const name = item.name || item.rewardName || "";

    tr.innerHTML = `
      <td class="p-2.5 font-bold font-mono tabular-nums text-amber-950">${hrs} hr${hrs === 1 ? '' : 's'}</td>
      <td class="p-2.5 font-semibold text-slate-800">${escapeHtml(name)}</td>
      <td class="p-2.5 text-2xs text-slate-500">${escapeHtml(item.description || '—')}</td>
      <td class="p-2.5 text-right">
        <button type="button" onclick="handleDeleteIncentive(${idx})"
          class="px-2 py-1 rounded-md text-2xs font-bold text-rose-700 hover:bg-rose-50 border border-rose-300 transition">
          Delete
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function handleAddIncentive() {
  const hrsInput = document.getElementById("admin-new-incentive-hours");
  const nameInput = document.getElementById("admin-new-incentive-name");
  const descInput = document.getElementById("admin-new-incentive-desc");

  const hrs = parseFloat(hrsInput?.value);
  const name = nameInput?.value?.trim();
  const desc = descInput?.value?.trim() || "";

  if (isNaN(hrs) || hrs <= 0 || !name) {
    alert("Please enter a valid hours milestone and reward name.");
    return;
  }

  const newItem = {
    id: "inc_" + Date.now(),
    hours: hrs,
    hoursRequired: hrs,
    name: name,
    rewardName: name,
    description: desc
  };

  const updatedItems = [...(currentIncentivesConfig.items || []), newItem];

  try {
    await db.collection("config").doc("incentives").set({
      ...currentIncentivesConfig,
      items: updatedItems,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });
    if (hrsInput) hrsInput.value = "";
    if (nameInput) nameInput.value = "";
    if (descInput) descInput.value = "";
  } catch (err) {
    alert("Failed to add reward milestone: " + err.message);
  }
}

async function handleDeleteIncentive(index) {
  if (!confirm("Are you sure you want to remove this milestone reward?")) return;
  const items = [...(currentIncentivesConfig.items || [])];
  items.splice(index, 1);

  try {
    await db.collection("config").doc("incentives").update({
      items: items,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    });
  } catch (err) {
    alert("Failed to delete milestone: " + err.message);
  }
}

async function handleSaveIncentivesConfig() {
  const title = document.getElementById("admin-incentive-welcome-title")?.value?.trim() || "";
  const text = document.getElementById("admin-incentive-welcome-text")?.value?.trim() || "";
  const btn = document.getElementById("btn-save-incentives");

  if (btn) btn.disabled = true;
  try {
    await db.collection("config").doc("incentives").set({
      welcomeTitle: title,
      welcomeText: text,
      items: currentIncentivesConfig.items || [],
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });
    alert("Incentives configuration saved!");
  } catch (err) {
    alert("Failed to save incentives: " + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ============================================================================
// TAB 5: ROLE GUIDES & AREA BRIEFINGS
// ============================================================================
function renderRolesTable() {
  const tbody = document.getElementById("admin-roles-table-body");
  if (!tbody) return;

  const categories = [...new Set(
    currentShiftsDocs.map((d) => d.data().categoryName).filter((c) => c && typeof c === "string")
  )].sort();

  if (categories.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-400 italic">No shift areas detected. Create shifts first to configure roles.</td></tr>`;
    return;
  }

  const rolesMap = currentRolesConfig.roles || {};
  tbody.innerHTML = "";

  categories.forEach((cat) => {
    const roleData = rolesMap[cat] || {};
    const tr = document.createElement("tr");
    tr.className = "hover:bg-amber-50/30 transition text-xs";

    const hasBriefing = Boolean(roleData.description && roleData.description.length > 20);

    tr.innerHTML = `
      <td class="p-2.5 text-center text-base">${escapeHtml(roleData.icon || '🍺')}</td>
      <td class="p-2.5 font-bold text-slate-800">${escapeHtml(cat)}</td>
      <td class="p-2.5 text-2xs text-slate-600">${escapeHtml(roleData.summary || 'No summary set.')}</td>
      <td class="p-2.5 text-center">
        <span class="px-2 py-0.5 rounded-full text-2xs font-bold ${hasBriefing ? 'bg-emerald-50 text-emerald-800 border border-emerald-300' : 'bg-amber-50 text-amber-800 border border-amber-300'}">
          ${hasBriefing ? 'Detailed' : 'Brief'}
        </span>
      </td>
      <td class="p-2.5 text-right">
        <button type="button" onclick="openEditRoleModal('${escapeJs(cat)}')"
          class="px-2.5 py-1 rounded-md text-2xs font-semibold bg-white hover:bg-stone-100 text-slate-700 border border-slate-300">
          Edit Guide
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openEditRoleModal(categoryName) {
  const rolesMap = currentRolesConfig.roles || {};
  const role = rolesMap[categoryName] || {};

  const icon = prompt(`Emoji icon for "${categoryName}":`, role.icon || "🍺");
  if (icon === null) return;

  const summary = prompt(`Summary blurb for "${categoryName}" (1-2 sentences):`, role.summary || "");
  if (summary === null) return;

  saveRoleInfo(categoryName, icon, summary, role.description || "");
}

async function saveRoleInfo(categoryName, icon, summary, desc) {
  try {
    const rolesMap = { ...(currentRolesConfig.roles || {}) };
    rolesMap[categoryName] = {
      icon: (icon || "🍺").trim(),
      summary: (summary || "").trim(),
      description: desc || "",
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    };

    await db.collection("config").doc("roles").set({
      roles: rolesMap,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: currentAdminUser.uid
    }, { merge: true });

    alert(`Role guide for "${categoryName}" updated!`);
  } catch (err) {
    alert("Failed to save role info: " + err.message);
  }
}

// ============================================================================
// TAB 6: EMAIL BROADCAST
// ============================================================================
function updateBroadcastTargetLabel(target) {
  const preview = document.getElementById("admin-broadcast-recipient-preview");
  if (!preview) return;
  if (target === "manager") preview.textContent = "Target: Shift Managers Only";
  else if (target === "all") preview.textContent = "Target: All Crew (Volunteers & Managers)";
  else preview.textContent = "Target: All Volunteers";
}

async function handleSendAdminBroadcast(e) {
  e.preventDefault();
  const subject = document.getElementById("admin-broadcast-subject")?.value?.trim();
  const targetRole = document.getElementById("admin-broadcast-target")?.value || "volunteer";
  const body = document.getElementById("admin-broadcast-body")?.value?.trim();
  const alertEl = document.getElementById("admin-broadcast-alert");
  const submitBtn = document.getElementById("btn-submit-broadcast");
  const submitText = document.getElementById("btn-broadcast-text");

  if (!subject || !body) return;

  if (!confirm(`Are you sure you want to send this broadcast email to ${targetRole === 'all' ? 'all crew members' : targetRole + 's'}?`)) {
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = "Sending announcement emails...";

  try {
    const fn = functions.httpsCallable("sendAdminBroadcast");
    const result = await fn({ subject, body, targetRole });
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-emerald-50 text-emerald-800 border border-emerald-300";
      alertEl.textContent = `Broadcast sent successfully to ${result.data?.count || 0} recipient(s)!`;
      alertEl.classList.remove("hidden");
    }
  } catch (err) {
    if (alertEl) {
      alertEl.className = "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
      alertEl.textContent = "Failed to dispatch email: " + err.message;
      alertEl.classList.remove("hidden");
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = "Send Announcement Email";
  }
}

// ============================================================================
// MODAL: CREATE / EDIT SHIFT
// ============================================================================
function openCreateShiftModal() {
  const modal = document.getElementById("modal-shift-editor");
  const modalTitle = document.getElementById("shift-editor-modal-title");
  const shiftIdInput = document.getElementById("editor-shift-id");
  const sessionSelect = document.getElementById("editor-shift-session");
  const catInput = document.getElementById("editor-shift-category");
  const capInput = document.getElementById("editor-shift-capacity");
  const startInput = document.getElementById("editor-shift-start");
  const endInput = document.getElementById("editor-shift-end");
  const mgrSelect = document.getElementById("editor-shift-manager");
  const alertEl = document.getElementById("shift-editor-alert");

  if (alertEl) alertEl.classList.add("hidden");
  if (modalTitle) modalTitle.textContent = "Create New Festival Shift";
  if (shiftIdInput) shiftIdInput.value = "";
  if (catInput) catInput.value = "";
  if (capInput) capInput.value = "4";

  // Populate Sessions
  if (sessionSelect) {
    sessionSelect.innerHTML = `<option value="">-- Select Session --</option>`;
    const sessions = currentFestivalConfig.sessions || [];
    sessions.forEach((sess) => {
      const opt = document.createElement("option");
      opt.value = sess.id;
      opt.textContent = `${sess.name} (${sess.date} ${sess.startTime}-${sess.endTime})`;
      sessionSelect.appendChild(opt);
    });
  }

  // Populate Managers
  if (mgrSelect) {
    mgrSelect.innerHTML = `<option value="">-- Unassigned (No Manager) --</option>`;
    allUsersMap.forEach((u) => {
      if (u.role === "manager" || u.role === "admin") {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = `${u.fullName || 'Manager'} (${u.role})`;
        mgrSelect.appendChild(opt);
      }
    });
  }

  if (startInput) startInput.value = "";
  if (endInput) endInput.value = "";

  if (modal) modal.classList.remove("hidden");
}

function handleEditorSessionChange(sessionId) {
  const session = (currentFestivalConfig.sessions || []).find((s) => s.id === sessionId);
  if (!session) return;

  const startInput = document.getElementById("editor-shift-start");
  const endInput = document.getElementById("editor-shift-end");

  if (session.date && session.startTime && startInput) {
    startInput.value = `${session.date}T${session.startTime}`;
  }
  if (session.date && session.endTime && endInput) {
    endInput.value = `${session.date}T${session.endTime}`;
  }
}

function openEditShiftModal(shiftId) {
  const shiftDoc = currentShiftsDocs.find((d) => d.id === shiftId);
  if (!shiftDoc) return;
  const shift = shiftDoc.data();

  openCreateShiftModal();

  const modalTitle = document.getElementById("shift-editor-modal-title");
  const shiftIdInput = document.getElementById("editor-shift-id");
  const sessionSelect = document.getElementById("editor-shift-session");
  const catInput = document.getElementById("editor-shift-category");
  const capInput = document.getElementById("editor-shift-capacity");
  const startInput = document.getElementById("editor-shift-start");
  const endInput = document.getElementById("editor-shift-end");
  const mgrSelect = document.getElementById("editor-shift-manager");

  if (modalTitle) modalTitle.textContent = "Edit Festival Shift";
  if (shiftIdInput) shiftIdInput.value = shiftId;
  if (sessionSelect && shift.sessionId) sessionSelect.value = shift.sessionId;
  if (catInput) catInput.value = shift.categoryName || "";
  if (capInput) capInput.value = shift.capacity || 4;
  if (mgrSelect && shift.managerId) mgrSelect.value = shift.managerId;

  if (startInput && shift.startTime) {
    startInput.value = formatForDateTimeLocal(shift.startTime);
  }
  if (endInput && shift.endTime) {
    endInput.value = formatForDateTimeLocal(shift.endTime);
  }
}

function closeShiftEditorModal() {
  const modal = document.getElementById("modal-shift-editor");
  if (modal) modal.classList.add("hidden");
}

async function handleShiftEditorSubmit(e) {
  e.preventDefault();
  const shiftId = document.getElementById("editor-shift-id")?.value;
  const sessionId = document.getElementById("editor-shift-session")?.value;
  const categoryName = document.getElementById("editor-shift-category")?.value?.trim();
  const capacity = parseInt(document.getElementById("editor-shift-capacity")?.value, 10);
  const startTime = document.getElementById("editor-shift-start")?.value;
  const endTime = document.getElementById("editor-shift-end")?.value;
  const managerUserId = document.getElementById("editor-shift-manager")?.value || null;
  const alertEl = document.getElementById("shift-editor-alert");
  const submitBtn = document.getElementById("btn-submit-shift-editor");

  if (!sessionId || !categoryName || !capacity || !startTime || !endTime) {
    showModalAlert(alertEl, "Please fill in all mandatory fields.", false);
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  try {
    if (shiftId) {
      // Edit Shift
      const fn = functions.httpsCallable("updateShift");
      await fn({
        shiftId,
        sessionId,
        categoryName,
        capacity,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString()
      });
      if (managerUserId !== undefined) {
        const mgrFn = functions.httpsCallable("assignShiftManager");
        await mgrFn({ shiftId, managerUserId });
      }
    } else {
      // Create Shift
      const fn = functions.httpsCallable("createShift");
      await fn({
        sessionId,
        categoryName,
        capacity,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        managerUserId
      });
    }
    closeShiftEditorModal();
  } catch (err) {
    showModalAlert(alertEl, err.message || "Failed to save shift.", false);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// ============================================================================
// UTILITIES & FORMATTERS
// ============================================================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeJs(str) {
  if (!str) return "";
  return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function showModalAlert(el, message, isSuccess) {
  if (!el) return;
  el.className = isSuccess ?
    "p-3 rounded-lg text-xs bg-emerald-50 text-emerald-800 border border-emerald-300" :
    "p-3 rounded-lg text-xs bg-rose-50 text-rose-800 border border-rose-300";
  el.textContent = message;
  el.classList.remove("hidden");
}

function getTimestampMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? 0 : ms;
}

function formatTime(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDate(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function formatTimestamp(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatForDateTimeLocal(ts) {
  const ms = getTimestampMs(ts);
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Global Exports
window.switchAdminTab = switchAdminTab;
window.handleCrewSearch = handleCrewSearch;
window.setCrewRoleFilter = setCrewRoleFilter;
window.setCrewStatusFilter = setCrewStatusFilter;
window.handleCrewSortChange = handleCrewSortChange;
window.handleCrewPageSizeChange = handleCrewPageSizeChange;
window.handleRoleChange = handleRoleChange;
window.openToggleDisableModal = openToggleDisableModal;
window.closeToggleDisableModal = closeToggleDisableModal;
window.handleToggleDisableSubmit = handleToggleDisableSubmit;
window.openDeleteBlockModal = openDeleteBlockModal;
window.closeDeleteBlockModal = closeDeleteBlockModal;
window.handleDeleteBlockSubmit = handleDeleteBlockSubmit;
window.handleUnblockEmail = handleUnblockEmail;
window.setShiftsSessionFilter = setShiftsSessionFilter;
window.openAssignVolunteerModal = openAssignVolunteerModal;
window.closeAssignVolunteerModal = closeAssignVolunteerModal;
window.handleAssignVolunteerSubmit = handleAssignVolunteerSubmit;
window.openCreateShiftModal = openCreateShiftModal;
window.openEditShiftModal = openEditShiftModal;
window.closeShiftEditorModal = closeShiftEditorModal;
window.handleEditorSessionChange = handleEditorSessionChange;
window.handleShiftEditorSubmit = handleShiftEditorSubmit;
window.previewFestivalLogo = previewFestivalLogo;
window.handleSaveFestivalConfig = handleSaveFestivalConfig;
window.handleAddFestivalSession = handleAddFestivalSession;
window.handleDeleteFestivalSession = handleDeleteFestivalSession;
window.handleAddIncentive = handleAddIncentive;
window.handleDeleteIncentive = handleDeleteIncentive;
window.handleSaveIncentivesConfig = handleSaveIncentivesConfig;
window.openEditRoleModal = openEditRoleModal;
window.updateBroadcastTargetLabel = updateBroadcastTargetLabel;
window.handleSendAdminBroadcast = handleSendAdminBroadcast;
window.adminSignOut = adminSignOut;
